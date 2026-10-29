// vd clean: remove generated assets that the scenario no longer uses.
// See "Cache and assets" in docs/plans/0004-providers-and-generation.md.

import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath, stat, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  ASSET_DIRS,
  ASSETS_DIR,
  AssetCache,
  type AssetKind,
  CACHE_VERSION,
  canonicalJson,
  generationRequest,
  isCanonicalJsonError,
  scenarioItems,
} from "@vd-creator/core";
import type { Scenario } from "@vd-creator/scenario";

/** The folders under assets/ that hold generated audio. Other folders are never touched. */
export const GENERATED_ASSET_DIRS: readonly string[] = Object.values(ASSET_DIRS);

export type CleanResult = {
  /** Removed (or, in a dry run, removable) files, relative to assets/, sorted. */
  files: string[];
  /** Removed (or removable) cache keys, sorted. */
  keys: string[];
};

/**
 * Removes the files under assets/voice, assets/sfx, and assets/bgm that the scenario does not
 * use, and the cache entries of requests it no longer makes. An entry is used if an item of
 * the scenario makes the same request, from any provider, as playback does. A file is used if
 * a used entry or a scenario image names it. Only regular files directly in those folders are
 * removed: symbolic links and subfolders are left alone. Throws a `CleanRefusedError`, before
 * removing anything, if assets/ or one of those folders is a symbolic link or not a folder.
 * With `dryRun`, nothing changes and the result lists what would be removed.
 *
 * The folders are checked and every file to remove is listed before anything is removed, so a
 * refusal never follows a removal. Before each removal, the folders and the file must still be
 * the ones that were listed; otherwise it stops and throws a `CleanInterruptedError`.
 */
export async function cleanProject(
  scenario: Scenario,
  cache: AssetCache,
  options: { dryRun?: boolean } = {},
): Promise<CleanResult> {
  const wanted = new Set<string>();
  for (const item of scenarioItems(scenario)) {
    const gen = generationRequest(scenario, item);
    if (!gen) continue;
    // An invalid request cannot match any entry.
    const text = canonicalOrUndefined(gen.request);
    if (text !== undefined) wanted.add(requestId(gen.kind, text));
  }

  const keptFiles = new Set<string>(scenario.images.map((image) => image.file));
  const keys: string[] = [];
  for (const key of cache.keys().sort()) {
    const entry = cache.get(key);
    if (!entry) continue;
    const text = canonicalOrUndefined(entry.request);
    if (text !== undefined && wanted.has(requestId(entry.kind, text))) keptFiles.add(entry.file);
    else keys.push(key);
  }

  // Phase 1: check the folders and list every file to remove. Every refusal happens here.
  const folders = await snapshotFolders(cache);
  const targets: Target[] = [];
  for (const [dir, identity] of folders.kinds) {
    const folder = cache.assetPath(dir);
    const names = await readdir(folder);
    // If the folder was swapped before readdir, refuse before looking at any entry.
    await checkFolders(cache, folders);
    for (const name of names) {
      const file = `${dir}/${name}`;
      if (keptFiles.has(file)) continue;
      const stats = await lstatOrUndefined(join(folder, name));
      if (stats?.isFile()) targets.push({ file, dir, folder: identity, identity: idOf(stats) });
    }
  }
  // Also covers a dry run: the listing is only reported if no folder changed during it.
  await checkFolders(cache, folders);
  targets.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const files = targets.map((target) => target.file);
  if (options.dryRun) return { files, keys };

  // Phase 2: remove the listed files, checking each one and its folders right before.
  // Residual risk: Node has no unlinkat, so a folder swapped for a symbolic link in the instant
  // between the last check and unlink can still redirect it. That needs write access to the
  // project folder, and these checks keep the window to a few system calls.
  const project = await realpath(cache.projectDir);
  let removed = 0;
  for (const target of targets) {
    const path = cache.assetPath(target.file);
    if (!(await realpath(path).catch(() => path)).startsWith(project + sep)) {
      throw new CleanInterruptedError(removed);
    }
    // A target exists only if assets/ did, so folders.assets is set here.
    const unchanged =
      folders.assets !== undefined &&
      (await isSame(join(cache.projectDir, ASSETS_DIR), folders.assets)) &&
      (await isSame(cache.assetPath(target.dir), target.folder));
    if (!unchanged) throw new CleanInterruptedError(removed);
    const stats = await lstatOrUndefined(path);
    // A file that is already gone is not a threat, so it is skipped.
    if (!stats) continue;
    if (!stats.isFile() || !sameId(stats, target.identity)) {
      throw new CleanInterruptedError(removed);
    }
    await unlink(path);
    removed++;
  }
  if (keys.length > 0) {
    const { entries } = cache.toJSON();
    for (const key of keys) delete entries[key];
    // AssetCache has no delete, so a cache without those entries replaces cache.json.
    await new AssetCache(cache.projectDir, { version: CACHE_VERSION, entries }).save();
  }
  return { files, keys };
}

/** A device and inode number pair, which identifies a file or folder while it exists. */
type Identity = { dev: bigint; ino: bigint };

/** A file to remove, with the identities it and its folder had when it was listed. */
type Target = { file: string; dir: string; folder: Identity; identity: Identity };

/** The checked folders. `assets` is undefined if the project has no assets/ folder. */
type FolderSnapshot = {
  project: Identity;
  assets: Identity | undefined;
  kinds: Map<string, Identity>;
};

/**
 * Thrown when clean refuses to touch the assets, such as when assets/ or one of its generated
 * folders is a symbolic link. Nothing has been removed. The message is fixed text with a path
 * relative to the project.
 */
export class CleanRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanRefusedError";
  }
}

/**
 * Thrown when a folder or file changed between the listing and its removal. Clean stops at
 * once, and `removed` files were already removed. The message is fixed text.
 */
export class CleanInterruptedError extends Error {
  constructor(readonly removed: number) {
    super(
      `a folder or file under ${ASSETS_DIR} changed while cleaning; stopped after removing ${removed} ${removed === 1 ? "file" : "files"}`,
    );
    this.name = "CleanInterruptedError";
  }
}

/**
 * The identities of the project folder, assets/, and each generated folder that exists.
 * Throws a `CleanRefusedError` if assets/ or one of those folders is a symbolic link or not a
 * folder, because removing files through it could reach outside the project. A project with no
 * assets/ folder has no generated folders.
 */
async function snapshotFolders(cache: AssetCache): Promise<FolderSnapshot> {
  // The project folder itself may be reached through a link the user chose, so stat follows it.
  const project = idOf(await stat(cache.projectDir, { bigint: true }));
  const kinds = new Map<string, Identity>();
  const assets = await lstatOrUndefined(join(cache.projectDir, ASSETS_DIR));
  if (!assets) return { project, assets: undefined, kinds };
  if (!assets.isDirectory()) {
    throw new CleanRefusedError(`${ASSETS_DIR} is a symbolic link or not a folder`);
  }
  for (const dir of GENERATED_ASSET_DIRS) {
    const stats = await lstatOrUndefined(cache.assetPath(dir));
    if (!stats) continue;
    if (!stats.isDirectory()) {
      throw new CleanRefusedError(`${ASSETS_DIR}/${dir} is a symbolic link or not a folder`);
    }
    kinds.set(dir, idOf(stats));
  }
  return { project, assets: idOf(assets), kinds };
}

/** Throws a `CleanRefusedError` if a folder of the snapshot is no longer the same folder. */
async function checkFolders(cache: AssetCache, folders: FolderSnapshot): Promise<void> {
  const project = await stat(cache.projectDir, { bigint: true });
  const same =
    sameId(project, folders.project) &&
    (folders.assets === undefined ||
      (await isSame(join(cache.projectDir, ASSETS_DIR), folders.assets)));
  if (!same) throw new CleanRefusedError(`${ASSETS_DIR} changed while it was being listed`);
  for (const [dir, identity] of folders.kinds) {
    if (!(await isSame(cache.assetPath(dir), identity))) {
      throw new CleanRefusedError(`${ASSETS_DIR}/${dir} changed while it was being listed`);
    }
  }
}

/** True if `path` is still the folder with that identity, and not a link to one. */
async function isSame(path: string, identity: Identity): Promise<boolean> {
  const stats = await lstatOrUndefined(path);
  if (!stats) return false;
  return stats.isDirectory() && sameId(stats, identity);
}

function idOf(stats: BigIntStats): Identity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameId(stats: BigIntStats, identity: Identity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino;
}

function requestId(kind: AssetKind, canonicalRequest: string): string {
  return `${kind}\n${canonicalRequest}`;
}

function canonicalOrUndefined(value: unknown): string | undefined {
  try {
    return canonicalJson(value);
  } catch (e) {
    if (isCanonicalJsonError(e)) return undefined;
    throw e;
  }
}

/** The lstat of a path, or undefined if it does not exist. */
async function lstatOrUndefined(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

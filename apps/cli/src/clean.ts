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
 * refusal never follows a removal: it happens while listing or, in a dry run, in the final
 * check of the listing. Before each removal, the folders and the file must still be the ones
 * that were listed. If one changed or cannot be checked, an unlink fails, or cache.json cannot
 * be saved, it stops
 * and throws a `CleanInterruptedError` with the number of files already removed.
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

  // Phase 1: check the folders and list every file to remove. Every refusal happens here, or
  // in the final check of a dry run below, before anything is removed.
  // Every fs call on a path under assets/, in both phases, follows an `ensureUnchanged` check
  // of the recorded folders, so the first mismatch stops clean.
  // Residual risk: Node has no openat or unlinkat, so a folder swapped for a symbolic link in
  // the instant between a check and the next fs call can still redirect that one call: a
  // readdir or lstat while listing, or the unlink while removing. At most one fs call can touch
  // a swapped folder. That needs write access to the project folder.
  const folders = await snapshotFolders(cache);
  const refuse = (changed: string) =>
    new CleanRefusedError(`${changed} changed while it was being listed`);
  const targets: Target[] = [];
  for (const dir of folders.kinds.keys()) {
    const folder = cache.assetPath(dir);
    await ensureUnchanged(cache, folders, dir, undefined, refuse);
    const names = await readdir(folder);
    for (const name of names) {
      const file = `${dir}/${name}`;
      if (keptFiles.has(file)) continue;
      await ensureUnchanged(cache, folders, dir, undefined, refuse);
      const stats = await lstatOrUndefined(join(folder, name));
      if (stats?.isFile()) targets.push({ file, dir, identity: idOf(stats) });
    }
  }
  await checkProject(cache, folders);
  targets.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const files = targets.map((target) => target.file);
  if (options.dryRun) {
    // A dry run checks every listed file and folder as a real run does before each unlink. It
    // skips the realpath check, which only guards an unlink, because it removes nothing.
    for (const target of targets) await ensureUnchanged(cache, folders, target.dir, target, refuse);
    for (const dir of folders.kinds.keys()) {
      await ensureUnchanged(cache, folders, dir, undefined, refuse);
    }
    return { files, keys };
  }

  // Phase 2: remove the listed files, checking each one and its folders right before. Any
  // change, including a listed file that is gone, stops the removal at once. Only ENOENT means
  // gone: any other error from a check, such as EACCES, stops it as a CleanInterruptedError
  // with its code and the error as the cause.
  let removed = 0;
  const interrupt = () => new CleanInterruptedError(removed, "changed");
  const checked = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (e) {
      if (e instanceof CleanInterruptedError) throw e;
      if (errorCode(e) === "ENOENT") throw interrupt();
      throw new CleanInterruptedError(removed, "check", errorCode(e), e);
    }
  };
  const project = await checked(() => realpath(cache.projectDir));
  const check = (target: Target, file: Target | undefined) =>
    checked(() => ensureUnchanged(cache, folders, target.dir, file, interrupt));
  for (const target of targets) {
    const path = cache.assetPath(target.file);
    await check(target, undefined);
    if (!(await checked(() => realpath(path))).startsWith(project + sep)) throw interrupt();
    await check(target, target);
    try {
      await unlink(path);
    } catch (e) {
      throw new CleanInterruptedError(removed, "unlink", errorCode(e), e);
    }
    removed++;
  }
  if (keys.length > 0) {
    const { entries } = cache.toJSON();
    for (const key of keys) delete entries[key];
    try {
      // AssetCache has no delete, so a cache without those entries replaces cache.json.
      await new AssetCache(cache.projectDir, { version: CACHE_VERSION, entries }).save();
    } catch (e) {
      throw new CleanInterruptedError(removed, "cache", errorCode(e), e);
    }
  }
  return { files, keys };
}

/** A device and inode number pair, which identifies a file or folder while it exists. */
type Identity = { dev: bigint; ino: bigint };

/** A file to remove, in the generated folder `dir`, with the identity it had when listed. */
type Target = { file: string; dir: string; identity: Identity };

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
 * Thrown when the removal phase stops early: a folder or file changed after the listing, could
 * not be checked, an unlink failed, or cache.json could not be saved. `removed` files were
 * already removed. The message is fixed text with a file system error code, and never a path.
 * The underlying error, which can hold a path, is the `cause`.
 */
export class CleanInterruptedError extends Error {
  constructor(
    readonly removed: number,
    readonly reason: "changed" | "check" | "unlink" | "cache",
    readonly code = "error",
    cause?: unknown,
  ) {
    const count = `${removed} ${removed === 1 ? "file" : "files"}`;
    super(
      reason === "changed"
        ? `a folder or file under ${ASSETS_DIR} changed while cleaning; stopped after removing ${count}`
        : reason === "check"
          ? `could not check a folder or file under ${ASSETS_DIR} (${code}); stopped after removing ${count}`
          : reason === "unlink"
            ? `could not remove a file under ${ASSETS_DIR} (${code}); stopped after removing ${count}`
            : `removed ${count}, but could not update cache.json (${code})`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "CleanInterruptedError";
  }
}

/** The code of a file system error, such as "EACCES", or "error" for anything else. */
function errorCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : "error";
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

/** Throws a `CleanRefusedError` if the project folder is no longer the same folder. */
async function checkProject(cache: AssetCache, folders: FolderSnapshot): Promise<void> {
  if (!sameId(await stat(cache.projectDir, { bigint: true }), folders.project)) {
    throw new CleanRefusedError("the project folder changed while it was being listed");
  }
}

/**
 * Checks, in order, that assets/, its generated folder `dir`, and, if given, the listed file
 * are still the ones recorded. Throws `fail` with the path of the first that changed, relative
 * to the project. The file is looked at only after both folders passed.
 */
async function ensureUnchanged(
  cache: AssetCache,
  folders: FolderSnapshot,
  dir: string,
  target: Target | undefined,
  fail: (changed: string) => Error,
): Promise<void> {
  const kind = folders.kinds.get(dir);
  // A generated folder is recorded only if assets/ was.
  if (!folders.assets || !(await isSame(join(cache.projectDir, ASSETS_DIR), folders.assets))) {
    throw fail(ASSETS_DIR);
  }
  if (!kind || !(await isSame(cache.assetPath(dir), kind))) throw fail(`${ASSETS_DIR}/${dir}`);
  if (!target) return;
  const stats = await lstatOrUndefined(cache.assetPath(target.file));
  if (!stats?.isFile() || !sameId(stats, target.identity)) {
    throw fail(`${ASSETS_DIR}/${target.file}`);
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

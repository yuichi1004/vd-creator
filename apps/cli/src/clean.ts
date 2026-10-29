// vd clean: remove generated assets that the scenario no longer uses.
// See "Cache and assets" in docs/plans/0004-providers-and-generation.md.

import { lstat, readdir, realpath, unlink } from "node:fs/promises";
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

  // Every folder is checked before anything is removed, so a refusal removes nothing.
  const folders = await assetFolders(cache);
  const files: string[] = [];
  for (const dir of folders) {
    for (const name of await listRegularFiles(cache.assetPath(dir))) {
      const file = `${dir}/${name}`;
      if (!keptFiles.has(file)) files.push(file);
    }
  }
  files.sort();

  if (!options.dryRun) {
    const project = await realpath(cache.projectDir);
    for (const file of files) {
      const path = cache.assetPath(file);
      // Defense in depth: the file must still be a regular file inside the project.
      const stats = await lstatOrUndefined(path);
      if (!stats?.isFile()) continue;
      if (!(await realpath(path)).startsWith(project + sep)) {
        throw new CleanRefusedError(`assets/${file} is outside the project folder`);
      }
      await unlink(path);
    }
    if (keys.length > 0) {
      const { entries } = cache.toJSON();
      for (const key of keys) delete entries[key];
      // AssetCache has no delete, so a cache without those entries replaces cache.json.
      await new AssetCache(cache.projectDir, { version: CACHE_VERSION, entries }).save();
    }
  }
  return { files, keys };
}

/**
 * Thrown when clean refuses to touch the assets, such as when assets/ or one of its generated
 * folders is a symbolic link. The message is fixed text with a path relative to the project.
 */
export class CleanRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanRefusedError";
  }
}

/**
 * The generated folders that exist. Throws a `CleanRefusedError` if assets/ or one of them is
 * a symbolic link or not a folder, because removing files through it could reach outside the
 * project.
 */
async function assetFolders(cache: AssetCache): Promise<string[]> {
  const assets = await lstatOrUndefined(join(cache.projectDir, ASSETS_DIR));
  if (!assets) return [];
  if (!assets.isDirectory()) {
    throw new CleanRefusedError(`${ASSETS_DIR} is a symbolic link or not a folder`);
  }
  const folders: string[] = [];
  for (const dir of GENERATED_ASSET_DIRS) {
    const stats = await lstatOrUndefined(cache.assetPath(dir));
    if (!stats) continue;
    if (!stats.isDirectory()) {
      throw new CleanRefusedError(`${ASSETS_DIR}/${dir} is a symbolic link or not a folder`);
    }
    folders.push(dir);
  }
  return folders;
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

/** The names of the regular files directly in `dir`. Symbolic links and subfolders are skipped. */
async function listRegularFiles(dir: string): Promise<string[]> {
  const names: string[] = [];
  for (const name of await readdir(dir)) {
    if ((await lstatOrUndefined(join(dir, name)))?.isFile()) names.push(name);
  }
  return names;
}

/** The lstat of a path, or undefined if it does not exist. */
async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

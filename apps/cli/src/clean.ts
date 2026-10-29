// vd clean: remove generated assets that the scenario no longer uses.
// See "Cache and assets" in docs/plans/0004-providers-and-generation.md.

import { readdir, rm } from "node:fs/promises";
import {
  ASSET_DIRS,
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
 * a used entry or a scenario image names it. Subfolders are left alone. With `dryRun`, nothing
 * changes and the result lists what would be removed.
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

  const files: string[] = [];
  for (const dir of GENERATED_ASSET_DIRS) {
    for (const name of await listFiles(cache.assetPath(dir))) {
      const file = `${dir}/${name}`;
      if (!keptFiles.has(file)) files.push(file);
    }
  }
  files.sort();

  if (!options.dryRun) {
    for (const file of files) await rm(cache.assetPath(file), { force: true });
    if (keys.length > 0) {
      const { entries } = cache.toJSON();
      for (const key of keys) delete entries[key];
      // AssetCache has no delete, so a cache without those entries replaces cache.json.
      await new AssetCache(cache.projectDir, { version: CACHE_VERSION, entries }).save();
    }
  }
  return { files, keys };
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

/** The names of the files and links directly in `dir`, or none if it does not exist. */
async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

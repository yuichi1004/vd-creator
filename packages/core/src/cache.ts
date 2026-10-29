// The content cache, cache.json, and the asset files under assets/.
// See "Cache and assets" in docs/plans/0004-providers-and-generation.md.

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AudioFormat } from "@vd-creator/providers";
import { AssetPathSchema } from "@vd-creator/scenario";
import { ASSET_DIRS, ASSET_KEY_PREFIX_LENGTH, type AssetKind } from "./canonical.js";

/** File name of the cache inside a project folder. */
export const CACHE_FILE = "cache.json";
/** Folder of the asset files inside a project folder. */
export const ASSETS_DIR = "assets";
export const CACHE_VERSION = 1;

export type CacheEntry = {
  kind: AssetKind;
  /** Path of the asset file, relative to assets/, such as "voice/0123456789abcdef.wav". */
  file: string;
  providerId: string;
  request: Record<string, unknown>;
  durationSec: number;
  /** ISO 8601 time of generation. */
  createdAt: string;
};

/** The content of cache.json. */
export type CacheData = { version: typeof CACHE_VERSION; entries: Record<string, CacheEntry> };

/** Thrown when cache.json cannot be read as a version 1 cache. */
export class CacheFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CacheFormatError";
  }
}

/** The asset file of a cache key: `<voice|sfx|bgm>/<key prefix>.<format>`, relative to assets/. */
export function assetFileFor(kind: AssetKind, key: string, format: AudioFormat): string {
  return `${ASSET_DIRS[kind]}/${key.slice(0, ASSET_KEY_PREFIX_LENGTH)}.${format}`;
}

/**
 * The cache of one project folder. Entries are kept in memory; `save` writes cache.json.
 * Saves are serialized, so concurrent generations can each save as soon as they finish.
 */
export class AssetCache {
  readonly projectDir: string;
  #entries: Map<string, CacheEntry>;
  #saving: Promise<void> = Promise.resolve();

  constructor(projectDir: string, data?: CacheData) {
    this.projectDir = projectDir;
    this.#entries = new Map(Object.entries(data?.entries ?? {}));
  }

  /** Reads `<projectDir>/cache.json`, or returns an empty cache if the file does not exist. */
  static async load(projectDir: string): Promise<AssetCache> {
    let text: string;
    try {
      text = await readFile(join(projectDir, CACHE_FILE), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return new AssetCache(projectDir);
      throw e;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new CacheFormatError(`${CACHE_FILE} is not valid JSON`, { cause: e });
    }
    return new AssetCache(projectDir, parseCacheData(data));
  }

  get(key: string): CacheEntry | undefined {
    return this.#entries.get(key);
  }

  set(key: string, entry: CacheEntry): void {
    this.#entries.set(key, entry);
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }

  /** The absolute path of an asset file given relative to assets/. */
  assetPath(file: string): string {
    return join(this.projectDir, ASSETS_DIR, file);
  }

  /**
   * The entry of a key if its asset file exists. This is the one rule for "cached": an entry
   * whose file is missing counts as not cached, in planning, generation, and the timeline.
   */
  async cachedAsset(key: string): Promise<CacheEntry | undefined> {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    try {
      await access(this.assetPath(entry.file));
      return entry;
    } catch {
      return undefined;
    }
  }

  /** Writes an asset file atomically, creating its folder. */
  async writeAsset(file: string, data: Uint8Array): Promise<void> {
    await writeAtomic(this.assetPath(file), data);
  }

  toJSON(): CacheData {
    const entries: Record<string, CacheEntry> = {};
    for (const key of [...this.#entries.keys()].sort()) {
      entries[key] = this.#entries.get(key) as CacheEntry;
    }
    return { version: CACHE_VERSION, entries };
  }

  /** Writes `<projectDir>/cache.json` atomically, after any save already in progress. */
  save(): Promise<void> {
    const run = this.#saving.then(() =>
      writeAtomic(join(this.projectDir, CACHE_FILE), `${JSON.stringify(this.toJSON(), null, 2)}\n`),
    );
    // A failed save must not block the later ones.
    this.#saving = run.catch(() => {});
    return run;
  }
}

async function writeAtomic(target: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

const KINDS = new Set<string>(Object.keys(ASSET_DIRS));

/** Checks the shape of cache.json content. Throws a `CacheFormatError` if it is wrong. */
export function parseCacheData(data: unknown): CacheData {
  if (!isRecord(data)) throw new CacheFormatError(`${CACHE_FILE} must be a JSON object`);
  if (data.version !== CACHE_VERSION) {
    throw new CacheFormatError(
      `${CACHE_FILE} has unsupported version ${JSON.stringify(data.version)}; expected ${CACHE_VERSION}`,
    );
  }
  if (!isRecord(data.entries)) {
    throw new CacheFormatError(`${CACHE_FILE} must have an "entries" object`);
  }
  const entries: Record<string, CacheEntry> = {};
  for (const [key, entry] of Object.entries(data.entries)) {
    const where = `${CACHE_FILE} entry "${key}"`;
    if (!/^[0-9a-f]{64}$/.test(key)) throw new CacheFormatError(`${where}: invalid key`);
    if (!isRecord(entry)) throw new CacheFormatError(`${where}: must be an object`);
    const { kind, file, providerId, request, durationSec, createdAt } = entry;
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      throw new CacheFormatError(`${where}: invalid kind`);
    }
    if (typeof file !== "string" || !AssetPathSchema.safeParse(file).success) {
      throw new CacheFormatError(`${where}: invalid file`);
    }
    if (typeof providerId !== "string" || providerId === "") {
      throw new CacheFormatError(`${where}: invalid providerId`);
    }
    if (!isRecord(request)) throw new CacheFormatError(`${where}: invalid request`);
    if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec < 0) {
      throw new CacheFormatError(`${where}: invalid durationSec`);
    }
    if (typeof createdAt !== "string") throw new CacheFormatError(`${where}: invalid createdAt`);
    entries[key] = {
      kind: kind as AssetKind,
      file,
      providerId,
      request,
      durationSec,
      createdAt,
    };
  }
  return { version: CACHE_VERSION, entries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

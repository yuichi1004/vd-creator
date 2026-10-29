import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AssetCache,
  assetFileFor,
  CACHE_FILE,
  type CacheEntry,
  CacheFormatError,
  parseCacheData,
} from "./cache.js";
import { cacheKey, canonicalJson } from "./canonical.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-core-cache-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const request = { text: "Hello", voiceId: "v1", take: 0 };
const key = cacheKey("tts", "mock", request);
const entry: CacheEntry = {
  kind: "tts",
  file: assetFileFor("tts", key, "wav"),
  providerId: "mock",
  request,
  durationSec: 1.25,
  createdAt: "2026-10-29T00:00:00.000Z",
};

describe("canonicalJson and cacheKey", () => {
  test("sorts keys at every level and drops undefined values", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  test("the key is a SHA-256 that ignores key order", () => {
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey("tts", "mock", { take: 0, voiceId: "v1", text: "Hello" })).toBe(key);
  });

  test("kind, provider, text, settings, and take each change the key", () => {
    const keys = [
      key,
      cacheKey("sfx", "mock", request),
      cacheKey("tts", "elevenlabs", request),
      cacheKey("tts", "mock", { ...request, text: "Hello!" }),
      cacheKey("tts", "mock", { ...request, settings: { stability: 0.5 } }),
      cacheKey("tts", "mock", { ...request, take: 1 }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("asset files go under the kind's folder, named by the first 16 hex characters", () => {
    expect(entry.file).toBe(`voice/${key.slice(0, 16)}.wav`);
    expect(assetFileFor("sfx", key, "mp3")).toBe(`sfx/${key.slice(0, 16)}.mp3`);
    expect(assetFileFor("music", key, "wav")).toBe(`bgm/${key.slice(0, 16)}.wav`);
  });
});

describe("AssetCache", () => {
  test("a missing cache.json loads as an empty cache", async () => {
    const cache = await AssetCache.load(dir);
    expect(cache.keys()).toEqual([]);
  });

  test("saves version 1 with its entries and loads them back", async () => {
    const cache = new AssetCache(dir);
    cache.set(key, entry);
    await cache.save();
    const json = JSON.parse(await readFile(join(dir, CACHE_FILE), "utf8"));
    expect(json).toEqual({ version: 1, entries: { [key]: entry } });
    const loaded = await AssetCache.load(dir);
    expect(loaded.get(key)).toEqual(entry);
  });

  test("hasAsset needs both the entry and the file", async () => {
    const cache = new AssetCache(dir);
    expect(await cache.hasAsset(key)).toBe(false);
    cache.set(key, entry);
    expect(await cache.hasAsset(key)).toBe(false);
    await cache.writeAsset(entry.file, new Uint8Array([1, 2, 3]));
    expect(await cache.hasAsset(key)).toBe(true);
    expect(await readFile(join(dir, "assets", entry.file))).toEqual(Buffer.from([1, 2, 3]));
  });

  test("concurrent saves all complete and the last state wins", async () => {
    const cache = new AssetCache(dir);
    const saves: Promise<void>[] = [];
    for (let take = 0; take < 5; take++) {
      const req = { ...request, take };
      const k = cacheKey("tts", "mock", req);
      cache.set(k, { ...entry, request: req, file: assetFileFor("tts", k, "wav") });
      saves.push(cache.save());
    }
    await Promise.all(saves);
    expect((await AssetCache.load(dir)).keys()).toHaveLength(5);
  });

  test("findByRequest returns the newest entry, optionally for one provider", () => {
    const cache = new AssetCache(dir);
    const elevenKey = cacheKey("tts", "elevenlabs", request);
    cache.set(key, entry);
    cache.set(elevenKey, {
      ...entry,
      providerId: "elevenlabs",
      file: assetFileFor("tts", elevenKey, "mp3"),
      createdAt: "2026-10-30T00:00:00.000Z",
    });
    expect(cache.findByRequest("tts", { take: 0, text: "Hello", voiceId: "v1" })?.key).toBe(
      elevenKey,
    );
    expect(cache.findByRequest("tts", request, "mock")?.key).toBe(key);
    expect(cache.findByRequest("sfx", request)).toBeUndefined();
    expect(cache.findByRequest("tts", { ...request, take: 1 })).toBeUndefined();
  });

  test("rejects invalid JSON, other versions, and bad entries", async () => {
    await writeFile(join(dir, CACHE_FILE), "{");
    await expect(AssetCache.load(dir)).rejects.toBeInstanceOf(CacheFormatError);
    expect(() => parseCacheData({ version: 2, entries: {} })).toThrow(/version 2/);
    expect(() => parseCacheData({ version: 1 })).toThrow(CacheFormatError);
    expect(() => parseCacheData({ version: 1, entries: { nothex: entry } })).toThrow(/invalid key/);
    for (const bad of [
      { file: "../outside.wav" },
      { file: "/abs.wav" },
      { kind: "video" },
      { durationSec: -1 },
      { providerId: "" },
      { request: "text" },
    ]) {
      expect(() =>
        parseCacheData({ version: 1, entries: { [key]: { ...entry, ...bad } } }),
      ).toThrow(CacheFormatError);
    }
  });
});

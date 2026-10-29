// Canonical JSON and cache keys. See "Cache and assets" in docs/plans/0004-providers-and-generation.md.

import { createHash } from "node:crypto";

/** The kind of generation request, which picks the provider and the asset folder. */
export type AssetKind = "tts" | "sfx" | "music";

/** Folder under assets/ for each asset kind. */
export const ASSET_DIRS: Record<AssetKind, string> = { tts: "voice", sfx: "sfx", music: "bgm" };

/** Number of hex characters of the cache key used in asset file names. */
export const ASSET_KEY_PREFIX_LENGTH = 16;

/**
 * JSON with object keys sorted at every level and `undefined` values dropped, so that
 * equal requests always give the same text.
 */
export function canonicalJson(value: unknown): string {
  // The text is written directly from the sorted own keys, never copied onto a new object,
  // so keys such as "__proto__" are kept like any other key.
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The SHA-256, in hex, of the canonical JSON of `{ kind, providerId, request }`. */
export function cacheKey(kind: AssetKind, providerId: string, request: object): string {
  return createHash("sha256").update(canonicalJson({ kind, providerId, request })).digest("hex");
}

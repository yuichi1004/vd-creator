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
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** The SHA-256, in hex, of the canonical JSON of `{ kind, providerId, request }`. */
export function cacheKey(kind: AssetKind, providerId: string, request: object): string {
  return createHash("sha256").update(canonicalJson({ kind, providerId, request })).digest("hex");
}

// Canonical JSON and cache keys. See "Cache and assets" in docs/plans/0004-providers-and-generation.md.

import { createHash } from "node:crypto";

/** The kind of generation request, which picks the provider and the asset folder. */
export type AssetKind = "tts" | "sfx" | "music";

/** Folder under assets/ for each asset kind. */
export const ASSET_DIRS: Record<AssetKind, string> = { tts: "voice", sfx: "sfx", music: "bgm" };

/** Number of hex characters of the cache key used in asset file names. */
export const ASSET_KEY_PREFIX_LENGTH = 16;

/** The message of the `TypeError` that `canonicalJson` throws. It never holds the value. */
export const CANONICAL_JSON_UNSUPPORTED = "canonicalJson supports only plain JSON values";

/**
 * JSON with object keys sorted at every level, so that equal requests always give the same
 * text. Supported values are plain JSON values: null, booleans, finite numbers, strings,
 * arrays, and plain objects (whose prototype is `Object.prototype` or null). An `undefined`
 * object value is dropped and an `undefined` array element is written as null, as
 * `JSON.stringify` does. Anything else, such as a function, symbol, bigint, non-finite number,
 * or an object like a `Date` or `Map`, throws a `TypeError` with a fixed message.
 */
export function canonicalJson(value: unknown): string {
  // The text is written directly from the sorted own keys, never copied onto a new object,
  // so keys such as "__proto__" are kept like any other key.
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      throw new TypeError(CANONICAL_JSON_UNSUPPORTED);
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (Number.isFinite(value)) return JSON.stringify(value);
      break;
    default:
      if (value === null) return "null";
  }
  throw new TypeError(CANONICAL_JSON_UNSUPPORTED);
}

/** The SHA-256, in hex, of the canonical JSON of `{ kind, providerId, request }`. */
export function cacheKey(kind: AssetKind, providerId: string, request: object): string {
  return createHash("sha256").update(canonicalJson({ kind, providerId, request })).digest("hex");
}

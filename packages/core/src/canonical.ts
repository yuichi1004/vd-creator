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

/** True if `error` is the `TypeError` that `canonicalJson` throws for an unsupported value. */
export function isCanonicalJsonError(error: unknown): error is TypeError {
  return error instanceof TypeError && error.message === CANONICAL_JSON_UNSUPPORTED;
}

/**
 * JSON with object keys sorted at every level, so that equal requests always give the same
 * text. Supported values are plain JSON values: null, booleans, finite numbers, strings,
 * arrays, and plain objects (whose prototype is `Object.prototype` or null) with string keys.
 * An `undefined` object value is dropped, and an `undefined` array element or a hole in a
 * sparse array is written as null, as `JSON.stringify` does. Anything else throws a
 * `TypeError` with a fixed message: a function, symbol, bigint, or non-finite number, an
 * object like a `Date` or `Map`, an object with symbol keys, or a value that contains itself.
 */
export function canonicalJson(value: unknown): string {
  try {
    return write(value, new Set());
  } catch (e) {
    // A value nested too deeply for the stack is not supported either.
    if (e instanceof RangeError) throw new TypeError(CANONICAL_JSON_UNSUPPORTED);
    throw e;
  }
}

/** Writes `value`. `ancestors` holds the arrays and objects that contain it, to find cycles. */
function write(value: unknown, ancestors: Set<object>): string {
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) throw new TypeError(CANONICAL_JSON_UNSUPPORTED);
    ancestors.add(value);
    try {
      return Array.isArray(value) ? writeArray(value, ancestors) : writeObject(value, ancestors);
    } finally {
      ancestors.delete(value);
    }
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

function writeArray(array: readonly unknown[], ancestors: Set<object>): string {
  // Indexing, not `map`, so that holes are written as null too.
  const parts: string[] = [];
  for (let i = 0; i < array.length; i++) {
    const v = array[i];
    parts.push(v === undefined ? "null" : write(v, ancestors));
  }
  return `[${parts.join(",")}]`;
}

function writeObject(object: object, ancestors: Set<object>): string {
  const proto = Object.getPrototypeOf(object);
  if (
    (proto !== Object.prototype && proto !== null) ||
    Object.getOwnPropertySymbols(object).length > 0
  ) {
    throw new TypeError(CANONICAL_JSON_UNSUPPORTED);
  }
  // The text is written directly from the sorted own keys, never copied onto a new object,
  // so keys such as "__proto__" are kept like any other key.
  const record = object as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const v = record[key];
    if (v !== undefined) parts.push(`${JSON.stringify(key)}:${write(v, ancestors)}`);
  }
  return `{${parts.join(",")}}`;
}

/** The SHA-256, in hex, of the canonical JSON of `{ kind, providerId, request }`. */
export function cacheKey(kind: AssetKind, providerId: string, request: object): string {
  return createHash("sha256").update(canonicalJson({ kind, providerId, request })).digest("hex");
}

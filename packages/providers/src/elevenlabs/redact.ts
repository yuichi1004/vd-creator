// Keeping the API key out of errors. Everything that came from the network is untrusted, and
// anything that may hold the key is redacted before it is truncated, quoted, or escaped. A final
// guard (containsSecret) then checks everything an error exposes, in every encoding we know of.

const REDACTED = "[redacted]";
/** A key substring at least this long counts as a leak. Shorter keys are matched whole. */
export const MIN_SECRET_FRAGMENT = 8;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const STATUS_TEXT = /^[A-Za-z0-9 '-]{1,64}$/;

/** The ways a text can spell a secret: literal, percent-encoded, and JSON-escaped. */
function encodings(text: string): string[] {
  // Every UTF-16 code unit as \uXXXX, as a JSON encoder that escapes everything writes it.
  const unicode = text.split("").map(unicodeEscape).join("");
  return [
    text,
    encodeURIComponent(text),
    encodeURI(text),
    JSON.stringify(text).slice(1, -1),
    unicode,
  ];
}

function unicodeEscape(c: string): string {
  return `\\u${(c.charCodeAt(0) ?? 0).toString(16).padStart(4, "0")}`;
}

function base64Forms(text: string): string[] {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  return [base64, base64.replace(/=+$/, ""), Buffer.from(text, "utf8").toString("base64url")];
}

/** Every pattern that counts as the key showing up, lowercased for a case-insensitive match. */
function secretPatterns(key: string): string[] {
  const patterns = new Set<string>([...encodings(key), ...base64Forms(key)]);
  const chars = [...key];
  for (let i = 0; i + MIN_SECRET_FRAGMENT <= chars.length; i++) {
    for (const form of encodings(chars.slice(i, i + MIN_SECRET_FRAGMENT).join(""))) {
      patterns.add(form);
    }
  }
  return [...patterns].filter((p) => p !== "").map((p) => p.toLowerCase());
}

/** True if the text holds the key, or an 8-character piece of it, in any known form. */
export function containsSecret(text: string, key: string | undefined): boolean {
  if (!key) return false;
  const lower = text.toLowerCase();
  return secretPatterns(key).some((pattern) => lower.includes(pattern));
}

/**
 * Replaces the whole key, in its literal, percent-encoded, JSON-escaped, and base64 forms, and
 * any value that follows an xi-api-key name. Run it on source text before any truncation,
 * quoting, or escaping. What it misses, the final guard catches.
 */
export function redactSecrets(text: string, key: string | undefined, header: string): string {
  let result = text;
  if (key) {
    const forms = [...encodings(key), ...base64Forms(key)].filter((f) => f !== "");
    // Longest first, so that a form is not broken up by a shorter one inside it.
    for (const form of forms.sort((a, b) => b.length - a.length)) {
      result = replaceAllIgnoreCase(result, form, REDACTED);
    }
  }
  const headerValue = new RegExp(
    `(${escapeRegExp(header)}["']?\\s*[:=]\\s*["']?)(?!\\[redacted\\])[^\\s"',;}\\]]+`,
    "gi",
  );
  return result.replace(headerValue, `$1${REDACTED}`);
}

/** Untrusted text reduced to printable characters on one line, at most `max` characters. */
export function printable(text: string, max: number): string {
  const clean = text
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(clean, max);
}

/** A request ID from a response header, kept only if it is a plain token and not the key. */
export function safeRequestId(raw: string | null, key: string | undefined): string | undefined {
  if (raw === null || !REQUEST_ID.test(raw) || containsSecret(raw, key)) return undefined;
  return raw;
}

/** An HTTP status text, kept only if it is a short plain phrase and not the key. */
export function safeStatusText(raw: string, key: string | undefined): string | undefined {
  if (!STATUS_TEXT.test(raw) || containsSecret(raw, key)) return undefined;
  return raw;
}

export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

function replaceAllIgnoreCase(text: string, search: string, replacement: string): string {
  return text.replace(new RegExp(escapeRegExp(search), "gi"), replacement);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

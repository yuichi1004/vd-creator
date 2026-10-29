// Threat model: text from an HTTP response and anything a caught exception holds are untrusted
// and never shown. Errors are built only from our own request and from fixed templates, so
// there is no encoding of the key to look for in them. Our own inputs (text, prompt, IDs) may
// still hold the key by mistake, so the item label is redacted, and a final guard checks the
// thrown error for the key as defense in depth. It also pins the stack when a stack hook, such
// as Error.prepareStackTrace, puts the key there. Other code running inside the process is out
// of scope: it can read the environment directly.
//
// The key is sent only to the configured https host: redirects are never followed, since fetch
// would send the key header to the new location. Audio from that host is trimmed to a run of
// chained MPEG frames after an optional leading ID3v2 tag, which drops tags and trailing bytes
// from clean files and keeps the duration accurate. That trimming is not a secret boundary: it
// cannot tell trailing bytes from frame data. What keeps the key out of the asset file is a
// final guard on the bytes about to be returned, read as latin1: if they hold the key or any
// 8-character piece of it, ignoring ASCII case, the result fails with a fixed error that holds
// none of the response. An encoding of the key other than raw bytes, such as base64 or a hash, is
// out of scope: only the trusted host, which already has the key, could produce one.
//
// A key shorter than 20 characters is rejected as malformed before any request, and its error
// holds none of the input. Real keys are much longer, and with that minimum the fixed texts of
// our errors can never contain the key or the 8-character pieces the guards look for.

const REDACTED = "[redacted]";
/** A key substring at least this long counts as a leak. Shorter keys are matched whole. */
export const MIN_SECRET_FRAGMENT = 8;

/** Replaces every literal occurrence of the key. Total: it never throws, for any strings. */
export function redactKey(text: string, key: string | undefined): string {
  return key ? text.split(key).join(REDACTED) : text;
}

/** True if the text holds the key or any 8-character piece of it, ignoring case. */
export function containsSecret(text: string, key: string | undefined): boolean {
  if (!key) return false;
  const lower = text.toLowerCase();
  const lowerKey = key.toLowerCase();
  if (lowerKey.length <= MIN_SECRET_FRAGMENT) return lower.includes(lowerKey);
  for (let i = 0; i + MIN_SECRET_FRAGMENT <= lowerKey.length; i++) {
    if (lower.includes(lowerKey.slice(i, i + MIN_SECRET_FRAGMENT))) return true;
  }
  return false;
}

export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

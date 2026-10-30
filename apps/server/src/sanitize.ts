// Messages from the core checks, made safe to send: no source excerpts, no absolute paths.

import { isAbsolute, relative, sep } from "node:path";

/** A folder whose paths are shown relative to it, and its name when the folder itself shows. */
export type MessageRoot = { dir: string; name: string };

/** Stands in for an absolute path outside every root. */
export const HIDDEN_PATH = "<path>";

/** Added where a parser's source excerpt was dropped. */
const EXCERPT_DROPPED = " (details omitted; run vd validate)";

// A character that may come before a path or a root inside a longer path, such as sfx/door.
const PATH_CHAR = /[\w.~/\\]/;

// An absolute path: POSIX, home-relative, Windows, or a file URL. Not a relative path such as
// sfx/door/entry.yaml, so the character before must not belong to a path. The first group is
// a regular expression such as /^[0-9a-f]{64}$/ in a schema message, which is kept: one
// segment with a regex metacharacter, then a slash, flags, and the end of the token.
const ABSOLUTE_PATH =
  /(?<![\w.~/\\])(?:(\/(?=[^\s/]*[$^*+?{}[\]|()\\])(?:\\.|[^\s/\\])+\/[dgimsuvy]*(?=$|[\s"'`,;.)]))|file:\/\/\S*|~[/\\][^\s"'`,;()]*|[A-Za-z]:[/\\][^\s"'`,;()]*|\/[^\s"'`,;()]+)/g;

/**
 * Makes a message from the license check fit for the HTTP API. A parser's source excerpt,
 * which starts on the line after the error (as the YAML parser writes it), is dropped. Paths
 * inside a root become relative to it, and any other absolute path becomes `HIDDEN_PATH`.
 */
export function sanitizeMessage(message: string, roots: readonly MessageRoot[]): string {
  const [first = ""] = message.split(/\r?\n/, 1);
  let text = first.trimEnd();
  if (text.length < message.trimEnd().length) text = `${text.replace(/:$/, "")}${EXCERPT_DROPPED}`;
  // The longest root first, so a library inside the project shows relative to the library.
  const known = roots.filter((r) => isAbsolute(r.dir)).sort((a, b) => b.dir.length - a.dir.length);
  for (const root of known) text = replaceRoot(text, root);
  return text.replace(ABSOLUTE_PATH, (_, pattern?: string) => pattern ?? HIDDEN_PATH);
}

/** Sanitizes every string field of a license issue's target, as `sanitizeMessage` does. */
export function sanitizeTarget<T extends Record<string, unknown>>(
  target: T,
  roots: readonly MessageRoot[],
): T {
  const entries = Object.entries(target).map(([key, value]) => [
    key,
    typeof value === "string" ? sanitizeMessage(value, roots) : value,
  ]);
  return Object.fromEntries(entries) as T;
}

function replaceRoot(text: string, { dir, name }: MessageRoot): string {
  const trimmed = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  if (trimmed === "") return text;
  let out = "";
  let rest = text;
  for (let at = rest.indexOf(trimmed); at >= 0; at = rest.indexOf(trimmed)) {
    const end = at + trimmed.length;
    const before = at > 0 ? rest[at - 1] : out.at(-1);
    const next = rest[end];
    if (before !== undefined && PATH_CHAR.test(before)) {
      // The root's text inside a longer path, such as elevenlabs/tmp/p; not the root.
      out += rest.slice(0, at + 1);
      rest = rest.slice(at + 1);
    } else if (next === sep || next === "/") {
      // A path inside the root, up to the end of the path.
      const match = /^[^\s"'`,;()]*/.exec(rest.slice(end));
      const full = trimmed + (match?.[0] ?? "");
      out += rest.slice(0, at) + (relative(trimmed, full) || name);
      rest = rest.slice(end + (match?.[0].length ?? 0));
    } else if (next === undefined || !/[\w.-]/.test(next)) {
      out += rest.slice(0, at) + name;
      rest = rest.slice(end);
    } else {
      // Another folder whose name starts like the root; left to the generic rule.
      out += rest.slice(0, end);
      rest = rest.slice(end);
    }
  }
  return out + rest;
}

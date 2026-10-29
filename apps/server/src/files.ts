// Serving files from a root folder, such as the project's assets/, without leaving it.

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { AssetPathSchema } from "@vd-creator/scenario";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

/** The content type of a file name, by its extension. */
export function contentType(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The "/"-separated relative path of a URL path after its prefix, with each segment decoded,
 * or undefined if it is not a plain path inside a folder: empty segments, ".", "..", "\",
 * ":", or a segment that does not decode are all refused. `rest` is the raw URL path after
 * the prefix, so that an encoded "/" or ".." cannot slip past the router.
 */
export function relativeUrlPath(rest: string): string | undefined {
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return undefined;
    }
  }
  const path = segments.join("/");
  if (segments.some((s) => s.includes("/") || s.includes("\0"))) return undefined;
  return AssetPathSchema.safeParse(path).success ? path : undefined;
}

/**
 * Opens `rel`, a "/"-separated path checked by `relativeUrlPath`, inside `root` and returns a
 * response with its content, or undefined if it is missing, not a regular file, or resolves
 * outside the real path of `root`, for example through a symbolic link. With `sandbox`, the
 * response cannot run scripts when opened as a page, as an SVG in a project could.
 */
export async function serveFile(
  root: string,
  rel: string,
  options: { sandbox?: boolean } = {},
): Promise<Response | undefined> {
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(root);
    realFile = await realpath(join(root, ...rel.split("/")));
  } catch {
    return undefined;
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (!realFile.startsWith(prefix)) return undefined;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // The resolved path has no links; O_NOFOLLOW refuses one put there since.
    handle = await open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return undefined;
    }
    const headers: Record<string, string> = {
      "Content-Type": contentType(rel),
      "Content-Length": String(info.size),
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    if (options.sandbox) headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
    const body = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
    return new Response(body, { headers });
  } catch {
    await handle.close().catch(() => {});
    return undefined;
  }
}

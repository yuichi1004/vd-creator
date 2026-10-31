// Time-stretched copies of project assets for `GET /preview/*`. See "Time-stretched copies" in
// docs/plans/0010-settings-and-playback-speed.md.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, realpath, rename, rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, sep } from "node:path";

/** Slowest and fastest tempo, and the step between allowed tempos, in hundredths. */
const MIN_HUNDREDTHS = 50;
const MAX_HUNDREDTHS = 200;
const STEP_HUNDREDTHS = 5;

/** The ffmpeg input format of each accepted extension, forced so that ffmpeg never guesses. */
const INPUT_FORMATS: Record<string, string> = {
  ".mp3": "mp3",
  ".wav": "wav",
  ".ogg": "ogg",
  ".flac": "flac",
  ".m4a": "mov",
};

export const MAX_CACHE_BYTES = 500 * 1024 * 1024;
export const CONVERT_TIMEOUT_MS = 30_000;
export const MAX_PROCESSES = 2;
/** Sources larger than this are refused, because they are read into memory. */
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
/** Less audio than this in a converted copy is a failed conversion. */
const MIN_DATA_BYTES = 100;
/** A copy shorter than this share of the length the source predicts is a failed conversion. */
const MIN_LENGTH_SHARE = 0.5;

/**
 * Runs ffmpeg with `args` (never through a shell) and `input` on its stdin. Resolves when it
 * exits with 0, rejects on any failure or when it runs longer than `timeoutMs`. The output file
 * is named in `args`.
 */
export type FfmpegRunner = (
  args: string[],
  input: Uint8Array,
  options: { timeoutMs: number },
) => Promise<void>;

export type PreviewOptions = {
  /** Folder of the cache. Default: `vd-creator/preview/` under `$XDG_CACHE_HOME` or `~/.cache`. */
  cacheDir?: string;
  /** Default: the real ffmpeg on `PATH`. */
  runner?: FfmpegRunner;
  /** Whether ffmpeg can be used. Default: true with a `runner`, else whether `PATH` has ffmpeg. */
  available?: boolean;
  maxCacheBytes?: number;
  timeoutMs?: number;
  /** Awaited between the path check and the open of a source file. Tests swap files there. */
  beforeOpen?: () => Promise<void>;
};

/** The reasons a preview request is refused; the app turns them into fixed responses. */
export type PreviewFailure = "not-audio" | "not-found" | "failed";

/**
 * The tempo of a query value in hundredths (1.25 is 125), or undefined if it is not one of
 * 0.5 to 2.0 in steps of 0.05. Compared as text, so floating-point drift cannot let a value
 * such as 1.2500000000000001 through.
 */
export function parseTempo(value: string | undefined): number | undefined {
  const match = value === undefined ? null : /^(\d{1,2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return undefined;
  const fraction = match[2] ?? "";
  if (/[1-9]/.test(fraction.slice(2))) return undefined;
  const hundredths = Number(match[1]) * 100 + Number(fraction.slice(0, 2).padEnd(2, "0"));
  if (hundredths < MIN_HUNDREDTHS || hundredths > MAX_HUNDREDTHS) return undefined;
  return hundredths % STEP_HUNDREDTHS === 0 ? hundredths : undefined;
}

/** The input format for a file name, or undefined if it is not an accepted audio file. */
export function inputFormat(name: string): string | undefined {
  return INPUT_FORMATS[extname(name).toLowerCase()];
}

/** True if an executable named ffmpeg is in a folder of `PATH`. */
export function ffmpegOnPath(path = process.env.PATH ?? ""): boolean {
  const names = process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg.cmd"] : ["ffmpeg"];
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      try {
        accessSync(join(dir, name), fsConstants.X_OK);
        return true;
      } catch {
        // Not in this folder.
      }
    }
  }
  return false;
}

/** The default cache folder: `vd-creator/preview/` under `$XDG_CACHE_HOME` or `~/.cache`. */
export function defaultCacheDir(env = process.env): string {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
  return join(base, "vd-creator", "preview");
}

/** The real runner: ffmpeg with the input on stdin, killed after `timeoutMs`. */
export const runFfmpeg: FfmpegRunner = (args, input, { timeoutMs }) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "ignore"], shell: false });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("ffmpeg failed"));
    });
    // ffmpeg may exit before it has read everything; that shows as its exit code.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

/** Runs at most `limit` tasks at once; the rest wait in order. */
class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/**
 * The path of `rel` inside `root`, or undefined if it is missing or any part of it is a
 * symbolic link, in a folder or as the file.
 */
export async function plainPath(root: string, rel: string): Promise<string | undefined> {
  try {
    const realRoot = await realpath(root);
    const expected = join(realRoot, ...rel.split("/"));
    if ((await realpath(expected)) !== expected) return undefined;
    if (!expected.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return undefined;
    return expected;
  } catch {
    return undefined;
  }
}

type Handle = Awaited<ReturnType<typeof open>>;

/** A copy opened for serving: it stays readable even if the cache removes its file. */
export type Copy = { handle: Handle; size: number };

/** The audio bytes and the length in seconds of a PCM WAV, from its chunks. */
export function wavInfo(bytes: Uint8Array): { dataBytes: number; seconds: number } | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") return undefined;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let byteRate = 0;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "fmt " && at + 20 <= buf.length) byteRate = buf.readUInt32LE(at + 16);
    if (id === "data") {
      return byteRate > 0 ? { dataBytes: size, seconds: size / byteRate } : undefined;
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/**
 * The bytes of `rel` inside `root`, or undefined if it is not a plain file there. O_NOFOLLOW
 * covers only the last part of the path, so after the open the path is checked again and must
 * still lead to the file that was opened: a folder swapped for a link in between is refused.
 */
async function readSource(
  root: string,
  rel: string,
  beforeOpen?: () => Promise<void>,
): Promise<Buffer | undefined> {
  const expected = await plainPath(root, rel);
  if (expected === undefined) return undefined;
  try {
    await beforeOpen?.();
    const handle = await open(expected, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return undefined;
      if ((await plainPath(root, rel)) !== expected) return undefined;
      const now = await stat(expected);
      if (now.dev !== info.dev || now.ino !== info.ino) return undefined;
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Opens a file of the cache for serving, or undefined if it is gone or not a plain file. */
async function openCopy(path: string): Promise<Copy | undefined> {
  let handle: Handle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (info.isFile()) return { handle, size: info.size };
  } catch {
    // Gone or unreadable.
  }
  await handle?.close().catch(() => {});
  return undefined;
}

/** True if the converted file holds audio, and about as much as the source predicts. */
async function plausibleOutput(
  path: string,
  sourceSeconds: number | undefined,
  hundredths: number,
): Promise<boolean> {
  let handle: Handle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const head = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const info = wavInfo(head.subarray(0, bytesRead));
    if (!info || info.dataBytes < MIN_DATA_BYTES) return false;
    if (sourceSeconds === undefined) return true;
    return info.seconds >= (MIN_LENGTH_SHARE * sourceSeconds * 100) / hundredths;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The length of a WAV source in seconds, or undefined if it is not known. */
function wavSourceSeconds(source: Uint8Array): number | undefined {
  const info = wavInfo(source);
  if (!info || info.seconds <= 0) return undefined;
  return (Math.min(info.dataBytes, source.length) / info.dataBytes) * info.seconds;
}

export type Preview = {
  /** Whether stretching that keeps the pitch works. */
  keepPitch(): boolean;
  /**
   * The WAV of `rel` (inside `assetsDir`) at `hundredths`, opened for serving, made if needed.
   * The caller must serve or close the handle. Never throws: a failure is a `PreviewFailure`.
   */
  get(assetsDir: string, rel: string, hundredths: number): Promise<Copy | PreviewFailure>;
};

export function createPreview(options: PreviewOptions = {}): Preview {
  const runner = options.runner ?? runFfmpeg;
  const maxBytes = options.maxCacheBytes ?? MAX_CACHE_BYTES;
  const timeoutMs = options.timeoutMs ?? CONVERT_TIMEOUT_MS;
  const gate = new Gate(MAX_PROCESSES);
  const running = new Map<string, Promise<Copy | undefined>>();
  const available = () =>
    options.available ?? (options.runner !== undefined ? true : ffmpegOnPath());
  // Moving a copy into the cache, opening it, and pruning run one at a time, so that two
  // conversions cannot remove each other's copy before it is opened.
  let lock: Promise<unknown> = Promise.resolve();
  const locked = <T>(task: () => Promise<T>): Promise<T> => {
    const run = lock.then(task);
    lock = run.catch(() => {});
    return run;
  };

  async function convert(
    dir: string,
    name: string,
    format: string,
    source: Uint8Array,
    hundredths: number,
  ): Promise<Copy | undefined> {
    const temp = join(dir, `${name}.${randomUUID()}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "pipe",
        "-f",
        format,
        "-i",
        "pipe:0",
        "-vn",
        "-map_metadata",
        "-1",
        "-filter:a",
        `atempo=${(hundredths / 100).toFixed(2)}`,
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        "-y",
        temp,
      ];
      await gate.run(() => runner(args, source, { timeoutMs }));
      const info = await stat(temp);
      if (!info.isFile()) return undefined;
      // A file that decodes to nothing, such as an .m4a whose index is at its end, read from a
      // pipe, makes a header-only WAV. That is a failure and is never kept.
      const seconds = format === "wav" ? wavSourceSeconds(source) : undefined;
      if (!(await plausibleOutput(temp, seconds, hundredths))) return undefined;
      // Larger than the whole cache: served from the temporary file, which is removed below
      // while the open handle keeps it readable, and never kept.
      if (info.size > maxBytes) return await openCopy(temp);
      return await locked(async () => {
        await rename(temp, join(dir, name));
        const copy = await openCopy(join(dir, name));
        await prune(dir, maxBytes).catch(() => {});
        return copy;
      });
    } catch {
      return undefined;
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  return {
    keepPitch: available,

    async get(assetsDir, rel, hundredths) {
      const format = inputFormat(rel);
      if (format === undefined) return "not-audio";
      const source = await readSource(assetsDir, rel, options.beforeOpen);
      if (source === undefined) return "not-found";
      if (!available()) return "failed";
      const dir = options.cacheDir ?? defaultCacheDir();
      const digest = createHash("sha256").update(source).digest("hex");
      const name = `${digest}-${hundredths}.wav`;
      const path = join(dir, name);
      const cached = async () => {
        try {
          const now = new Date();
          await utimes(path, now, now);
        } catch {
          return undefined;
        }
        return openCopy(path);
      };
      const hit = await cached();
      if (hit) return hit;
      // Identical requests wait for one conversion, then open the copy it made.
      const pending = running.get(path);
      if (pending) {
        // The initiator owns its handle; this request opens its own.
        await pending.then(
          () => {},
          () => {},
        );
        const shared = await cached();
        if (shared) return shared;
      }
      const job = convert(dir, name, format, source, hundredths);
      running.set(path, job);
      try {
        return (await job) ?? "failed";
      } finally {
        if (running.get(path) === job) running.delete(path);
      }
    },
  };
}

/** Removes the oldest copies until the folder holds at most `maxBytes`. */
async function prune(dir: string, maxBytes: number): Promise<void> {
  const files: { path: string; size: number; time: number }[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".wav")) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.isFile()) files.push({ path, size: info.size, time: info.mtimeMs });
    } catch {
      // Removed meanwhile.
    }
  }
  let total = files.reduce((sum, f) => sum + f.size, 0);
  files.sort((a, b) => a.time - b.time);
  for (const f of files) {
    if (total <= maxBytes) break;
    await rm(f.path, { force: true });
    total -= f.size;
  }
}

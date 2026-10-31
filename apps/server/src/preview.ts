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

/** The bytes of `rel` inside `root`, or undefined if it is not a plain file there. */
async function readSource(root: string, rel: string): Promise<Buffer | undefined> {
  const expected = await plainPath(root, rel);
  if (expected === undefined) return undefined;
  try {
    const handle = await open(expected, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return undefined;
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export type Preview = {
  /** Whether stretching that keeps the pitch works. */
  keepPitch(): boolean;
  /**
   * The path of the cached WAV of `rel` (inside `assetsDir`) at `hundredths`, made if needed.
   * Never throws: a failure is a `PreviewFailure`.
   */
  get(
    assetsDir: string,
    rel: string,
    hundredths: number,
  ): Promise<{ dir: string; file: string } | PreviewFailure>;
};

export function createPreview(options: PreviewOptions = {}): Preview {
  const runner = options.runner ?? runFfmpeg;
  const maxBytes = options.maxCacheBytes ?? MAX_CACHE_BYTES;
  const timeoutMs = options.timeoutMs ?? CONVERT_TIMEOUT_MS;
  const gate = new Gate(MAX_PROCESSES);
  const running = new Map<string, Promise<boolean>>();
  const available = () =>
    options.available ?? (options.runner !== undefined ? true : ffmpegOnPath());

  async function convert(
    dir: string,
    name: string,
    format: string,
    source: Uint8Array,
    hundredths: number,
  ): Promise<boolean> {
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
      if (!info.isFile() || info.size === 0) return false;
      await rename(temp, join(dir, name));
      await prune(dir, name, maxBytes);
      return true;
    } catch {
      return false;
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  return {
    keepPitch: available,

    async get(assetsDir, rel, hundredths) {
      const format = inputFormat(rel);
      if (format === undefined) return "not-audio";
      const source = await readSource(assetsDir, rel);
      if (source === undefined) return "not-found";
      if (!available()) return "failed";
      const dir = options.cacheDir ?? defaultCacheDir();
      const digest = createHash("sha256").update(source).digest("hex");
      const name = `${digest}-${hundredths}.wav`;
      const done = { dir, file: name };
      try {
        const now = new Date();
        await utimes(join(dir, name), now, now);
        return done;
      } catch {
        // Not cached yet.
      }
      const key = join(dir, name);
      let job = running.get(key);
      if (!job) {
        job = convert(dir, name, format, source, hundredths).finally(() => running.delete(key));
        running.set(key, job);
      }
      return (await job) ? done : "failed";
    },
  };
}

/** Removes the oldest copies until the folder holds at most `maxBytes`, never `keep`. */
async function prune(dir: string, keep: string, maxBytes: number): Promise<void> {
  const files: { path: string; name: string; size: number; time: number }[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".wav")) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.isFile()) files.push({ path, name, size: info.size, time: info.mtimeMs });
    } catch {
      // Removed meanwhile.
    }
  }
  let total = files.reduce((sum, f) => sum + f.size, 0);
  files.sort((a, b) => a.time - b.time);
  for (const f of files) {
    if (total <= maxBytes) break;
    if (f.name === keep) continue;
    await rm(f.path, { force: true });
    total -= f.size;
  }
}

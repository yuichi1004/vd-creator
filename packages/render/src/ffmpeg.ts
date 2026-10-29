// Runs ffmpeg as a child process, with an argument array and never through a shell.
// See "Approach" in docs/plans/0006-rendering.md.

import { spawn } from "node:child_process";

/** At most this much of ffmpeg's stderr is kept, from the end. */
const STDERR_LIMIT = 64 * 1024;
/** At most this many stderr lines are put into an error message, from the end. */
export const FFMPEG_ERROR_LINES = 10;

/**
 * Matches a line that holds an absolute path: a POSIX path, a home path, a Windows drive
 * path, or a UNC path, at the start of the line or after a space, quote, or separator. A URL
 * such as `http://host` and a ratio such as `kb/s` do not match.
 */
const ABSOLUTE_PATH = /(?:^|[\s'"`=([,:])(?:\/(?!\/)|~\/|[A-Za-z]:[\\/]|\\\\)/;

/** Thrown when ffmpeg cannot start or exits with an error. */
export class FfmpegError extends Error {
  /** The exit code, absent if ffmpeg did not start or was stopped by a signal. */
  readonly exitCode?: number;
  /** The stderr lines in the message, without lines that hold absolute paths. */
  readonly stderr: readonly string[];

  constructor(message: string, details: { exitCode?: number; stderr?: string[] } = {}) {
    super(message);
    this.name = "FfmpegError";
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    this.stderr = details.stderr ?? [];
  }
}

export type RunFfmpegOptions = {
  /** Working folder. Relative paths in the arguments resolve against it. */
  cwd?: string;
  /** The program to run. Defaults to "ffmpeg" on PATH; tests use it to name another one. */
  command?: string;
};

/**
 * Runs ffmpeg with the arguments, without a shell. Resolves when it exits with code 0.
 * Otherwise throws an `FfmpegError` whose message ends with the last lines of ffmpeg's
 * stderr. Lines that hold an absolute path are left out, so pass relative paths and `cwd` to
 * keep the messages useful.
 */
export function runFfmpeg(args: readonly string[], options: RunFfmpegOptions = {}): Promise<void> {
  const command = options.command ?? "ffmpeg";
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      // Node's message names the command and the folder, so only the code is used.
      const reason = e.code === "ENOENT" ? `; check that ${command} is on PATH` : "";
      reject(new FfmpegError(`${command} could not be started (${e.code ?? "error"})${reason}`));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const lines = reportableStderr(stderr);
      const what =
        code === null
          ? `${command} was stopped by ${signal}`
          : `${command} exited with code ${code}`;
      const detail = lines.length > 0 ? `:\n${lines.map((l) => `  ${l}`).join("\n")}` : "";
      reject(
        new FfmpegError(`${what}${detail}`, {
          ...(code === null ? {} : { exitCode: code }),
          stderr: lines,
        }),
      );
    });
  });
}

/**
 * The last `FFMPEG_ERROR_LINES` non-empty lines of stderr that hold no absolute path. If lines
 * were left out for a path, a last line says how many.
 */
export function reportableStderr(stderr: string): string[] {
  const lines = stderr
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const kept = lines.filter((l) => !ABSOLUTE_PATH.test(l));
  const result = kept.slice(-FFMPEG_ERROR_LINES);
  const hidden = lines.length - kept.length;
  if (hidden > 0) {
    result.push(`(${hidden} ${hidden === 1 ? "line" : "lines"} with an absolute path left out)`);
  }
  return result;
}

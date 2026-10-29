// Runs ffmpeg as a child process, with an argument array and never through a shell.
// See "Approach" in docs/plans/0006-rendering.md.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";
import { errorCode, RenderError } from "./errors.js";

/** At most this much of ffmpeg's stderr is kept, from the end. */
const STDERR_LIMIT = 64 * 1024;
/** At most this many stderr lines are put into an error message, from the end. */
export const FFMPEG_ERROR_LINES = 10;

/**
 * Tokens that may start an absolute path, in any form: a `file:` URL, a double slash (a URL or
 * a POSIX `//` path), a tilde, a Windows drive, a backslash pair (UNC), or a slash or backslash
 * that does not follow a path character, as in `/tmp`, `'/tmp`, or `\Users`. A relative path
 * such as `assets/x.wav` or `./x.wav`, and a ratio such as `kb/s`, have none of them.
 */
const ABSOLUTE_PATH_TOKEN = /file:|\/\/|~|[A-Za-z]:[\\/]|\\\\|(?:^|[^A-Za-z0-9._-])[\\/]/i;

/** Thrown when ffmpeg cannot start or exits with an error. */
export class FfmpegError extends RenderError {
  /** The exit code, absent if ffmpeg did not start or was stopped by a signal. */
  readonly exitCode?: number;
  /** The stderr lines in the message, without lines that hold absolute paths. */
  readonly stderr: readonly string[];

  constructor(
    message: string,
    details: { exitCode?: number; stderr?: string[]; code?: string; cause?: unknown } = {},
  ) {
    super(message, {
      ...(details.code === undefined ? {} : { code: details.code }),
      ...(details.cause === undefined ? {} : { cause: details.cause }),
    });
    this.name = "FfmpegError";
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
    this.stderr = details.stderr ?? [];
  }
}

export type RunFfmpegOptions = {
  /**
   * Working folder, usually the project folder. Relative paths in the arguments resolve
   * against it, and in stderr it is shown as ".".
   */
  cwd?: string;
  /** The program to run. Defaults to "ffmpeg" on PATH; tests use it to name another one. */
  command?: string;
};

/**
 * Runs ffmpeg with the arguments, without a shell. Resolves when it exits with code 0.
 * Otherwise throws an `FfmpegError`. Its message names only the program, never a path or an
 * argument, and ends with the last lines of ffmpeg's stderr that hold no absolute path once
 * `cwd` is replaced with ".". Pass relative paths and `cwd` to keep the messages useful.
 */
export async function runFfmpeg(
  args: readonly string[],
  options: RunFfmpegOptions = {},
): Promise<void> {
  const command = options.command ?? "ffmpeg";
  const program = programName(command);
  const folders = options.cwd === undefined ? [] : await folderForms(options.cwd);
  return new Promise((resolvePromise, reject) => {
    let stderr = "";
    // After a cut, stderr may start inside a line, and inside a path that has lost its start.
    let cut = false;
    let child: ChildProcessByStdio<null, null, Readable>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      // For example a null byte in an argument. Node's message quotes the argument.
      const code = errorCode(e);
      reject(
        new FfmpegError(`${program} could not be started (${code ?? "error"})`, {
          ...(code ? { code } : {}),
          cause: e,
        }),
      );
      return;
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_LIMIT) {
        stderr = stderr.slice(-STDERR_LIMIT);
        cut = true;
      }
    });
    child.on("error", (e) => {
      // Node's message names the command and the folder, so only the code is used.
      const code = errorCode(e);
      const reason = code === "ENOENT" ? `; check that ${program} is on PATH` : "";
      reject(
        new FfmpegError(`${program} could not be started (${code ?? "error"})${reason}`, {
          ...(code ? { code } : {}),
          cause: e,
        }),
      );
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      // Only whole lines are checked, so the line the cut fell in is dropped.
      const whole = cut ? stderr.slice(stderr.search(/[\r\n]|$/)) : stderr;
      const lines = reportableStderr(whole, folders);
      const what =
        code === null
          ? `${program} was stopped by ${signal}`
          : `${program} exited with code ${code}`;
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

/** The file name of a command, without its folder, for messages. */
function programName(command: string): string {
  return command.split(/[\\/]/).at(-1) || "ffmpeg";
}

/** The absolute forms of a folder: as given if absolute, resolved, and its real path. */
async function folderForms(dir: string): Promise<string[]> {
  const forms = new Set<string>();
  if (isAbsolute(dir)) forms.add(dir);
  forms.add(resolve(dir));
  const real = await realpath(dir).catch(() => undefined);
  if (real) forms.add(real);
  return [...forms].map((f) => f.replace(/[\\/]+$/, "")).filter((f) => f !== "");
}

/**
 * The last `FFMPEG_ERROR_LINES` non-empty lines of stderr that are safe to show. Each of
 * `folders` is first replaced with ".". A line is then shown only if it has no token that may
 * start an absolute path, in any form. If lines were left out, a last line says how many.
 */
export function reportableStderr(stderr: string, folders: readonly string[] = []): string[] {
  // Longest first, so a folder inside another is not replaced partly.
  const patterns = [...folders]
    .sort((a, b) => b.length - a.length)
    // Matched only as a whole path, so "/srv/proj" is not replaced inside "/mnt/srv/proj".
    .map(
      (f) =>
        new RegExp(`(?<![A-Za-z0-9._~\\\\/-])${escapeRegExp(f)}(?=[\\\\/]|$|[\\s'"\`:,)\\]])`, "g"),
    );
  const lines = stderr
    .split(/\r?\n|\r/)
    .map((l) => patterns.reduce((text, p) => text.replace(p, "."), l).trim())
    .filter((l) => l !== "");
  const kept = lines.filter((l) => !ABSOLUTE_PATH_TOKEN.test(l));
  const result = kept.slice(-FFMPEG_ERROR_LINES);
  const hidden = lines.length - kept.length;
  if (hidden > 0) {
    result.push(`(${hidden} ${hidden === 1 ? "line" : "lines"} with an absolute path left out)`);
  }
  return result;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

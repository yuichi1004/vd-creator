// Runs ffmpeg as a child process, with an argument array and never through a shell.
// See "Approach" in docs/plans/0006-rendering.md.

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";
import { causeOptions, RenderError, type RenderErrorOptions } from "./errors.js";

/** At most this much of ffmpeg's stderr is kept, from the end. */
const STDERR_LIMIT = 64 * 1024;
/** At most this many stderr lines are put into an error message, from the end. */
export const FFMPEG_ERROR_LINES = 10;

/** The characters of a file name that a shown path may hold. */
const NAME = "\\p{L}\\p{M}\\p{N}._+=@#\\-";
/**
 * The path separators of this OS. On POSIX a backslash is part of a name, so
 * "/srv/proj\x.wav" is not inside "/srv/proj".
 */
const SEPARATOR = process.platform === "win32" ? "[\\\\/]" : "/";
/** A character that a path token must not follow or precede: a name, separator, or `~ %`. */
const PATH_NEIGHBOR = `${NAME}~%\\\\/`;
/** A path token must not follow a colon either, as in "file:/x" or "C:/x". */
const PATH_BEFORE = `${PATH_NEIGHBOR}:`;
/** A relative path that stderr may show as written: names joined by separators, without "..". */
const SAFE_RELATIVE_PATH = new RegExp(`^[${NAME}]+(?:${SEPARATOR}[${NAME}]+)*$`, "u");
/**
 * Escape sequences (CSI such as colors, OSC, and the rest), then every control and format
 * character. They are removed before a line is checked, so none can hide or split a path.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC and BEL is the point.
const ESCAPE_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -~]?/g;
// A tab is kept, so that SAFE_TEXT drops its line.
const CONTROL_CHARACTER = /(?!\t)[\p{Cc}\p{Cf}]/gu;
/**
 * What the rest of a line, once its verified path tokens are taken out, may hold: ASCII
 * letters, digits, space, and fixed punctuation. Every other character, such as / \\ % ~, a
 * tab, U+FFFD, or any non-ASCII look-alike of a slash, drops the line, and so does "..".
 */
const SAFE_TEXT = /^[A-Za-z0-9 .,:;()[\]=+\-_'"!?#@*<>|]*$/;

/** Thrown when ffmpeg cannot start or exits with an error. */
export class FfmpegError extends RenderError {
  /** The exit code, absent if ffmpeg did not start or was stopped by a signal. */
  readonly exitCode?: number;
  /** The stderr lines in the message, without lines that hold absolute paths. */
  readonly stderr: readonly string[];

  constructor(
    message: string,
    details: RenderErrorOptions & { exitCode?: number; stderr?: string[] } = {},
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
  /**
   * Relative paths in the arguments, such as "assets/voice/x.wav", that stderr may show as
   * written. Only names joined by "/" without ".." are used; others are ignored.
   */
  paths?: readonly string[];
  /** The program to run. Defaults to "ffmpeg" on PATH; tests use it to name another one. */
  command?: string;
};

/**
 * Runs ffmpeg with the arguments, without a shell. Resolves when it exits with code 0.
 * Otherwise throws an `FfmpegError`, whatever failed. Its message names only the program,
 * never a path or an argument, and ends with the last lines of ffmpeg's stderr that
 * `reportableStderr` lets through. Pass relative paths, `paths`, and `cwd` to keep the
 * messages useful.
 */
export async function runFfmpeg(
  args: readonly string[],
  options: RunFfmpegOptions = {},
): Promise<void> {
  const command = options.command ?? "ffmpeg";
  const program = programName(command);
  try {
    const folders = options.cwd === undefined ? [] : await folderForms(options.cwd);
    await spawnFfmpeg(command, program, args, options, {
      folders,
      paths: options.paths ?? [],
    });
  } catch (e) {
    // For example a deleted working folder, whose Node error names it.
    if (e instanceof FfmpegError) throw e;
    throw startError(program, e);
  }
}

/**
 * The error for a program that could not be started. Node's error names the command, the
 * folder, or an argument, so only its code is kept.
 */
function startError(program: string, error: unknown, onPathHint = false): FfmpegError {
  const options = causeOptions(error);
  const hint = onPathHint && options.code === "ENOENT" ? `; check that ${program} is on PATH` : "";
  const code = options.code ? ` (${options.code})` : "";
  return new FfmpegError(`${program} could not be started${code}${hint}`, options);
}

function spawnFfmpeg(
  command: string,
  program: string,
  args: readonly string[],
  options: RunFfmpegOptions,
  context: StderrContext,
): Promise<void> {
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
      // For example a null byte in an argument.
      reject(startError(program, e));
      return;
    }
    child.stderr.setEncoding("utf8");
    // A read error only loses stderr; "close" still settles the promise.
    child.stderr.on("error", () => {});
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_LIMIT) {
        stderr = stderr.slice(-STDERR_LIMIT);
        cut = true;
      }
    });
    child.on("error", (e) => {
      reject(startError(program, e, true));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      // Only whole lines are checked, so the line the cut fell in is dropped.
      const whole = cut ? stderr.slice(stderr.search(/[\r\n]|$/)) : stderr;
      let lines: string[];
      try {
        lines = reportableStderr(whole, context);
      } catch {
        // An exception in this handler would not reject the promise, so none may leave it.
        lines = ["(stderr could not be checked, so it is left out)"];
      }
      const what =
        code === null
          ? `${program} was stopped by ${signal}`
          : `${program} exited with code ${code}`;
      const detail = lines.length > 0 ? `:\n${lines.map((l) => `  ${l}`).join("\n")}` : "";
      reject(
        new FfmpegError(`${what}${detail}`, {
          ...(code === null ? {} : { exitCode: code }),
          stderr: lines,
          cause: Object.freeze(
            code === null
              ? { message: "stopped by a signal", ...(signal ? { signal } : {}) }
              : { message: "exited with an error", exitCode: code },
          ),
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

export type StderrContext = {
  /** Absolute forms of the working folder, shown as "." when a path inside it follows. */
  folders?: readonly string[];
  /** Relative paths that may be shown as written, as `RunFfmpegOptions.paths`. */
  paths?: readonly string[];
};

/**
 * The last `FFMPEG_ERROR_LINES` non-empty lines of stderr that are safe to show, by an
 * allowlist on characters. Escape sequences and control characters other than tab are removed
 * first. Then these path tokens are verified, each only as a whole token at a boundary:
 *
 * - a working-folder form followed by a path that has no ".." segment, shown as "./path";
 * - one of the given relative paths, shown as written.
 *
 * A line is shown only if, with its verified tokens taken out, it holds only the characters of
 * `SAFE_TEXT` and no "..". Every other line is left out, and a last line says how many were.
 */
export function reportableStderr(stderr: string, context: StderrContext = {}): string[] {
  const token = pathTokenPattern(context);
  const lines = stderr
    .split(/\r?\n|\r/)
    .map((l) => l.replace(ESCAPE_SEQUENCE, "").replace(CONTROL_CHARACTER, "").trim())
    .filter((l) => l !== "");
  const kept: string[] = [];
  for (const line of lines) {
    const { shown, rest } = verifyPathTokens(line, token);
    if (SAFE_TEXT.test(rest) && !rest.includes("..")) kept.push(shown);
  }
  const result = kept.slice(-FFMPEG_ERROR_LINES);
  const hidden = lines.length - kept.length;
  if (hidden > 0) {
    result.push(`(${hidden} ${hidden === 1 ? "line" : "lines"} left out that may hold a path)`);
  }
  return result;
}

/** One regex for every path token that may be verified, or undefined if there are none. */
function pathTokenPattern(context: StderrContext): RegExp | undefined {
  // Longest first, so a folder or path inside another is not matched partly.
  const longestFirst = (items: readonly string[]) =>
    [...new Set(items)].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const folders = longestFirst((context.folders ?? []).filter((f) => f !== ""));
  const paths = longestFirst(
    (context.paths ?? []).filter((p) => SAFE_RELATIVE_PATH.test(p) && !p.includes("..")),
  );
  const start = `(?<![${PATH_BEFORE}])`;
  const branches: string[] = [];
  if (folders.length > 0) {
    branches.push(
      `${start}(?<folder>${folders.join("|")})(?<tail>(?:${SEPARATOR}[${NAME}]*)*)(?![${PATH_NEIGHBOR}])`,
    );
  }
  if (paths.length > 0) {
    // A path may end a sentence, as in "Error opening input file assets/x.wav.".
    const name = NAME.replace(".", "");
    branches.push(`${start}(?<path>${paths.join("|")})(?![${name}~%\\\\/]|\\.\\S)`);
  }
  return branches.length === 0 ? undefined : new RegExp(branches.join("|"), "gu");
}

/**
 * The line as shown, with verified tokens rewritten, and the rest of the line, without them.
 * A token that fails its check stays in both, so the line is left out.
 */
function verifyPathTokens(
  line: string,
  token: RegExp | undefined,
): { shown: string; rest: string } {
  if (token === undefined) return { shown: line, rest: line };
  let shown = "";
  let rest = "";
  let last = 0;
  for (const match of line.matchAll(token)) {
    const between = line.slice(last, match.index);
    shown += between;
    rest += between;
    const verified =
      match.groups?.path ??
      (match.groups?.tail === undefined ? undefined : inProject(match.groups.tail));
    if (verified === undefined) {
      shown += match[0];
      rest += match[0];
    } else {
      shown += verified;
    }
    last = match.index + match[0].length;
  }
  shown += line.slice(last);
  rest += line.slice(last);
  return { shown, rest };
}

/** "./path" for the path after the working folder, or undefined if it may leave the folder. */
function inProject(tail: string): string | undefined {
  const names = tail.split(new RegExp(SEPARATOR)).filter((n) => n !== "" && n !== ".");
  if (names.some((n) => n.includes(".."))) return undefined;
  return names.length === 0 ? "." : `./${names.join("/")}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

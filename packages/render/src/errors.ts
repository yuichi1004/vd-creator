// The errors that leave this package. Every one is a RenderError with a fixed message that
// holds no absolute path: at most a project-relative path and an error code from a fixed list.
// No error from Node or another package ever leaves, not even as `cause`: its message, path,
// syscall, and stack may all name absolute paths. A cause, if any, is a new plain object.

/** The Node error codes that may be shown. Any other code is left out. */
export const REPORTED_ERROR_CODES = [
  "ENOENT",
  "EACCES",
  "ENOTDIR",
  "EEXIST",
  "EISDIR",
  "EMFILE",
  "ENOSPC",
  "ETIMEDOUT",
] as const;
export type ReportedErrorCode = (typeof REPORTED_ERROR_CODES)[number];

/** The cause of a RenderError: rebuilt from these fields, never the original error. */
export type RenderErrorCause = {
  readonly message: string;
  readonly code?: ReportedErrorCode;
  /** The exit code of ffmpeg. */
  readonly exitCode?: number;
  /** The signal that stopped ffmpeg, such as "SIGKILL". */
  readonly signal?: string;
};

export type RenderErrorOptions = {
  /** An error code from `REPORTED_ERROR_CODES`, if the failure has one. */
  code?: ReportedErrorCode;
  cause?: RenderErrorCause;
};

/** Thrown when a project cannot be rendered. */
export class RenderError extends Error {
  readonly code?: ReportedErrorCode;
  declare readonly cause?: RenderErrorCause;

  constructor(message: string, options: RenderErrorOptions = {}) {
    const cause = options.cause === undefined ? undefined : copyCause(options.cause);
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RenderError";
    const code = errorCode(options);
    if (code !== undefined) this.code = code;
  }
}

/** A new cause with only the allowed fields, so that no caller can attach an error object. */
function copyCause(cause: RenderErrorCause): RenderErrorCause {
  const code = errorCode(cause);
  const exitCode = Number.isInteger(cause.exitCode) ? cause.exitCode : undefined;
  const signal =
    typeof cause.signal === "string" && /^SIG[A-Z0-9]+$/.test(cause.signal)
      ? cause.signal
      : undefined;
  // The message is rebuilt too, as the given one may hold a path.
  const message =
    code !== undefined
      ? `system error ${code}`
      : exitCode !== undefined
        ? "exited with an error"
        : signal !== undefined
          ? "stopped by a signal"
          : "error";
  return Object.freeze({
    message,
    ...(code === undefined ? {} : { code }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** The error code of an error, if it is one of `REPORTED_ERROR_CODES`. */
export function errorCode(error: unknown): ReportedErrorCode | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return REPORTED_ERROR_CODES.find((c) => c === code);
}

/**
 * The code and cause options for a failure, from the original error: only its code, if that
 * is on the list. The original error itself is dropped.
 */
export function causeOptions(error: unknown): RenderErrorOptions {
  const code = errorCode(error);
  if (code === undefined) return {};
  return { code, cause: Object.freeze({ message: `system error ${code}`, code }) };
}

/**
 * A `RenderError` for a failed step, such as "Could not write out/drama.mp3", with the error
 * code of the cause appended. `what` must be a fixed text with at most a project-relative path.
 * A `RenderError` from this package is passed on as it is.
 */
export function stepError(what: string, error: unknown): RenderError {
  if (error instanceof RenderError) return error;
  const options = causeOptions(error);
  return new RenderError(options.code ? `${what} (${options.code})` : what, options);
}

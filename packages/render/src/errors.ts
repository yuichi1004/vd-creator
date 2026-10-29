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
    const given = property(options, "cause");
    const cause = given === undefined ? undefined : copyCause(given);
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RenderError";
    const code = errorCode(options);
    if (code !== undefined) this.code = code;
    // The default stack has frames with absolute paths, of this package and of its callers,
    // so only "<name>: <message>" is kept. It is read when shown, so a subclass's name is used.
    let stack: unknown;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      get: () => stack ?? `${this.name}: ${this.message}`,
      set: (value: unknown) => {
        stack = value;
      },
    });
  }
}

/** A property of a value, or undefined if it has none or reading it throws, as a getter may. */
function property(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown> | null | undefined)?.[key];
  } catch {
    return undefined;
  }
}

/** A new cause with only the allowed fields, so that no caller can attach an error object. */
function copyCause(cause: unknown): RenderErrorCause {
  const code = errorCode(cause);
  const given = property(cause, "exitCode");
  const exitCode = typeof given === "number" && Number.isInteger(given) ? given : undefined;
  const givenSignal = property(cause, "signal");
  const signal =
    typeof givenSignal === "string" && /^SIG[A-Z0-9]+$/.test(givenSignal) ? givenSignal : undefined;
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

/**
 * The error code of an error, if it is one of `REPORTED_ERROR_CODES`. An error whose code
 * cannot be read, such as one with a throwing getter, has none.
 */
export function errorCode(error: unknown): ReportedErrorCode | undefined {
  const code = property(error, "code");
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
  if (isRenderError(error)) return error;
  const options = causeOptions(error);
  return new RenderError(options.code ? `${what} (${options.code})` : what, options);
}

/** Whether a value is a `RenderError`. A Proxy whose prototype cannot be read is not one. */
function isRenderError(value: unknown): value is RenderError {
  try {
    return value instanceof RenderError;
  } catch {
    return false;
  }
}

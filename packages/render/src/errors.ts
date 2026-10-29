// The errors that leave this package. Every one is a RenderError with a fixed message that
// holds no absolute path: at most a project-relative path and a Node error code. The original
// error is kept as `cause` for debugging.

export type RenderErrorOptions = {
  /** A Node error code such as "EISDIR", if the failure has one. */
  code?: string;
  cause?: unknown;
};

/** Thrown when a project cannot be rendered. */
export class RenderError extends Error {
  readonly code?: string;

  constructor(message: string, options: RenderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RenderError";
    if (options.code !== undefined) this.code = options.code;
  }
}

/** The Node error code of an error, if it has one in the usual upper-case form. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
}

/**
 * A `RenderError` for a failed step, such as "Could not write out/drama.mp3", with the error
 * code of the cause appended. `what` must be a fixed text with at most a project-relative path.
 */
export function stepError(what: string, cause: unknown): RenderError {
  if (cause instanceof RenderError) return cause;
  const code = errorCode(cause);
  return new RenderError(code ? `${what} (${code})` : what, {
    ...(code ? { code } : {}),
    cause,
  });
}

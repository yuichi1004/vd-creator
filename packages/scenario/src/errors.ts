import { formatPath, type Issue } from "./validate.js";

/** Thrown by `saveScenario` when the document has errors. */
export class ScenarioValidationError extends Error {
  readonly issues: Issue[];

  constructor(issues: Issue[]) {
    const errors = issues.filter((i) => i.severity === "error");
    super(
      `Refusing to save an invalid scenario: ${errors
        .map((i) => `${formatPath(i.path)}: ${i.message}`)
        .join("; ")}`,
    );
    this.name = "ScenarioValidationError";
    this.issues = issues;
  }
}

/** Thrown by `updateItem` and `ScenarioDocument.setText` when they refuse an edit. The document is left unchanged. */
export class ScenarioEditError extends Error {
  readonly issues: Issue[];

  constructor(message: string, issues: Issue[] = [{ path: [], message, severity: "error" }]) {
    super(message);
    this.name = "ScenarioEditError";
    this.issues = issues;
  }
}

/** Body of a 422 response for a refused edit or save. */
export interface ScenarioErrorBody {
  error: "ScenarioEditError" | "ScenarioValidationError";
  message: string;
  issues: (Issue & { location: string })[];
}

/**
 * Maps a `ScenarioEditError` or `ScenarioValidationError` to a 422 response with the
 * issue paths. Returns undefined for any other error, which the caller should treat as
 * a server error.
 */
export function scenarioErrorResponse(
  error: unknown,
): { status: 422; body: ScenarioErrorBody } | undefined {
  if (!(error instanceof ScenarioEditError || error instanceof ScenarioValidationError)) {
    return undefined;
  }
  return {
    status: 422,
    body: {
      error: error instanceof ScenarioEditError ? "ScenarioEditError" : "ScenarioValidationError",
      message: error.message,
      issues: error.issues.map((i) => ({ ...i, location: formatPath(i.path) })),
    },
  };
}

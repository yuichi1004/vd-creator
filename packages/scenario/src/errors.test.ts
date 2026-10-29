import { describe, expect, test } from "vitest";
import {
  type Issue,
  ScenarioDocument,
  ScenarioEditError,
  ScenarioValidationError,
  scenarioErrorResponse,
  updateItem,
} from "./index.js";

describe("scenarioErrorResponse", () => {
  test("maps a refused edit to 422 with issue paths", () => {
    const doc = new ScenarioDocument(
      "version: 1\ntitle: T\nscenes:\n  - id: s\n    items:\n      - { pause: 1, id: p }\n",
    );
    let error: unknown;
    try {
      updateItem(doc, "p", { id: "s" });
    } catch (e) {
      error = e;
    }
    expect(scenarioErrorResponse(error)).toEqual({
      status: 422,
      body: {
        error: "ScenarioEditError",
        message: expect.stringContaining("already used"),
        issues: [
          expect.objectContaining({
            path: ["scenes", 0, "items", 0, "id"],
            location: "scenes.0.items.0.id",
            severity: "error",
          }),
        ],
      },
    });
  });

  test("maps a validation error to 422", () => {
    const error = new ScenarioValidationError([
      { path: ["title"], message: "Required", severity: "error" },
    ]);
    expect(scenarioErrorResponse(error)?.body).toMatchObject({
      error: "ScenarioValidationError",
      issues: [{ path: ["title"], location: "title", message: "Required" }],
    });
  });

  test("selects only path, message, severity, and location from each issue", () => {
    const issue = { path: ["title"], message: "Required", severity: "error", secret: "x" };
    const error = new ScenarioEditError("refused", [issue as Issue]);
    expect(scenarioErrorResponse(error)?.body.issues).toStrictEqual([
      { path: ["title"], message: "Required", severity: "error", location: "title" },
    ]);
  });

  test("leaves other errors to the caller", () => {
    expect(scenarioErrorResponse(new Error("boom"))).toBeUndefined();
    expect(scenarioErrorResponse("boom")).toBeUndefined();
    expect(scenarioErrorResponse(new ScenarioEditError("x"))?.status).toBe(422);
  });
});

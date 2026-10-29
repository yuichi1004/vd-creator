import { afterEach, describe, expect, test, vi } from "vitest";
import { CST } from "yaml";
import { ScenarioDocument, ScenarioEditError, updateItem } from "./index.js";

// Simulates editor bugs by corrupting the stringified CST, to prove that updateItem
// re-parses and validates its output before changing the document.
vi.mock("yaml", async (importOriginal) => {
  const yaml = await importOriginal<typeof import("yaml")>();
  return { ...yaml, CST: { ...yaml.CST, stringify: vi.fn(yaml.CST.stringify) } };
});

const stringify = vi.mocked(CST.stringify);
const realStringify = stringify.getMockImplementation() ?? stringify;

const TEXT =
  "version: 1\ntitle: T\nspeakers: [{ id: a, name: A, voice: { provider: mock, voiceId: v } }]\n" +
  "scenes:\n  - id: s\n    items:\n      - line: hi\n        id: l\n        speaker: a\n";

// Applies `corrupt` to the output of the edit.
function corruptOutput(corrupt: (text: string) => string): void {
  stringify.mockImplementation((token) => corrupt(realStringify(token)));
}

afterEach(() => {
  stringify.mockImplementation(realStringify);
});

describe("updateItem output guard", () => {
  test("refuses output that is not valid YAML", () => {
    corruptOutput((text) => text.replace("take: 1", "take: [1"));
    const doc = new ScenarioDocument(TEXT);
    expect(() => updateItem(doc, "l", { take: 1 })).toThrow(/breaks the YAML/);
    expect(doc.text).toBe(TEXT);
  });

  test("refuses output where the item does not read back as patched", () => {
    corruptOutput((text) => text.replace("take: 1", "take: 2"));
    const doc = new ScenarioDocument(TEXT);
    expect(() => updateItem(doc, "l", { take: 1 })).toThrow(
      /would not read back as patched: .*"take" would read back as 2 instead of 1/,
    );
    expect(doc.text).toBe(TEXT);
  });

  test("refuses output that makes a valid scenario invalid", () => {
    // The item reads back as patched, but its speaker no longer exists.
    corruptOutput((text) => text.replace("[{ id: a,", "[{ id: b,"));
    const doc = new ScenarioDocument(TEXT);
    let error: unknown;
    try {
      updateItem(doc, "l", { take: 1 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ScenarioEditError);
    expect((error as ScenarioEditError).message).toMatch(/makes the scenario invalid: .*speaker/);
    expect((error as ScenarioEditError).issues).toContainEqual(
      expect.objectContaining({ path: ["scenes", 0, "items", 0, "speaker"] }),
    );
    expect(doc.text).toBe(TEXT);
  });

  test("accepts uncorrupted output", () => {
    const doc = new ScenarioDocument(TEXT);
    updateItem(doc, "l", { take: 1 });
    expect(doc.text).toContain("        take: 1\n");
  });
});

describe("updateItem error boundary", () => {
  test("turns an unexpected error into a ScenarioEditError without its text", () => {
    const cause = new RangeError("internal detail");
    stringify.mockImplementation(() => {
      throw cause;
    });
    const doc = new ScenarioDocument(TEXT);
    let error: unknown;
    try {
      updateItem(doc, "l", { take: 1 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ScenarioEditError);
    const edit = error as ScenarioEditError;
    expect(edit.issues).toEqual([
      {
        path: ["scenes", 0, "items", 0],
        message: 'Item "l" uses YAML features that the editor does not support',
        severity: "error",
      },
    ]);
    expect(edit.message).not.toContain("internal detail");
    expect(edit.cause).toBe(cause);
    expect(doc.text).toBe(TEXT);
  });
});

import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadScenario,
  parseScenario,
  SCENARIO_FILE,
  ScenarioDocument,
  ScenarioEditError,
  ScenarioValidationError,
  saveScenario,
  updateItem,
} from "./index.js";

const samplePath = new URL("../fixtures/sample.yaml", import.meta.url);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-scenario-"));
  await copyFile(samplePath, join(dir, SCENARIO_FILE));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Returns the [before, after] pairs of lines that differ. Both texts must have the same
// number of lines.
function changedLines(before: string, after: string): [string, string][] {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b).toHaveLength(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i] ?? ""]]));
}

describe("loadScenario and saveScenario", () => {
  test("load the sample", async () => {
    const { scenario, issues, doc } = await loadScenario(dir);
    expect(issues).toEqual([]);
    expect(scenario?.title).toBe("The Lighthouse Keeper");
    expect(doc.text).toBe(await readFile(samplePath, "utf8"));
  });

  test("save without edits writes the same bytes", async () => {
    const original = await readFile(join(dir, SCENARIO_FILE), "utf8");
    const { doc } = await loadScenario(dir);
    await saveScenario(dir, doc);
    expect(await readFile(join(dir, SCENARIO_FILE), "utf8")).toBe(original);
  });

  test("load fails when the file is missing", async () => {
    await expect(loadScenario(join(dir, "missing"))).rejects.toThrow();
  });

  test("save refuses an invalid scenario and keeps the file", async () => {
    const original = await readFile(join(dir, SCENARIO_FILE), "utf8");
    const { doc } = await loadScenario(dir);
    doc.setText(
      doc.text.replace("        id: s1-l1\n        speaker: mira\n", "        id: s1-l1\n"),
    );
    await expect(saveScenario(dir, doc)).rejects.toThrow(ScenarioValidationError);
    await expect(saveScenario(dir, doc)).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ["scenes", 0, "items", 3, "speaker"] })],
    });
    expect(await readFile(join(dir, SCENARIO_FILE), "utf8")).toBe(original);
    expect(await readdir(dir)).toEqual([SCENARIO_FILE]);
  });

  test("save refuses malformed YAML and keeps the file", async () => {
    const original = await readFile(join(dir, SCENARIO_FILE), "utf8");
    await expect(saveScenario(dir, new ScenarioDocument("title: [unclosed\n"))).rejects.toThrow(
      ScenarioValidationError,
    );
    expect(await readFile(join(dir, SCENARIO_FILE), "utf8")).toBe(original);
  });

  test("concurrent saves do not collide on temp files", async () => {
    const { doc } = await loadScenario(dir);
    await Promise.all(Array.from({ length: 20 }, () => saveScenario(dir, doc)));
    expect(await readFile(join(dir, SCENARIO_FILE), "utf8")).toBe(doc.text);
    expect(await readdir(dir)).toEqual([SCENARIO_FILE]);
  });
});

describe("ScenarioDocument.validate", () => {
  test("reports an unresolved alias as an issue", () => {
    const { scenario, issues } = parseScenario("version: 1\ntitle: *missing\nscenes: []\n");
    expect(scenario).toBeUndefined();
    expect(issues.some((i) => i.severity === "error")).toBe(true);
  });

  test("reports too many alias expansions as an issue", () => {
    const lines = ["a0: &a0 [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 8; i++) {
      lines.push(
        `a${i}: &a${i} [${Array(10)
          .fill(`*a${i - 1}`)
          .join(", ")}]`,
      );
    }
    const { scenario, issues } = parseScenario(`${lines.join("\n")}\n`);
    expect(scenario).toBeUndefined();
    expect(issues).toContainEqual(
      expect.objectContaining({ message: expect.stringMatching(/alias/i), severity: "error" }),
    );
  });
});

describe("updateItem", () => {
  test("keeps comments and changes only the edited line", async () => {
    const original = await readFile(join(dir, SCENARIO_FILE), "utf8");
    const { doc } = await loadScenario(dir);
    updateItem(doc, "s1-l1", { line: "Hello? Is anyone there?" });
    await saveScenario(dir, doc);

    const saved = await readFile(join(dir, SCENARIO_FILE), "utf8");
    expect(changedLines(original, saved)).toEqual([
      ['      - line: "Is anyone up there?"', '      - line: "Hello? Is anyone there?"'],
    ]);
    expect(saved).toContain("# TODO: less shouty?");
    expect(saved).toContain("# An entry in the shared library");
    const { scenario, issues } = await loadScenario(dir);
    expect(issues).toEqual([]);
    expect(scenario?.scenes[0]?.items[3]).toMatchObject({ line: "Hello? Is anyone there?" });
  });

  test("keeps a trailing comment on the edited line", async () => {
    const { doc } = await loadScenario(dir);
    const before = doc.text;
    updateItem(doc, "s1-l1", { direction: "whispering" });
    expect(changedLines(before, doc.text)).toEqual([
      [
        '        direction: "shouting against the wind" # TODO: less shouty?',
        '        direction: "whispering" # TODO: less shouty?',
      ],
    ]);
  });

  test("sets several fields, including numbers and a library reference", async () => {
    const { doc } = await loadScenario(dir);
    const before = doc.text;
    updateItem(doc, "s1-waves", { take: undefined, durationSec: 6, sfx: { library: "waves-01" } });
    expect(changedLines(before, doc.text)).toEqual([
      [
        '      - sfx: "waves on rocks" # A string is a prompt: the sound is generated',
        "      - sfx: { library: waves-01 } # A string is a prompt: the sound is generated",
      ],
      ["        durationSec: 4", "        durationSec: 6"],
    ]);
    expect(doc.validate().issues).toEqual([]);
  });

  test("adds a missing key after the item's last key", async () => {
    const { doc } = await loadScenario(dir);
    updateItem(doc, "s1-door", { take: 1 });
    expect(doc.text).toContain(
      [
        "      - sfx: { library: door-creak-wood-01 } # An entry in the shared library",
        "        id: s1-door",
        "        take: 1",
        "      - line:",
      ].join("\n"),
    );
    const { scenario, issues } = doc.validate();
    expect(issues).toEqual([]);
    expect(scenario?.scenes[0]?.items[2]).toMatchObject({ id: "s1-door", take: 1 });
  });

  test("adds a key to the last item of the file", async () => {
    const { doc } = await loadScenario(dir);
    updateItem(doc, "s2-p1", { gapBeforeSec: 0.5 });
    expect(doc.text.endsWith("        id: s2-p1\n        gapBeforeSec: 0.5\n")).toBe(true);
    expect(doc.validate().issues).toEqual([]);
  });

  test("removes a key with its line", async () => {
    const { doc } = await loadScenario(dir);
    const before = doc.text;
    updateItem(doc, "s1-l2", { take: undefined });
    expect(doc.text).toBe(before.replace("        take: 2\n", ""));
    expect(doc.validate().scenario?.scenes[0]?.items[5]).toMatchObject({ take: 0 });
  });

  test("renames an item and keeps following it", async () => {
    const { doc } = await loadScenario(dir);
    updateItem(doc, "s1-l2", { id: "s1-ellipsis", take: 3 });
    expect(doc.validate().scenario?.scenes[0]?.items[5]).toMatchObject({
      id: "s1-ellipsis",
      take: 3,
    });
  });

  test("leaves the text alone when the value is unchanged", async () => {
    const { doc } = await loadScenario(dir);
    const before = doc.text;
    updateItem(doc, "s1-waves", { durationSec: 4 });
    expect(doc.text).toBe(before);
  });

  test("writes multi-line text as a quoted string", () => {
    const doc = new ScenarioDocument(
      "version: 1\ntitle: T\nscenes:\n  - id: s\n    items:\n      - pause: 1\n        id: p\n",
    );
    updateItem(doc, "p", { pause: 2 });
    expect(doc.text).toContain("      - pause: 2\n");
    const lines = new ScenarioDocument(
      "version: 1\ntitle: T\nspeakers: [{ id: a, name: A, voice: { provider: mock, voiceId: v } }]\nscenes:\n  - id: s\n    items:\n      - line: hi\n        id: l\n        speaker: a\n",
    );
    updateItem(lines, "l", { line: "one\ntwo" });
    expect(lines.text).toContain('      - line: "one\\ntwo"\n');
    expect(lines.validate().scenario?.scenes[0]?.items[0]).toMatchObject({ line: "one\ntwo" });
  });

  test("rewrites a flow map item", () => {
    const doc = new ScenarioDocument(
      "version: 1\ntitle: T\nscenes:\n  - id: s\n    items:\n      - { pause: 1, id: p } # short\n",
    );
    updateItem(doc, "p", { pause: 2.5 });
    expect(doc.text).toBe(
      "version: 1\ntitle: T\nscenes:\n  - id: s\n    items:\n      - { pause: 2.5, id: p } # short\n",
    );
  });

  test("throws for an unknown id", async () => {
    const { doc } = await loadScenario(dir);
    expect(() => updateItem(doc, "nope", { take: 1 })).toThrow(/No item with id "nope"/);
  });

  test("refuses to remove the kind key or the id", async () => {
    const { doc } = await loadScenario(dir);
    const before = doc.text;
    expect(() => updateItem(doc, "s1-l1", { line: undefined })).toThrow(/Cannot remove/);
    expect(() => updateItem(doc, "s1-l1", { id: undefined })).toThrow(/Cannot remove/);
    expect(doc.text).toBe(before);
  });

  test("refuses a patch that makes a valid scenario invalid", async () => {
    const { doc } = await loadScenario(dir);
    const before = doc.text;
    for (const patch of [{ speaker: "nobody" }, { speaker: undefined }, { take: -1 }]) {
      expect(() => updateItem(doc, "s1-l1", patch)).toThrow(ScenarioEditError);
    }
    try {
      updateItem(doc, "s1-l1", { speaker: "nobody" });
    } catch (e) {
      expect((e as ScenarioEditError).issues).toContainEqual(
        expect.objectContaining({ path: ["scenes", 0, "items", 3, "speaker"] }),
      );
    }
    expect(doc.text).toBe(before);
  });

  test("allows edits to a scenario that is already invalid", () => {
    const doc = new ScenarioDocument(
      "version: 1\ntitle: T\nscenes:\n  - id: s\n    items:\n      - { line: hi, id: l, speaker: nobody }\n",
    );
    updateItem(doc, "l", { line: "hello" });
    expect(doc.text).toContain("line: hello");
  });
});

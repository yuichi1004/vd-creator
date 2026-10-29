import { describe, expect, test } from "vitest";
import { type ItemPatch, ScenarioDocument, updateItem } from "./index.js";

// Edge-case inputs are raw strings, so that the formatter does not normalize them.
const HEAD = [
  "version: 1",
  "title: T",
  "speakers:",
  "  - id: a",
  "    name: A",
  "    voice: { provider: mock, voiceId: v }",
  "scenes:",
  "  - id: s",
  "    items:",
  "",
].join("\n");

function scenario(items: string): ScenarioDocument {
  return new ScenarioDocument(HEAD + items);
}

// Applies the patch, checks that the result is a valid scenario, and returns the items.
function edit(items: string, id: string, patch: ItemPatch) {
  const doc = scenario(items);
  updateItem(doc, id, patch);
  const { scenario: parsed, issues } = doc.validate();
  expect(issues).toEqual([]);
  return { doc, items: parsed?.scenes[0]?.items ?? [] };
}

describe("block scalars", () => {
  test("literal scalar followed by another key", () => {
    const { doc, items } = edit(
      "      - line: |\n          first\n          second\n        id: l\n        speaker: a\n",
      "l",
      { line: "new" },
    );
    expect(items[0]).toMatchObject({ line: "new", id: "l", speaker: "a" });
    expect(doc.text).toBe(
      `${HEAD}      - line: |-\n          new\n        id: l\n        speaker: a\n`,
    );
  });

  test("folded scalar followed by another key", () => {
    const { doc, items } = edit(
      "      - line: >-\n          some folded\n          text\n        id: l\n        speaker: a\n",
      "l",
      { line: "other text" },
    );
    expect(items[0]).toMatchObject({ line: "other text", id: "l" });
    expect(doc.text).toContain("      - line: >-\n");
  });

  test("block scalar replaced by a number keeps the next key", () => {
    const { items } = edit(
      "      - pause: |\n          1\n        id: p\n      - pause: 2\n",
      "p",
      { pause: 3 },
    );
    expect(items[0]).toMatchObject({ pause: 3, id: "p" });
  });

  test("block scalar at the end of the file keeps its header comment", () => {
    for (const end of ["\n", ""]) {
      const { doc, items } = edit(
        `      - id: l\n        speaker: a\n        line: | # header comment\n          old${end}`,
        "l",
        { line: "new\n" },
      );
      expect(items[0]).toMatchObject({ line: "new\n" });
      expect(doc.text).toContain("        line: | # header comment\n          new\n");
    }
  });

  test("block scalar keeps its style and header comment", () => {
    const { doc, items } = edit(
      "      - line: | # keep\n          old\n        id: l\n        speaker: a\n",
      "l",
      { line: "single line" },
    );
    expect(items[0]).toMatchObject({ line: "single line" });
    expect(doc.text).toBe(
      `${HEAD}      - line: |- # keep\n          single line\n        id: l\n        speaker: a\n`,
    );
  });

  test("block scalar replaced by a number keeps its comment", () => {
    const { doc } = edit("      - pause: | # keep\n          1\n        id: p\n", "p", {
      pause: 2,
    });
    expect(doc.text).toBe(`${HEAD}      - pause: 2 # keep\n        id: p\n`);
  });
});

describe("block mappings", () => {
  const sfx = "      - sfx:\n          library: door-01 # lib\n        id: x\n        take: 1\n";

  test("library mapping gets a new entry and keeps its comment", () => {
    const { doc, items } = edit(sfx, "x", { sfx: { library: "door-02" } });
    expect(items[0]).toMatchObject({ sfx: { library: "door-02" }, id: "x", take: 1 });
    expect(doc.text).toBe(HEAD + sfx.replace("door-01", "door-02"));
  });

  test("library mapping replaced by a prompt", () => {
    const { doc, items } = edit(sfx, "x", { sfx: "creaking door" });
    expect(items[0]).toMatchObject({ sfx: "creaking door", id: "x", take: 1 });
    expect(doc.text).toBe(`${HEAD}      - sfx: creaking door\n        id: x\n        take: 1\n`);
  });

  test("prompt replaced by a library reference", () => {
    const { doc, items } = edit('      - sfx: "waves" # c\n        id: x\n', "x", {
      sfx: { library: "waves-01" },
    });
    expect(items[0]).toMatchObject({ sfx: { library: "waves-01" } });
    expect(doc.text).toBe(`${HEAD}      - sfx: { library: waves-01 } # c\n        id: x\n`);
  });

  test("removes the first key of an item", () => {
    const { doc } = edit(
      "      - direction: soft\n        line: hi\n        id: l\n        speaker: a\n",
      "l",
      { direction: undefined },
    );
    expect(doc.text).toBe(`${HEAD}      - line: hi\n        id: l\n        speaker: a\n`);
  });

  test("adds a key to the last item when the file has no final newline", () => {
    const { doc } = edit("      - pause: 1\n        id: p", "p", { gapBeforeSec: 0.5 });
    expect(doc.text).toBe(`${HEAD}      - pause: 1\n        id: p\n        gapBeforeSec: 0.5\n`);
  });
});

describe("flow mappings", () => {
  const flow = "      - { pause: 1, # note\n          id: p }\n";

  test("a no-op edit keeps the text, including comments", () => {
    const { doc } = edit(flow, "p", { pause: 1 });
    expect(doc.text).toBe(HEAD + flow);
  });

  test("changing a value keeps comments inside the flow map", () => {
    const { doc } = edit(flow, "p", { pause: 2.5 });
    expect(doc.text).toBe(HEAD + flow.replace("pause: 1", "pause: 2.5"));
  });

  test("adding and removing keys keeps comments inside the flow map", () => {
    const { doc, items } = edit(flow, "p", { gapBeforeSec: 0.5 });
    expect(items[0]).toMatchObject({ pause: 1, id: "p", gapBeforeSec: 0.5 });
    expect(doc.text).toBe(
      `${HEAD}      - { pause: 1, # note\n          id: p, gapBeforeSec: 0.5 }\n`,
    );
    updateItem(doc, "p", { gapBeforeSec: undefined });
    expect(doc.text).toBe(HEAD + flow);
  });

  test("a nested flow map is edited in place", () => {
    const { doc } = edit("      - { sfx: { library: a }, id: x } # c\n", "x", {
      sfx: { library: "b" },
    });
    expect(doc.text).toBe(`${HEAD}      - { sfx: { library: b }, id: x } # c\n`);
  });
});

describe("targets and atomicity", () => {
  const two =
    "      - line: one\n        id: first\n        speaker: a\n" +
    "      - id: second\n        line: two\n        speaker: a\n";

  test("rejects renaming to an id that another item uses", () => {
    const doc = scenario(two);
    expect(() => updateItem(doc, "second", { id: "first", line: "WRONG TARGET" })).toThrow(
      /already used/,
    );
    expect(doc.text).toBe(HEAD + two);
  });

  test("rejects renaming to a scene id", () => {
    const doc = scenario(two);
    expect(() => updateItem(doc, "second", { id: "s" })).toThrow(/already used/);
  });

  test("renames only the target item", () => {
    const { items } = edit(two, "second", { id: "third", line: "changed" });
    expect(items[0]).toMatchObject({ id: "first", line: "one" });
    expect(items[1]).toMatchObject({ id: "third", line: "changed" });
  });

  test("applies nothing when a later field fails", () => {
    const doc = scenario(two);
    expect(() => updateItem(doc, "second", { take: 5, line: undefined })).toThrow(/Cannot remove/);
    expect(doc.text).toBe(HEAD + two);
  });
});

describe("strings", () => {
  test("strings that would read as other types are quoted", () => {
    const { doc, items } = edit("      - line: hi\n        id: l\n        speaker: a\n", "l", {
      direction: "true",
    });
    expect(items[0]).toMatchObject({ direction: "true" });
    expect(doc.text).toContain('direction: "true"\n');
  });
});

describe("line endings", () => {
  test("inserted fields use CRLF in a CRLF file", () => {
    const items = "      - line: |\n          old\n        id: l\n        speaker: a\n";
    const doc = new ScenarioDocument((HEAD + items).replace(/\n/g, "\r\n"));
    updateItem(doc, "l", { take: 2, line: "new\nlines" });
    expect(doc.text).not.toMatch(/(^|[^\r])\n/);
    expect(doc.text).toContain("        speaker: a\r\n        take: 2\r\n");
    expect(doc.validate().scenario?.scenes[0]?.items[0]).toMatchObject({
      line: "new\nlines",
      take: 2,
    });
  });
});

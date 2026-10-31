import { describe, expect, test } from "vitest";
import { type ItemPatch, ScenarioDocument, updateItem } from "./index.js";

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

const ITEM = [
  "      - line: Hi # keep this",
  "        id: l",
  "        speaker: a",
  "        voice:",
  "          settings:",
  "            stability: 0.3 # and this",
  "            style: 0.2",
  "",
].join("\n");

function edit(items: string, patch: ItemPatch) {
  const doc = new ScenarioDocument(HEAD + items);
  updateItem(doc, "l", patch);
  const { scenario, issues } = doc.validate();
  expect(issues).toEqual([]);
  return { doc, item: scenario?.scenes[0]?.items[0] };
}

describe("line voice settings in updateItem", () => {
  test("sets one key of the nested map and keeps comments", () => {
    const { doc, item } = edit(ITEM, { voice: { settings: { stability: 0.3, style: 0.6 } } });
    expect(item).toMatchObject({ voice: { settings: { stability: 0.3, style: 0.6 } } });
    expect(doc.text).toContain("# keep this");
    expect(doc.text).toContain("stability: 0.3 # and this");
    expect(doc.text).toContain("style: 0.6");
  });

  test("removes one key of the nested map and keeps comments", () => {
    const { doc, item } = edit(ITEM, { voice: { settings: { stability: 0.3 } } });
    expect(item).toMatchObject({ voice: { settings: { stability: 0.3 } } });
    expect(doc.text).not.toContain("style");
    expect(doc.text).toContain("# keep this");
    expect(doc.text).toContain("stability: 0.3 # and this");
  });

  test("adds voice to a line that has none, and removes it again", () => {
    const plain = "      - line: Hi # keep this\n        id: l\n        speaker: a\n";
    const { doc, item } = edit(plain, { voice: { settings: { style: 0.5 } } });
    expect(item).toMatchObject({ voice: { settings: { style: 0.5 } } });
    updateItem(doc, "l", { voice: undefined });
    expect(doc.text).toBe(HEAD + plain);
  });
});

describe("line voice settings in validation", () => {
  test("values must be plain JSON, like speaker settings", () => {
    const doc = new ScenarioDocument(
      `${HEAD}      - { id: l, speaker: a, line: Hi, voice: { settings: { style: .nan } } }\n`,
    );
    const paths = doc.validate().issues.map((i) => i.path);
    expect(paths).toContainEqual(["scenes", 0, "items", 0, "voice", "settings", "style"]);
  });

  test("other keys under voice are errors", () => {
    const doc = new ScenarioDocument(
      `${HEAD}      - { id: l, speaker: a, line: Hi, voice: { voiceId: x } }\n`,
    );
    expect(doc.validate().issues.length).toBeGreaterThan(0);
  });
});

const PLAIN = "      - line: Hi # keep this\n        id: l\n        speaker: a\n";

describe("removing the last setting", () => {
  const FLOW =
    "      - { line: Hi, id: l, speaker: a, voice: { settings: { style: 0.2 } } } # keep\n";
  const BLOCK = [
    "      - line: Hi # keep this",
    "        id: l",
    "        speaker: a",
    "        voice:",
    "          settings:",
    "            style: 0.2",
    "",
  ].join("\n");

  test.each([
    ["block, empty settings", BLOCK, { voice: { settings: {} } }],
    ["block, key set to undefined", BLOCK, { voice: { settings: { style: undefined } } }],
    ["flow, empty settings", FLOW, { voice: { settings: {} } }],
    ["flow, key set to undefined", FLOW, { voice: { settings: { style: undefined } } }],
  ] as [string, string, ItemPatch][])("%s removes settings and voice", (_, items, patch) => {
    const { doc, item } = edit(items, patch);
    expect(item).not.toHaveProperty("voice");
    expect(doc.text).not.toContain("settings");
    expect(doc.text).toMatch(/# keep/);
  });
});

describe("array and nested values", () => {
  test.each([
    ["block", ITEM],
    [
      "flow",
      "      - { line: Hi, id: l, speaker: a, voice: { settings: { style: 0.2 } } } # keep\n",
    ],
    ["new voice", PLAIN],
  ])("writes lists and mappings as YAML in a %s item", (_, items) => {
    const settings = { list: [1, 2], nested: { a: [true, null, { b: "x: y" }], c: [] } };
    const { doc, item } = edit(items, { voice: { settings } });
    expect(item).toMatchObject({ voice: { settings } });
    expect(doc.text).toContain("# keep");
  });

  test("replaces a scalar, a list, and a mapping with each other", () => {
    const first = edit(ITEM, { voice: { settings: { stability: [1, 2], style: { a: 1 } } } });
    updateItem(first.doc, "l", { voice: { settings: { stability: 0.3, style: [3] } } });
    expect(first.doc.validate().scenario?.scenes[0]?.items[0]).toMatchObject({
      voice: { settings: { stability: 0.3, style: [3] } },
    });
  });
});

import { ScenarioDocument } from "@vd-creator/scenario";
import { describe, expect, test } from "vitest";
import { cacheKey } from "./canonical.js";
import { generationRequest, scenarioItems } from "./items.js";

function lineRequest(lineExtra: string, speakerSettings = "{ stability: 0.5, style: 0.1 }") {
  const doc = new ScenarioDocument(
    [
      "version: 1",
      "title: T",
      "speakers:",
      `  - { id: a, name: A, voice: { provider: mock, voiceId: v1, settings: ${speakerSettings} } }`,
      "scenes:",
      "  - id: s",
      "    items:",
      `      - { id: l, speaker: a, line: Hello, direction: calm${lineExtra} }`,
      "",
    ].join("\n"),
  );
  const { scenario, issues } = doc.validate();
  expect(issues).toEqual([]);
  if (!scenario) throw new Error("expected a scenario");
  const target = scenarioItems(scenario)[0];
  if (!target) throw new Error("expected an item");
  const gen = generationRequest(scenario, target);
  if (gen?.kind !== "tts") throw new Error("expected a tts request");
  return gen.request;
}

describe("line voice settings", () => {
  test("a line override wins over the speaker one key at a time", () => {
    const request = lineRequest(", voice: { settings: { style: 0.2, speed: 1.1 } }");
    expect(request.settings).toEqual({ stability: 0.5, style: 0.2, speed: 1.1 });
  });

  test("a line override works for a speaker without settings", () => {
    const request = lineRequest(", voice: { settings: { style: 0.2 } }", "{}");
    expect(request.settings).toEqual({ style: 0.2 });
  });

  test("a change to the override changes the cache key", () => {
    const a = lineRequest(", voice: { settings: { style: 0.2 } }");
    const b = lineRequest(", voice: { settings: { style: 0.3 } }");
    expect(cacheKey("tts", "mock", a)).not.toBe(cacheKey("tts", "mock", b));
    expect(cacheKey("tts", "mock", a)).not.toBe(cacheKey("tts", "mock", lineRequest("")));
  });

  test("a line without voice keeps the cache key it had before", () => {
    // Computed with the code before the voice field existed.
    expect(cacheKey("tts", "mock", lineRequest(""))).toBe(
      "15ea70aea0de27e93318c99f063faaccb82d698d78d4497a1bef901e1bfffbd2",
    );
  });
});

import { readFile } from "node:fs/promises";
import { AssetCache, computeTimeline, defaultResolvers } from "@vd-creator/core";
import { createMockProviders } from "@vd-creator/providers";
import { parseScenario, type Scenario } from "@vd-creator/scenario";
import { describe, expect, test } from "vitest";
import { buildSrt } from "./srt.js";

const SAMPLE = new URL("../../scenario/fixtures/sample.yaml", import.meta.url);
const resolvers = defaultResolvers(createMockProviders());

function parse(text: string): Scenario {
  const { scenario, issues } = parseScenario(text);
  if (!scenario) throw new Error(`invalid scenario: ${JSON.stringify(issues)}`);
  return scenario;
}

/** The SRT of a scenario with no assets, so every line has its estimated length. */
async function srtOf(scenario: Scenario): Promise<string> {
  // An empty cache in a folder that does not exist: nothing is read or written.
  const timeline = await computeTimeline(scenario, new AssetCache("no-such-project"), resolvers);
  return buildSrt(timeline, scenario);
}

describe("buildSrt", () => {
  test("matches the snapshot for the 0003 sample", async () => {
    const scenario = parse(await readFile(SAMPLE, "utf8"));
    expect(await srtOf(scenario)).toMatchInlineSnapshot(`
      "1
      00:00:01,800 --> 00:00:03,067
      Mira: Is anyone up there?

      2
      00:00:04,767 --> 00:00:05,267
      Mira: ...

      3
      00:00:05,067 --> 00:00:06,733
      The Keeper: Up here. Mind the stairs.
      "
    `);
  });

  test("leaves out the speaker name when only one speaker talks, and removes blank lines", async () => {
    const scenario = parse(`
version: 1
title: Solo
speakers:
  - id: a
    name: Ann
    voice: { provider: mock, voiceId: v }
  - id: b
    name: Ben
    voice: { provider: mock, voiceId: v }
scenes:
  - id: s1
    items:
      - line: "First part.\\n\\n  Second part."
        id: l1
        speaker: a
      - pause: 3599.5
      - line: "Later."
        id: l2
        speaker: a
      - line: "   "
        id: l3
        speaker: b
`);
    expect(await srtOf(scenario)).toBe(
      "1\n00:00:00,300 --> 00:00:02,100\nFirst part.\nSecond part.\n\n" +
        "2\n01:00:01,900 --> 01:00:02,400\nLater.\n",
    );
  });
});

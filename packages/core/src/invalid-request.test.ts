import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockProviders } from "@vd-creator/providers";
import { parseScenario, type Scenario } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AssetCache } from "./cache.js";
import { CANONICAL_JSON_UNSUPPORTED } from "./canonical.js";
import { GenerationError, planGeneration, runGeneration } from "./generate.js";
import { defaultResolvers } from "./resolver.js";
import { computeTimeline } from "./timeline.js";

// Speaker settings are free-form in the scenario schema, so a valid scenario can hold values
// that canonicalJson does not support. Only the line that uses them may be affected.
const scenarioWith = (settings: string): Scenario => {
  const { scenario, issues } = parseScenario(`
version: 1
title: Bad settings
speakers:
  - id: a
    name: A
    voice: { provider: mock, voiceId: v }
  - id: b
    name: B
    voice:
      provider: mock
      voiceId: w
      settings: ${settings}
scenes:
  - id: s1
    bgm: { prompt: calm }
    items:
      - line: Good line
        id: good
        speaker: a
      - line: Secret words
        id: bad
        speaker: b
      - sfx: door
        id: fx
`);
  if (!scenario) throw new Error(`invalid scenario: ${JSON.stringify(issues)}`);
  return scenario;
};

const CASES = [
  { name: "a .inf value", settings: "{ stability: .inf }" },
  { name: "a cyclic alias", settings: "&c { stability: 0.5, self: *c }" },
];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-core-invalid-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.each(CASES)("a line whose speaker settings hold $name", ({ settings }) => {
  const scenario = scenarioWith(settings);
  const resolvers = () => defaultResolvers(createMockProviders());

  test("is invalid in the plan, with no cost, and every other item still plans", async () => {
    const plan = await planGeneration(scenario, new AssetCache(dir), resolvers());
    expect(plan.items.map((i) => [i.id, i.status])).toEqual([
      ["s1", "to-generate"],
      ["good", "to-generate"],
      ["bad", "invalid"],
      ["fx", "to-generate"],
    ]);
    const bad = plan.items.find((i) => i.id === "bad");
    expect(bad).toEqual({
      id: "bad",
      kind: "line",
      sceneId: "s1",
      resolver: "generated",
      status: "invalid",
      reason: expect.stringContaining('line "bad"'),
    });
    expect(JSON.stringify(bad)).not.toMatch(/Secret|stability|Infinity/);
    const counted = plan.items.flatMap((i) => (i.status === "to-generate" ? [i.cost] : []));
    expect(plan.cost).toEqual({
      characters: counted.reduce((sum, c) => sum + c.characters, 0),
      requests: counted.reduce((sum, c) => sum + c.requests, 0),
    });
  });

  test("fails alone in a generation run with the fixed error, and is timed with an estimate", async () => {
    const cache = new AssetCache(dir);
    const result = await runGeneration(scenario, cache, resolvers());
    expect(result.items.map((i) => [i.id, i.status])).toEqual([
      ["s1", "generated"],
      ["good", "generated"],
      ["bad", "failed"],
      ["fx", "generated"],
    ]);
    expect(result.failed).toBe(1);
    const bad = result.items.find((i) => i.id === "bad");
    if (bad?.status !== "failed") throw new Error("bad must fail");
    expect(bad.error).toBeInstanceOf(GenerationError);
    expect(bad.error.message).toBe('Failed to plan line "bad"');
    // The cause is the fixed TypeError, never a RangeError from a cycle.
    expect(bad.error.cause).toBeInstanceOf(TypeError);
    expect((bad.error.cause as Error).message).toBe(CANONICAL_JSON_UNSUPPORTED);

    const timeline = await computeTimeline(scenario, cache, resolvers());
    const item = (id: string) => timeline.items.find((i) => i.id === id);
    expect(item("good")?.assetFile).toMatch(/^voice\//);
    expect(item("fx")?.assetFile).toMatch(/^sfx\//);
    expect(timeline.bgm[0]?.assetFile).toMatch(/^bgm\//);
    expect(item("bad")).toMatchObject({ missing: true, invalid: true, durationSec: 0.8 });
    expect(item("bad")?.unresolved).toBeUndefined();
    // The estimate still moves the items after it.
    const bad1 = item("bad");
    expect(item("fx")?.startSec).toBeCloseTo((bad1?.startSec ?? 0) + (bad1?.durationSec ?? 0), 6);
  });
});

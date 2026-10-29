import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockProviders } from "@vd-creator/providers";
import { parseScenario, type Scenario } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AssetCache } from "./cache.js";
import { CANONICAL_JSON_UNSUPPORTED } from "./canonical.js";
import { GenerationError, planGeneration, planPlayback, runGeneration } from "./generate.js";
import type { ScenarioItem } from "./items.js";
import { type AssetResolver, defaultResolvers, type PlannedAsset } from "./resolver.js";
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
  { name: "a .nan value", settings: "{ stability: .nan }" },
  { name: "a 1e400 value", settings: "{ stability: 1e400 }" },
  { name: "a !!binary value", settings: "{ stability: !!binary aGVsbG8= }" },
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

describe("a resolver outside the package", () => {
  const scenario = scenarioWith("{ stability: 0.5 }");
  const isFx = (item: ScenarioItem) => item.id === "fx";

  /** A resolver for "fx" only, whose plan is given, and that counts its resolve calls. */
  const fxResolver = (plan: () => Promise<PlannedAsset>) => {
    const resolver = {
      id: "custom",
      resolved: 0,
      handles: isFx,
      plan,
      resolve: async () => {
        resolver.resolved++;
        return { file: "sfx/custom.wav", durationSec: 1, generated: true };
      },
    } satisfies AssetResolver & { resolved: number };
    return resolver;
  };
  const withMock = (resolver: AssetResolver) => [
    resolver,
    ...defaultResolvers(createMockProviders()),
  ];

  test("that throws the canonicalJson error makes the item invalid everywhere", async () => {
    const resolvers = withMock(
      fxResolver(async () => {
        throw new TypeError(CANONICAL_JSON_UNSUPPORTED);
      }),
    );
    const cache = new AssetCache(dir);
    const invalid = {
      id: "fx",
      kind: "sfx",
      sceneId: "s1",
      resolver: "custom",
      status: "invalid",
      reason: expect.stringContaining('sfx "fx"'),
    };
    const plan = await planGeneration(scenario, cache, resolvers);
    expect(plan.items.find((i) => i.id === "fx")).toEqual(invalid);
    expect(plan.items.filter((i) => i.status === "to-generate")).toHaveLength(3);
    expect((await planPlayback(scenario, cache, resolvers)).find((i) => i.id === "fx")).toEqual(
      invalid,
    );
    const timeline = await computeTimeline(scenario, cache, resolvers);
    expect(timeline.items.find((i) => i.id === "fx")).toMatchObject({
      missing: true,
      invalid: true,
    });
    expect(timeline.items.find((i) => i.id === "good")?.invalid).toBeUndefined();
  });

  test("that returns invalid is never generated and fails in a generation run", async () => {
    const resolver = fxResolver(async () => ({ status: "invalid", reason: 'sfx "fx" is bad' }));
    const result = await runGeneration(scenario, new AssetCache(dir), withMock(resolver));
    expect(resolver.resolved).toBe(0);
    const fx = result.items.find((i) => i.id === "fx");
    expect(fx).toMatchObject({ status: "failed", resolver: "custom" });
    if (fx?.status !== "failed") throw new Error("fx must fail");
    expect(fx.error).toBeInstanceOf(GenerationError);
    expect(fx.error.message).toBe('Failed to plan sfx "fx"');
    expect(result.failed).toBe(1);
    expect(result.items.filter((i) => i.status === "generated")).toHaveLength(3);
  });

  test("that returns an unknown status is never generated and fails in a generation run", async () => {
    const resolver = fxResolver(async () => ({ status: "later" }) as unknown as PlannedAsset);
    const result = await runGeneration(scenario, new AssetCache(dir), withMock(resolver));
    expect(resolver.resolved).toBe(0);
    expect(result.items.find((i) => i.id === "fx")).toMatchObject({ status: "failed" });
    expect(result.failed).toBe(1);
  });

  test("that throws another TypeError still fails planning and the timeline", async () => {
    const resolvers = withMock(
      fxResolver(async () => {
        throw new TypeError("something else");
      }),
    );
    const cache = new AssetCache(dir);
    for (const run of [
      () => planGeneration(scenario, cache, resolvers),
      () => planPlayback(scenario, cache, resolvers),
      () => computeTimeline(scenario, cache, resolvers),
    ]) {
      const error = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(GenerationError);
      expect((error as GenerationError).message).toBe('Failed to plan sfx "fx"');
      expect((error as GenerationError).cause).toEqual(new TypeError("something else"));
    }
  });
});

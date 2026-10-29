import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockProviders } from "@vd-creator/providers";
import { parseScenario, type Scenario } from "@vd-creator/scenario";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AssetCache, assetFileFor } from "./cache.js";
import { cacheKey } from "./canonical.js";
import { planGeneration } from "./generate.js";
import { generationRequest, type ScenarioItem, scenarioItems } from "./items.js";
import { type AssetResolver, defaultResolvers } from "./resolver.js";
import { computeTimeline, ESTIMATED_SFX_SEC, type Timeline } from "./timeline.js";

const YAML = `
version: 1
title: Timing
speakers:
  - id: a
    name: A
    voice: { provider: mock, voiceId: v }
images:
  - id: i1
    file: images/one.png
  - id: i2
    file: images/two.png
scenes:
  - id: s1
    bgm: { prompt: calm, volume: 0.5 }
    items:
      - image: i1
      - line: One
        id: l1
        speaker: a
      - sfx: boom
        id: fx1
        overlap: true
      - line: Two
        id: l2
        speaker: a
        gapBeforeSec: 0.5
      - pause: 1
      - sfx: door
        id: fx2
  - id: s2
    bgm: { library: hum }
    items:
      - line: Three
        id: l3
        speaker: a
        gapBeforeSec: -0.2
      - image: i2
      - line: Four
        id: l4
        speaker: a
      - sfx: { library: creak }
        id: fx3
`;

function parse(text: string): Scenario {
  const { scenario, issues } = parseScenario(text);
  if (!scenario) throw new Error(`invalid scenario: ${JSON.stringify(issues)}`);
  return scenario;
}

const resolvers = defaultResolvers(createMockProviders());
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-core-timeline-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A cache in a new folder with an asset file of the given length for each item ID. */
async function cacheWith(
  scenario: Scenario,
  durations: Record<string, number>,
): Promise<AssetCache> {
  const cache = new AssetCache(await mkdtemp(join(dir, "project-")));
  for (const item of scenarioItems(scenario)) {
    const durationSec = durations[item.id];
    const gen = generationRequest(scenario, item);
    if (durationSec === undefined || !gen) continue;
    const key = cacheKey(gen.kind, "mock", gen.request);
    const file = assetFileFor(gen.kind, key, "wav");
    await cache.writeAsset(file, new Uint8Array([0]));
    cache.set(key, {
      kind: gen.kind,
      file,
      providerId: "mock",
      request: gen.request,
      durationSec,
      createdAt: "2026-10-29T00:00:00.000Z",
    });
  }
  return cache;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

describe("computeTimeline", () => {
  const scenario = parse(YAML);
  let cache: AssetCache;
  let timeline: Timeline;
  const item = (id: string) => timeline.items.find((i) => i.id === id);

  beforeAll(async () => {
    cache = await cacheWith(scenario, { s1: 30, l1: 2, fx1: 4, l2: 1, fx2: 0.5, l3: 1.5 });
    timeline = await computeTimeline(scenario, cache, resolvers);
  });

  test("start times follow the gap and overlap rules", () => {
    expect(
      timeline.items.map((i) => [i.id ?? i.kind, round(i.startSec), round(i.durationSec)]),
    ).toEqual([
      ["image", 0, 0],
      ["l1", 0.3, 2], // Lines default to a 0.3 s gap.
      ["fx1", 2.3, 4], // Other items default to no gap.
      ["l2", 2.8, 1], // The overlapping SFX does not push the next line.
      ["pause", 3.8, 1],
      ["fx2", 4.8, 0.5],
      ["l3", 5.1, 1.5], // A negative gap overlaps the previous item, across scenes.
      ["image", 6.6, 0],
      ["l4", 6.9, 0.5],
      ["fx3", 7.4, ESTIMATED_SFX_SEC],
    ]);
    expect(round(timeline.durationSec)).toBe(8.9);
  });

  test("items with assets name their file, others are missing with an estimate", () => {
    const l1 = item("l1");
    expect(l1?.assetFile).toMatch(/^voice\/[0-9a-f]{16}\.wav$/);
    expect(l1?.missing).toBeUndefined();
    expect(item("fx1")?.assetFile).toMatch(/^sfx\//);
    expect(item("l4")).toMatchObject({ missing: true });
    expect(item("l4")?.assetFile).toBeUndefined();
    expect(item("l4")?.unresolved).toBeUndefined();
    expect(item("fx3")).toMatchObject({ missing: true, unresolved: true });
    expect(timeline.items[0]).toMatchObject({ kind: "image", sceneId: "s1", index: 0 });
  });

  test("image, scene, and BGM spans", () => {
    expect(
      timeline.images.map((s) => [s.imageId, s.file, round(s.startSec), round(s.endSec)]),
    ).toEqual([
      ["i1", "images/one.png", 0, 6.6],
      ["i2", "images/two.png", 6.6, 8.9],
    ]);
    // Scene s1 lasts until its overlapping SFX ends; s2 starts with its overlapping line.
    expect(timeline.scenes.map((s) => [s.sceneId, round(s.startSec), round(s.endSec)])).toEqual([
      ["s1", 0, 6.3],
      ["s2", 5.1, 8.9],
    ]);
    expect(timeline.bgm).toEqual([
      expect.objectContaining({
        sceneId: "s1",
        volume: 0.5,
        startSec: 0,
        assetDurationSec: 30,
        assetFile: expect.stringMatching(/^bgm\//),
      }),
      expect.objectContaining({ sceneId: "s2", volume: 0.3, missing: true, unresolved: true }),
    ]);
  });

  test("without any asset, every audio item gets an estimate", async () => {
    const empty = await computeTimeline(scenario, await cacheWith(scenario, {}), resolvers);
    expect(
      empty.items.filter((i) => i.kind === "line" || i.kind === "sfx").every((i) => i.missing),
    ).toBe(true);
    // "One" is shorter than the minimum line estimate; fx1 has no requested duration.
    expect(empty.items.find((i) => i.id === "l1")?.durationSec).toBe(0.5);
    expect(empty.items.find((i) => i.id === "fx1")?.durationSec).toBe(ESTIMATED_SFX_SEC);
  });

  test("a requested SFX duration is the estimate, and start times never go below 0", async () => {
    const s = parse(`
version: 1
title: Start
scenes:
  - id: s1
    items:
      - sfx: wind
        id: w
        durationSec: 2.5
        gapBeforeSec: -1
`);
    expect((await computeTimeline(s, await cacheWith(s, {}), resolvers)).items).toEqual([
      {
        id: "w",
        kind: "sfx",
        sceneId: "s1",
        index: 0,
        startSec: 0,
        durationSec: 2.5,
        missing: true,
      },
    ]);
  });

  test("an entry whose file is missing is not cached, in the plan and the timeline alike", async () => {
    const local = await cacheWith(scenario, { l1: 2, l2: 1 });
    const l1 = scenarioItems(scenario).find((i) => i.id === "l1") as ScenarioItem;
    const gen = generationRequest(scenario, l1);
    if (!gen) throw new Error("l1 is generated");
    const entry = local.get(cacheKey(gen.kind, "mock", gen.request));
    await rm(local.assetPath(entry?.file ?? ""));

    const plan = await planGeneration(scenario, local, resolvers);
    const after = await computeTimeline(scenario, local, resolvers);
    for (const planned of plan.items) {
      const shown = [...after.items, ...after.bgm.map((b) => ({ ...b, id: b.sceneId }))].find(
        (i) => i.id === planned.id,
      );
      expect(shown?.missing === true, planned.id).toBe(planned.status !== "cached");
    }
    const timelineL1 = after.items.find((i) => i.id === "l1");
    expect(timelineL1).toMatchObject({ missing: true, durationSec: 0.5 });
    expect(timelineL1?.assetFile).toBeUndefined();
    expect(after.items.find((i) => i.id === "l2")?.missing).toBeUndefined();
  });

  test("assets come from the resolvers, so a library resolver supplies library sounds", async () => {
    const library: AssetResolver = {
      id: "library",
      handles: (target) =>
        (target.kind === "sfx" && typeof target.item.sfx !== "string") ||
        (target.kind === "bgm" && "library" in target.bgm),
      plan: async (target) => ({
        status: "cached",
        file: `library/${target.id}.wav`,
        durationSec: target.kind === "bgm" ? 20 : 0.7,
      }),
      resolve: async () => {
        throw new Error("not called");
      },
    };
    const withLibrary = await computeTimeline(scenario, cache, [library, ...resolvers]);
    expect(withLibrary.items.find((i) => i.id === "fx3")).toEqual({
      id: "fx3",
      kind: "sfx",
      sceneId: "s2",
      index: 3,
      startSec: expect.closeTo(7.4, 6),
      durationSec: 0.7,
      assetFile: "library/fx3.wav",
    });
    expect(withLibrary.bgm[1]).toEqual({
      sceneId: "s2",
      volume: 0.3,
      startSec: expect.closeTo(5.1, 6),
      endSec: expect.closeTo(8.1, 6),
      assetFile: "library/s2.wav",
      assetDurationSec: 20,
    });
  });

  test("an image never starts before the previous image, and empty spans are dropped", async () => {
    const s = parse(`
version: 1
title: Images
images:
  - id: a
    file: a.png
  - id: b
    file: b.png
  - id: c
    file: c.png
scenes:
  - id: s1
    items:
      - pause: 2
      - image: a
      - image: b
        gapBeforeSec: -1
      - pause: 3
        id: p
      - image: c
      - pause: 1
        id: q
`);
    const t = await computeTimeline(s, await cacheWith(s, {}), resolvers);
    // b is clamped to a's start, which leaves a with no time, so a's span is dropped. The
    // clamp moves only the image: the pause after b still follows b's negative gap.
    expect(t.images).toEqual([
      { imageId: "b", file: "b.png", startSec: 2, endSec: 4 },
      { imageId: "c", file: "c.png", startSec: 4, endSec: 5 },
    ]);
    expect(t.items.map((i) => [i.id ?? i.kind, i.startSec])).toEqual([
      ["pause", 0],
      ["image", 2],
      ["image", 2],
      ["p", 1],
      ["image", 4],
      ["q", 4],
    ]);
    for (const span of t.images) expect(span.endSec).toBeGreaterThan(span.startSec);
  });
});

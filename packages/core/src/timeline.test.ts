import { parseScenario, type Scenario } from "@vd-creator/scenario";
import { describe, expect, test } from "vitest";
import { AssetCache, assetFileFor } from "./cache.js";
import { cacheKey } from "./canonical.js";
import { generationRequest, scenarioItems } from "./items.js";
import { computeTimeline, ESTIMATED_SFX_SEC } from "./timeline.js";

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

/** A cache with an asset of the given length for each item ID. */
function cacheWith(scenario: Scenario, durations: Record<string, number>): AssetCache {
  const cache = new AssetCache("/unused");
  for (const item of scenarioItems(scenario)) {
    const durationSec = durations[item.id];
    const gen = generationRequest(scenario, item);
    if (durationSec === undefined || !gen) continue;
    const key = cacheKey(gen.kind, "mock", gen.request);
    cache.set(key, {
      kind: gen.kind,
      file: assetFileFor(gen.kind, key, "wav"),
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
  const cache = cacheWith(scenario, { s1: 30, l1: 2, fx1: 4, l2: 1, fx2: 0.5, l3: 1.5 });
  const timeline = computeTimeline(scenario, cache);
  const item = (id: string) => timeline.items.find((i) => i.id === id);

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

  test("without any asset, every audio item gets an estimate", () => {
    const empty = computeTimeline(scenario, new AssetCache("/unused"));
    expect(
      empty.items.filter((i) => i.kind === "line" || i.kind === "sfx").every((i) => i.missing),
    ).toBe(true);
    // "One" is shorter than the minimum line estimate; fx1 has no requested duration.
    expect(empty.items.find((i) => i.id === "l1")?.durationSec).toBe(0.5);
    expect(empty.items.find((i) => i.id === "fx1")?.durationSec).toBe(ESTIMATED_SFX_SEC);
  });

  test("a requested SFX duration is the estimate, and start times never go below 0", () => {
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
    expect(computeTimeline(s, new AssetCache("/unused")).items).toEqual([
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

  test("providerId selects that provider's assets", () => {
    expect(
      computeTimeline(scenario, cache, { providerId: "elevenlabs" }).items.find(
        (i) => i.id === "l1",
      )?.missing,
    ).toBe(true);
    expect(
      computeTimeline(scenario, cache, { providerId: "mock" }).items.find((i) => i.id === "l1")
        ?.missing,
    ).toBeUndefined();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScenario } from "@vd-creator/scenario";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AssetCache, assetFileFor } from "./cache.js";
import { cacheKey } from "./canonical.js";
import { audioKindOf, draftItems, itemAudioKind, scenarioAudioKinds } from "./draft.js";
import { generationRequest, scenarioItems } from "./items.js";

const SCENARIO = `version: 1
title: Drama
speakers:
  - id: ann
    name: Ann
    voice:
      provider: mock
      voiceId: v1
scenes:
  - id: s1
    bgm:
      prompt: calm
    items:
      - line: Mock line
        id: l1
        speaker: ann
      - line: Paid line
        id: l2
        speaker: ann
      - line: Not made yet
        id: l3
        speaker: ann
      - sfx: { library: door }
        id: x1
      - sfx: wind
        id: x2
      - pause: 1
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-core-draft-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("only the mock provider makes draft audio", () => {
  expect(audioKindOf("mock")).toBe("draft");
  expect(audioKindOf("elevenlabs")).toBe("final");
});

test("library sounds and paid assets are final, mock assets are draft, and a missing one is null", async () => {
  const { scenario } = parseScenario(SCENARIO);
  if (!scenario) throw new Error("invalid scenario");
  const cache = new AssetCache(dir);
  const made: Record<string, string> = {
    s1: "mock",
    l1: "mock",
    l2: "elevenlabs",
    x2: "elevenlabs",
  };
  for (const item of scenarioItems(scenario)) {
    const providerId = made[item.id];
    const gen = generationRequest(scenario, item);
    if (!providerId || !gen) continue;
    const key = cacheKey(gen.kind, providerId, gen.request);
    const file = assetFileFor(gen.kind, key, "wav");
    await cache.writeAsset(file, new Uint8Array([1]));
    cache.set(key, {
      kind: gen.kind,
      file,
      providerId,
      request: gen.request,
      durationSec: 1,
      createdAt: "2026-10-31T00:00:00.000Z",
    });
  }

  const kinds = await scenarioAudioKinds(scenario, cache);
  expect(kinds.map((k) => [k.kind, k.id, k.audio])).toEqual([
    ["bgm", "s1", "draft"],
    ["line", "l1", "draft"],
    ["line", "l2", "final"],
    ["line", "l3", null],
    ["sfx", "x1", "final"],
    ["sfx", "x2", "final"],
  ]);
  expect((await draftItems(scenario, cache)).map((k) => k.id)).toEqual(["s1", "l1"]);
  const [first] = scenarioItems(scenario);
  expect(first && (await itemAudioKind(scenario, cache, first))).toBe("draft");
});

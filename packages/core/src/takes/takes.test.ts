import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockProviders, type ProviderSet } from "@vd-creator/providers";
import { type Scenario, ScenarioDocument } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AssetCache } from "../cache.js";
import { runGeneration } from "../generate.js";
import { defaultResolvers } from "../resolver.js";
import { appendTake, readTakes, TAKES_FILE } from "./history.js";
import { planTrial, runTrial } from "./trial.js";
import { findRestorable, lineFieldsOf, listTakes, nextTakeNumber } from "./versions.js";

const SAMPLE = fileURLToPath(new URL("../../../scenario/fixtures/sample.yaml", import.meta.url));
const LINE = "s1-l1";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-core-takes-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sample(): Promise<Scenario> {
  const { scenario, issues } = new ScenarioDocument(await readFile(SAMPLE, "utf8")).validate();
  if (!scenario) throw new Error(`invalid: ${JSON.stringify(issues)}`);
  return scenario;
}

/** Mock providers under another ID, to play a switch of provider. */
function providersNamed(id: string): ProviderSet {
  const mock = createMockProviders();
  return {
    ...mock,
    tts: {
      ...mock.tts,
      id,
      estimate: (r) => mock.tts.estimate(r),
      synthesize: (r) => mock.tts.synthesize(r),
    },
  };
}

async function generate(scenario: Scenario, providers: ProviderSet, only = [LINE]) {
  const cache = await AssetCache.load(dir);
  return runGeneration(scenario, cache, defaultResolvers(providers), { only });
}

describe("take history", () => {
  test("generation appends an entry with the line's own fields", async () => {
    const scenario = await sample();
    const result = await generate(scenario, createMockProviders());
    expect(result.items[0]?.status).toBe("generated");
    const [entry, ...rest] = await readTakes(dir);
    expect(rest).toEqual([]);
    const fields = lineFieldsOf(scenario, LINE);
    expect(entry).toMatchObject({
      item: LINE,
      provider: "mock",
      line: fields?.line,
      direction: fields?.direction,
      take: fields?.take,
    });
    expect(entry?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.trial).toBeUndefined();
  });

  test("a cached item appends nothing", async () => {
    const scenario = await sample();
    await generate(scenario, createMockProviders());
    await generate(scenario, createMockProviders());
    expect(await readTakes(dir)).toHaveLength(1);
  });

  test("a cut-off last line and a bad line are skipped, and the next append is whole", async () => {
    const scenario = await sample();
    await generate(scenario, createMockProviders());
    const [entry] = await readTakes(dir);
    if (!entry) throw new Error("expected an entry");
    const file = join(dir, TAKES_FILE);
    await writeFile(file, `${await readFile(file, "utf8")}not json\n{"time":"x"}\n{"item":"cut`);
    expect(await readTakes(dir)).toEqual([entry]);
    await appendTake(dir, { ...entry, take: 9 });
    expect((await readTakes(dir)).map((e) => e.take)).toEqual([entry.take, 9]);
  });
});

describe("trial", () => {
  test("generates one asset, leaves the scenario alone, and numbers the take above all", async () => {
    const scenario = await sample();
    const before = structuredClone(scenario);
    await generate(scenario, createMockProviders());
    const cache = await AssetCache.load(dir);
    const resolvers = defaultResolvers(createMockProviders());
    const edit = { direction: "whisper", voiceSettings: { style: 0.4 } };

    const plan = await planTrial(scenario, cache, resolvers, LINE, edit);
    expect(plan.items.map((i) => [i.id, i.status])).toEqual([[LINE, "to-generate"]]);

    const first = await runTrial(scenario, cache, resolvers, LINE, edit, {
      proposalId: "p1",
      reason: "softer",
    });
    const second = await runTrial(scenario, cache, resolvers, LINE, edit, {
      proposalId: "p1",
      reason: "softer",
    });
    expect(first.result.status).toBe("generated");
    // The same proposal twice gives two takes.
    expect(second.result.status).toBe("generated");
    expect(second.take).toBe(first.take + 1);
    expect(first.take).toBeGreaterThan(
      before.scenes[0]?.items[0] ? (lineFieldsOf(before, LINE)?.take ?? 0) : 0,
    );
    expect(scenario).toEqual(before);

    const trials = (await readTakes(dir)).filter((e) => e.trial);
    expect(trials.map((e) => [e.proposalId, e.reason, e.direction, e.voiceSettings])).toEqual([
      ["p1", "softer", "whisper", { style: 0.4 }],
      ["p1", "softer", "whisper", { style: 0.4 }],
    ]);
  });

  test("a failed trial adds no history and no asset", async () => {
    const scenario = await sample();
    const mock = createMockProviders();
    const failing: ProviderSet = {
      ...mock,
      tts: {
        ...mock.tts,
        estimate: (r) => mock.tts.estimate(r),
        synthesize: async () => {
          throw new Error("down");
        },
      },
    };
    const cache = await AssetCache.load(dir);
    const { result } = await runTrial(scenario, cache, defaultResolvers(failing), LINE, {
      direction: "x",
    });
    expect(result.status).toBe("failed");
    expect(await readTakes(dir)).toEqual([]);
    expect((await AssetCache.load(dir)).get("0".repeat(64))).toBeUndefined();
  });

  test("nextTakeNumber is above the history and the scenario", async () => {
    const scenario = await sample();
    const current = lineFieldsOf(scenario, LINE)?.take ?? 0;
    expect(nextTakeNumber(scenario, LINE, [])).toBe(current + 1);
    await generate(scenario, createMockProviders());
    const [entry] = await readTakes(dir);
    if (!entry) throw new Error("expected an entry");
    expect(nextTakeNumber(scenario, LINE, [{ ...entry, take: current + 5 }])).toBe(current + 6);
  });
});

describe("restorable versions", () => {
  test("a version without an override restores to one, with the key tried since gone", async () => {
    const scenario = await sample();
    await generate(scenario, createMockProviders());
    const cache = await AssetCache.load(dir);
    const resolvers = defaultResolvers(createMockProviders());
    await runTrial(scenario, cache, resolvers, LINE, { voiceSettings: { style: 0.4 } });

    const history = await readTakes(dir);
    const versions = await listTakes(scenario, await AssetCache.load(dir), history, LINE, "mock");
    expect(versions).toHaveLength(2);
    const original = versions?.find((v) => !v.entry.trial);
    expect(original?.unavailable).toBeUndefined();
    expect(original?.entry.voiceSettings).toBeUndefined();
    const found = await findRestorable(
      scenario,
      await AssetCache.load(dir),
      history,
      LINE,
      "mock",
      original?.entry.key ?? "",
    );
    expect("version" in found).toBe(true);
  });

  test("another provider, another voice, other speaker settings, and a shadow cannot be restored", async () => {
    const scenario = await sample();
    await generate(scenario, createMockProviders());
    const history = await readTakes(dir);
    const key = history[0]?.key ?? "";
    const cache = await AssetCache.load(dir);

    // The drama switched to another provider: the mock draft is listed but not restorable.
    const other = await listTakes(scenario, cache, history, LINE, "elevenlabs");
    expect(other?.map((v) => v.unavailable)).toEqual(["other-provider"]);
    expect(await findRestorable(scenario, cache, history, LINE, "elevenlabs", key)).toEqual({
      unavailable: "other-provider",
    });

    // Another voice.
    const voice = structuredClone(scenario);
    const speaker = voice.speakers.find((s) => s.id === lineFieldsOf(scenario, LINE)?.speaker);
    if (!speaker) throw new Error("expected a speaker");
    speaker.voice.voiceId = "other";
    expect(
      (await listTakes(voice, cache, history, LINE, "mock"))?.map((v) => v.unavailable),
    ).toEqual(["other-voice"]);

    // Other speaker settings.
    const settings = structuredClone(scenario);
    const s2 = settings.speakers.find((s) => s.id === speaker.id);
    if (!s2) throw new Error("expected a speaker");
    s2.voice.settings = { style: 0.9 };
    expect(
      (await listTakes(settings, cache, history, LINE, "mock"))?.map((v) => v.unavailable),
    ).toEqual(["other-speaker-settings"]);

    // A newer asset of another provider for the same request shadows it in playback.
    await generate(scenario, providersNamed("other-tts"));
    const cache2 = await AssetCache.load(dir);
    const shadowed = await listTakes(scenario, cache2, await readTakes(dir), LINE, "mock");
    const mine = shadowed?.find((v) => v.entry.key === key);
    expect(mine?.unavailable).toBe("shadowed");
    expect(await findRestorable(scenario, cache2, await readTakes(dir), LINE, "mock", key)).toEqual(
      { unavailable: "shadowed" },
    );
  });

  test("an unknown key is unknown", async () => {
    const scenario = await sample();
    const cache = await AssetCache.load(dir);
    expect(await findRestorable(scenario, cache, [], LINE, "mock", "f".repeat(64))).toEqual({
      unavailable: "unknown",
    });
  });
});

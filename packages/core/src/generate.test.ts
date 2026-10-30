import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createElevenLabsProviders,
  createMockProviders,
  type MusicRequest,
  type ProviderSet,
  readWavInfo,
  type SfxRequest,
  type TtsRequest,
} from "@vd-creator/providers";
import { type Scenario, ScenarioDocument, updateItem } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AssetCache, CACHE_FILE } from "./cache.js";
import { GenerationError, type ItemResult, planGeneration, runGeneration } from "./generate.js";
import { BudgetExceededError, defaultResolvers } from "./resolver.js";

const SAMPLE = fileURLToPath(new URL("../../scenario/fixtures/sample.yaml", import.meta.url));

/** Items of the sample that the generated-item resolver handles. */
const GENERATED = ["s1", "s1-waves", "s1-l1", "s1-l2", "s2-l1"];
/** Library items of the sample, which no resolver handles yet. */
const UNRESOLVED = ["s1-door", "s2"];

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-core-generate-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sampleDoc(): Promise<ScenarioDocument> {
  return new ScenarioDocument(await readFile(SAMPLE, "utf8"));
}

function scenarioOf(doc: ScenarioDocument): Scenario {
  const { scenario, issues } = doc.validate();
  if (!scenario) throw new Error(`invalid scenario: ${JSON.stringify(issues)}`);
  return scenario;
}

type Call = { kind: "tts" | "sfx" | "music"; request: TtsRequest | SfxRequest | MusicRequest };

/**
 * Mock providers that record every call, can delay each call, and can fail a call. `active`
 * and `maxActive` track how many calls run at once.
 */
function recordingProviders(
  options: { delayMs?: number; fail?: (call: Call) => Error | undefined; paid?: boolean } = {},
) {
  const paid = options.paid ?? false;
  const mock = createMockProviders();
  const state = { calls: [] as Call[], active: 0, maxActive: 0 };
  const wrap = async <T>(call: Call, run: () => Promise<T>): Promise<T> => {
    state.calls.push(call);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    try {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      const error = options.fail?.(call);
      if (error) throw error;
      return await run();
    } finally {
      state.active--;
    }
  };
  const providers: ProviderSet = {
    tts: {
      id: mock.tts.id,
      paid,
      estimate: (req) => mock.tts.estimate(req),
      synthesize: (req) => wrap({ kind: "tts", request: req }, () => mock.tts.synthesize(req)),
    },
    sfx: {
      id: mock.sfx.id,
      paid,
      estimate: (req) => mock.sfx.estimate(req),
      generate: (req) => wrap({ kind: "sfx", request: req }, () => mock.sfx.generate(req)),
    },
    music: {
      id: mock.music.id,
      paid,
      estimate: (req) => mock.music.estimate(req),
      generate: (req) => wrap({ kind: "music", request: req }, () => mock.music.generate(req)),
    },
  };
  return { providers, state };
}

function byId(items: readonly ItemResult[]): Record<string, ItemResult> {
  return Object.fromEntries(items.map((r) => [r.id, r]));
}

function statuses(items: readonly { id: string; status: string }[]): Record<string, string> {
  return Object.fromEntries(items.map((r) => [r.id, r.status]));
}

describe("planGeneration", () => {
  test("reports to-generate, unresolved, and the cost without calling providers", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const { providers, state } = recordingProviders();
    const plan = await planGeneration(scenario, new AssetCache(dir), defaultResolvers(providers));
    expect(statuses(plan.items)).toEqual({
      s1: "to-generate",
      "s1-waves": "to-generate",
      "s1-door": "unresolved",
      "s1-l1": "to-generate",
      "s1-l2": "to-generate",
      s2: "unresolved",
      "s2-l1": "to-generate",
    });
    const chars = [
      "quiet piano, rain",
      "waves on rocks",
      "Is anyone up there?",
      "...",
      "Up here. Mind the stairs.",
    ]
      .map((s) => s.length)
      .reduce((a, b) => a + b);
    expect(plan.cost).toEqual({ characters: chars, requests: 5 });
    expect(plan.items.find((i) => i.id === "s1-l1")).toMatchObject({
      kind: "line",
      sceneId: "s1",
      resolver: "generated",
    });
    expect(state.calls).toEqual([]);
  });

  test("only selects items, and unknown IDs are errors", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const resolvers = defaultResolvers(recordingProviders().providers);
    const plan = await planGeneration(scenario, new AssetCache(dir), resolvers, {
      only: ["s1-l1", "s1"],
    });
    expect(plan.items.map((i) => i.id)).toEqual(["s1", "s1-l1"]);
    await expect(
      planGeneration(scenario, new AssetCache(dir), resolvers, { only: ["nope"] }),
    ).rejects.toThrow(/"nope"/);
  });

  describe("notes on directions", () => {
    /** One speaker per model, each with a line, and a line without a direction for "plain". */
    const DIRECTED = new ScenarioDocument(`version: 1
title: Directions
speakers:
  - { id: v2, name: V2, voice: { provider: elevenlabs, voiceId: voice-two, settings: { modelId: eleven_multilingual_v2 } } }
  - { id: v3, name: V3, voice: { provider: elevenlabs, voiceId: voice-three, settings: { modelId: eleven_v3 } } }
  - { id: v4, name: V4, voice: { provider: elevenlabs, voiceId: voice-four, settings: { modelId: eleven_v4 } } }
  - { id: plain, name: Plain, voice: { provider: elevenlabs, voiceId: voice-plain } }
scenes:
  - id: s1
    items:
      - { line: "One.", id: l1, speaker: v2, direction: whispers }
      - { line: "Two.", id: l2, speaker: v2, direction: shouts }
      - { line: "Three.", id: l3, speaker: v3, direction: whispers }
      - { line: "Four.", id: l4, speaker: v4, direction: whispers }
      - { line: "Five.", id: l5, speaker: plain }
`);

    async function notesOf(providers: ProviderSet, only?: string[]): Promise<string[] | undefined> {
      const scenario = scenarioOf(DIRECTED);
      const resolvers = defaultResolvers(providers);
      return (await planGeneration(scenario, new AssetCache(dir), resolvers, { only })).notes;
    }

    test("name once the speakers whose model does not read audio tags", async () => {
      const notes = await notesOf(createElevenLabsProviders({ env: {} }));
      expect(notes).toEqual([
        'Directions are not sent for speaker "v2": the TTS model does not read audio tags',
      ]);
      expect(notes?.join("\n")).not.toContain("voice-two");
    });

    test("are empty for eleven_v3, eleven_v4, and a line without a direction", async () => {
      const providers = createElevenLabsProviders({ env: {} });
      expect(await notesOf(providers, ["l3", "l4", "l5"])).toEqual([]);
    });

    test("are empty with the mock provider", async () => {
      expect(await notesOf(createMockProviders())).toEqual([]);
    });

    test("leave out cached lines", async () => {
      const providers = createElevenLabsProviders({ env: {} });
      const scenario = scenarioOf(DIRECTED);
      const cache = new AssetCache(dir);
      const resolvers = defaultResolvers(providers);
      for (const item of (await planGeneration(scenario, cache, resolvers)).items) {
        if (item.status !== "to-generate" || !item.key) continue;
        const file = `voice/${item.key.slice(0, 16)}.mp3`;
        await cache.writeAsset(file, new Uint8Array([0]));
        cache.set(item.key, {
          kind: "tts",
          file,
          providerId: "elevenlabs",
          request: {},
          durationSec: 1,
          createdAt: new Date(0).toISOString(),
        });
      }
      expect((await planGeneration(scenario, cache, resolvers)).notes).toEqual([]);
    });
  });
});

describe("runGeneration", () => {
  test("generating the sample twice makes no provider calls the second time", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const { providers, state } = recordingProviders();
    const resolvers = defaultResolvers(providers);

    const first = await runGeneration(scenario, await AssetCache.load(dir), resolvers);
    expect(first.failed).toBe(0);
    expect(state.calls).toHaveLength(GENERATED.length);
    for (const id of GENERATED) expect(byId(first.items)[id]?.status).toBe("generated");
    for (const id of UNRESOLVED) expect(byId(first.items)[id]?.status).toBe("unresolved");

    // The assets and cache.json are on disk with the planned layout.
    const cache = await AssetCache.load(dir);
    expect(cache.keys()).toHaveLength(GENERATED.length);
    for (const key of cache.keys()) {
      const entry = cache.get(key);
      expect(entry?.file).toBe(
        `${{ tts: "voice", sfx: "sfx", music: "bgm" }[entry?.kind ?? "tts"]}/${key.slice(0, 16)}.wav`,
      );
      const info = readWavInfo(await readFile(join(dir, "assets", entry?.file ?? "")));
      expect(info.durationSec).toBeCloseTo(entry?.durationSec ?? 0, 6);
    }

    state.calls.length = 0;
    const plan = await planGeneration(scenario, cache, resolvers);
    expect(plan.cost).toEqual({ characters: 0, requests: 0 });
    const second = await runGeneration(scenario, cache, resolvers);
    expect(state.calls).toEqual([]);
    for (const id of GENERATED) expect(byId(second.items)[id]?.status).toBe("cached");
  });

  test("changing one line regenerates only that line", async () => {
    const doc = await sampleDoc();
    const { providers, state } = recordingProviders();
    const resolvers = defaultResolvers(providers);
    await runGeneration(scenarioOf(doc), await AssetCache.load(dir), resolvers);
    state.calls.length = 0;

    updateItem(doc, "s1-l1", { line: "Hello? Is anyone there?" });
    const cache = await AssetCache.load(dir);
    const plan = await planGeneration(scenarioOf(doc), cache, resolvers);
    expect(plan.items.filter((i) => i.status === "to-generate").map((i) => i.id)).toEqual([
      "s1-l1",
    ]);
    const result = await runGeneration(scenarioOf(doc), cache, resolvers);
    expect(state.calls.map((c) => c.request)).toEqual([
      expect.objectContaining({ text: "Hello? Is anyone there?" }),
    ]);
    expect(byId(result.items)["s1-l1"]?.status).toBe("generated");
    // The old asset stays until vd clean.
    expect((await AssetCache.load(dir)).keys()).toHaveLength(GENERATED.length + 1);

    // A new take regenerates too.
    state.calls.length = 0;
    updateItem(doc, "s2-l1", { take: 1 });
    await runGeneration(scenarioOf(doc), cache, resolvers);
    expect(state.calls.map((c) => c.request)).toEqual([expect.objectContaining({ take: 1 })]);
  });

  test("a deleted asset file is generated again", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const { providers, state } = recordingProviders();
    const resolvers = defaultResolvers(providers);
    await runGeneration(scenario, await AssetCache.load(dir), resolvers);
    const cache = await AssetCache.load(dir);
    const result = byId((await runGeneration(scenario, cache, resolvers)).items)["s1-waves"];
    await rm(join(dir, "assets", result && "file" in result ? result.file : ""));
    state.calls.length = 0;
    const again = await runGeneration(scenario, cache, resolvers);
    expect(state.calls.map((c) => c.kind)).toEqual(["sfx"]);
    expect(byId(again.items)["s1-waves"]?.status).toBe("generated");
  });

  test("a provider error names the item ID and kind and does not stop other items", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const secret = "sk-test-secret-value";
    process.env.VD_CORE_TEST_SECRET = secret;
    const providerError = new Error(`TTS failed for line "Is anyone up there?" key ${secret}`);
    const { providers, state } = recordingProviders({
      fail: (call) =>
        "text" in call.request && call.request.text === "Is anyone up there?"
          ? providerError
          : undefined,
    });
    try {
      const result = await runGeneration(
        scenario,
        await AssetCache.load(dir),
        defaultResolvers(providers),
      );
      expect(result.failed).toBe(1);
      expect(state.calls).toHaveLength(GENERATED.length);
      const failed = byId(result.items)["s1-l1"];
      expect(failed?.status).toBe("failed");
      const error = failed && "error" in failed ? failed.error : undefined;
      expect(error).toBeInstanceOf(GenerationError);
      expect(error).toMatchObject({ itemId: "s1-l1", kind: "line", cause: providerError });
      expect(error?.message).toBe('Failed to generate line "s1-l1"');
      expect(error?.message).not.toContain("anyone");
      expect(error?.message).not.toContain("shouting");
      expect(error?.message).not.toContain(secret);
      for (const id of GENERATED.filter((i) => i !== "s1-l1")) {
        expect(byId(result.items)[id]?.status).toBe("generated");
      }
      // The successful items were saved, so the next run generates only the failed one.
      const cache = await AssetCache.load(dir);
      expect(cache.keys()).toHaveLength(GENERATED.length - 1);
      const plan = await planGeneration(scenario, cache, defaultResolvers(providers));
      expect(plan.items.filter((i) => i.status === "to-generate").map((i) => i.id)).toEqual([
        "s1-l1",
      ]);
    } finally {
      delete process.env.VD_CORE_TEST_SECRET;
    }
  });

  test("SFX and music provider errors name their item too", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const { providers } = recordingProviders({
      fail: (call) => (call.kind === "tts" ? undefined : new Error("prompt: waves on rocks")),
    });
    const result = byId(
      (await runGeneration(scenario, new AssetCache(dir), defaultResolvers(providers))).items,
    );
    for (const [id, kind] of [
      ["s1", "bgm"],
      ["s1-waves", "sfx"],
    ] as const) {
      const item = result[id];
      expect(item?.status).toBe("failed");
      const error = item && "error" in item ? item.error : undefined;
      expect(error).toMatchObject({ itemId: id, kind });
      expect(error?.message).toBe(`Failed to generate ${kind} "${id}"`);
    }
    expect(result["s1-l1"]?.status).toBe("generated");
  });

  test("runs at most 4 requests at once", async () => {
    const doc = await sampleDoc();
    // Ten more lines, so that there are more requests than the limit.
    const extra = Array.from(
      { length: 10 },
      (_, i) => `      - line: "Extra line ${i}"\n        id: x${i}\n        speaker: keeper\n`,
    ).join("");
    doc.setText(doc.text.replace("      - pause: 0.8\n", `${extra}      - pause: 0.8\n`));
    const { providers, state } = recordingProviders({ delayMs: 20 });
    const result = await runGeneration(
      scenarioOf(doc),
      new AssetCache(dir),
      defaultResolvers(providers),
      {
        concurrency: 10,
      },
    );
    expect(result.failed).toBe(0);
    expect(state.calls).toHaveLength(GENERATED.length + 10);
    expect(state.maxActive).toBe(4);
  });

  test("writes each asset and cache.json as soon as the item is ready", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const { providers } = recordingProviders({ delayMs: 5 });
    const seen: { id: string; onDisk: boolean }[] = [];
    const pending: Promise<void>[] = [];
    await runGeneration(scenario, new AssetCache(dir), defaultResolvers(providers), {
      onItem: (result) => {
        if (result.status !== "generated") return;
        const file = result.file;
        pending.push(
          (async () => {
            const json = JSON.parse(await readFile(join(dir, CACHE_FILE), "utf8"));
            const files = Object.values(json.entries).map((e) => (e as { file: string }).file);
            await readFile(join(dir, "assets", file));
            seen.push({ id: result.id, onDisk: files.includes(file) });
          })(),
        );
      },
    });
    await Promise.all(pending);
    expect(seen.map((s) => s.id).sort()).toEqual([...GENERATED].sort());
    expect(seen.every((s) => s.onDisk)).toBe(true);
  });

  test("identical requests share one provider call", async () => {
    const doc = await sampleDoc();
    doc.setText(
      doc.text.replace(
        "      - pause: 0.8\n",
        '      - line: "Up here. Mind the stairs."\n        id: s2-l2\n        speaker: keeper\n      - pause: 0.8\n',
      ),
    );
    const scenario = scenarioOf(doc);
    const { providers, state } = recordingProviders({ delayMs: 10 });
    const resolvers = defaultResolvers(providers);
    const plan = await planGeneration(scenario, new AssetCache(dir), resolvers);
    expect(plan.cost.requests).toBe(GENERATED.length);
    const result = byId((await runGeneration(scenario, new AssetCache(dir), resolvers)).items);
    expect(state.calls).toHaveLength(GENERATED.length);
    const a = result["s2-l1"];
    const b = result["s2-l2"];
    expect(a && "file" in a ? a.file : "a").toBe(b && "file" in b ? b.file : "b");
  });
});

describe("runGeneration with a budget", () => {
  const SAME = ["x0", "x1", "x2", "x3", "x4"];

  /** The sample with five identical 5-character lines, x0 to x4. */
  async function fiveSameLines(): Promise<Scenario> {
    const doc = await sampleDoc();
    const lines = SAME.map(
      (id) => `      - line: "Hello"\n        id: ${id}\n        speaker: keeper\n`,
    ).join("");
    doc.setText(doc.text.replace("      - pause: 0.8\n", `${lines}      - pause: 0.8\n`));
    return scenarioOf(doc);
  }

  /** Paid providers whose first call fails. */
  function failFirst(delayMs?: number) {
    let first = true;
    return recordingProviders({
      paid: true,
      ...(delayMs ? { delayMs } : {}),
      fail: () => {
        if (!first) return undefined;
        first = false;
        return new Error("first call fails");
      },
    });
  }

  function causeOf(result: ItemResult | undefined): unknown {
    return result?.status === "failed" ? result.error.cause : undefined;
  }

  test("a request called again after a failed call cannot exceed the budget", async () => {
    const scenario = await fiveSameLines();
    for (const concurrency of [1, 4]) {
      const { providers, state } = failFirst(5);
      const resolvers = defaultResolvers(providers);
      const cache = new AssetCache(await mkdtemp(join(dir, "run-")));
      const plan = await planGeneration(scenario, cache, resolvers, { only: SAME });
      expect(plan.cost).toEqual({ characters: 5, requests: 1 });
      const result = await runGeneration(scenario, cache, resolvers, {
        only: SAME,
        concurrency,
        budget: plan.cost,
      });
      expect(state.calls, `concurrency ${concurrency}`).toHaveLength(1);
      expect(result.failed).toBe(SAME.length);
      const refused = result.items.filter((r) => causeOf(r) instanceof BudgetExceededError);
      expect(refused.length).toBeGreaterThan(0);
    }
  });

  test("without a budget, a failed request is called again as before", async () => {
    const scenario = await fiveSameLines();
    const { providers, state } = failFirst();
    const result = await runGeneration(scenario, new AssetCache(dir), defaultResolvers(providers), {
      only: SAME,
      concurrency: 1,
    });
    expect(state.calls).toHaveLength(2);
    expect(statuses(result.items)).toEqual({
      x0: "failed",
      x1: "generated",
      x2: "cached",
      x3: "cached",
      x4: "cached",
    });
  });

  test("a cached asset removed after planning is not generated beyond the budget", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const { providers, state } = recordingProviders({ paid: true });
    const resolvers = defaultResolvers(providers);
    const cache = await AssetCache.load(dir);
    await runGeneration(scenario, cache, resolvers);
    const plan = await planGeneration(scenario, cache, resolvers);
    expect(plan.cost).toEqual({ characters: 0, requests: 0 });

    const waves = byId((await runGeneration(scenario, cache, resolvers)).items)["s1-waves"];
    await rm(join(dir, "assets", waves && "file" in waves ? waves.file : ""));
    state.calls.length = 0;
    const result = byId(
      (await runGeneration(scenario, cache, resolvers, { budget: plan.cost })).items,
    );
    expect(state.calls).toEqual([]);
    const refused = result["s1-waves"];
    expect(refused?.status).toBe("failed");
    expect(causeOf(refused)).toBeInstanceOf(BudgetExceededError);
    if (refused?.status === "failed") {
      expect(refused.error.message).toBe('Failed to generate sfx "s1-waves"');
    }
    for (const id of GENERATED.filter((i) => i !== "s1-waves")) {
      expect(result[id]?.status).toBe("cached");
    }
  });

  test("a run within its budget generates everything", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const { providers, state } = recordingProviders({ paid: true, delayMs: 5 });
    const resolvers = defaultResolvers(providers);
    const plan = await planGeneration(scenario, new AssetCache(dir), resolvers);
    const result = await runGeneration(scenario, new AssetCache(dir), resolvers, {
      budget: plan.cost,
    });
    expect(result.failed).toBe(0);
    expect(state.calls).toHaveLength(GENERATED.length);
  });

  test("free providers are not counted against the budget", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const { providers, state } = recordingProviders();
    const result = await runGeneration(scenario, new AssetCache(dir), defaultResolvers(providers), {
      budget: { characters: 0, requests: 0 },
    });
    expect(result.failed).toBe(0);
    expect(state.calls).toHaveLength(GENERATED.length);
  });

  test("an invalid budget is refused", async () => {
    const scenario = scenarioOf(await sampleDoc());
    const resolvers = defaultResolvers(recordingProviders({ paid: true }).providers);
    for (const budget of [
      { characters: -1, requests: 1 },
      { characters: 1, requests: Number.NaN },
    ]) {
      await expect(
        runGeneration(scenario, new AssetCache(dir), resolvers, { budget }),
      ).rejects.toThrow(/budget/);
    }
  });
});

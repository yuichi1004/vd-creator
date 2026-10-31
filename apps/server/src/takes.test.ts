import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEntries, readTakes } from "@vd-creator/core";
import { SCENARIO_FILE } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ApiError,
  ConfirmRequiredError,
  GeneratePlanResponse,
  ProjectResponse,
  TakesResponse,
  TrialBase,
  TrialResponse,
} from "./api.js";
import { type AppOptions, createApp, type ServerProviders } from "./app.js";

// A seam that alters the file right after a save, to play a form that reads back differently.
const seam = vi.hoisted(() => ({ corrupt: false }));
vi.mock("@vd-creator/scenario", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vd-creator/scenario")>();
  return {
    ...actual,
    saveScenario: async (...args: Parameters<typeof actual.saveScenario>) => {
      await actual.saveScenario(...args);
      if (seam.corrupt) {
        const { readFile, writeFile } = await import("node:fs/promises");
        const path = join(args[0], actual.SCENARIO_FILE);
        await writeFile(path, (await readFile(path, "utf8")).replace("up there?", "up here?"));
      }
    },
  };
});

const SAMPLE = fileURLToPath(
  new URL("../../../packages/scenario/fixtures/sample.yaml", import.meta.url),
);
const LINE = "s1-l1";

type TtsRequestLike = Parameters<ServerProviders["tts"]["synthesize"]>[0];

let dir: string;
let project: string;

beforeEach(async () => {
  seam.corrupt = false;
  dir = await mkdtemp(join(tmpdir(), "vd-server-takes-"));
  project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, SCENARIO_FILE), await readFile(SAMPLE, "utf8"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Fake providers that record every TTS request. Never a real API. */
function fakeProviders(id = "fake", options: { paid?: boolean; fail?: boolean } = {}) {
  const paid = options.paid ?? false;
  const requests: TtsRequestLike[] = [];
  const audio = async () => ({
    data: new Uint8Array([1, 2, 3]),
    format: "wav" as const,
    durationSec: 1,
    meta: {},
  });
  const cost = () => ({ characters: 1, requests: 1 });
  const providers: ServerProviders = {
    tts: {
      id,
      paid,
      estimate: (req) => ({ characters: req.text.length, requests: 1 }),
      synthesize: async (req) => {
        requests.push(req);
        if (options.fail) throw new Error("the provider is down");
        return audio();
      },
    },
    sfx: { id, paid, estimate: cost, generate: audio },
    music: { id, paid, estimate: cost, generate: audio },
  };
  return { providers, requests };
}

function makeApp(provider: ServerProviders, options: Partial<AppOptions> = {}) {
  const app = createApp({ projectDir: project, provider, ...options });
  return (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Host: "localhost:5310" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

type Call = ReturnType<typeof makeApp>;

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** The line as the UI last saw it, from the project. */
async function baseOf(call: Call, id = LINE): Promise<TrialBase> {
  const body = await json<ProjectResponse>(await call("GET", "/api/project"));
  for (const scene of body.scenario?.scenes ?? []) {
    for (const item of scene.items) {
      if (item.id === id && "line" in item) {
        const base: TrialBase = { speaker: item.speaker, text: item.line, take: item.take ?? 0 };
        if (item.direction !== undefined) base.direction = item.direction;
        if (item.voice?.settings !== undefined) base.voiceSettings = item.voice.settings;
        return base;
      }
    }
  }
  throw new Error(`no line ${id}`);
}

async function generateLine(call: Call) {
  const response = await call("POST", "/api/generate", { ids: [LINE] });
  expect(response.status).toBe(200);
}

async function takes(call: Call): Promise<TakesResponse["takes"]> {
  const response = await call("GET", `/api/items/${LINE}/takes`);
  expect(response.status).toBe(200);
  return (await json<TakesResponse>(response)).takes;
}

const scenarioText = () => readFile(join(project, SCENARIO_FILE), "utf8");

describe("PATCH /api/items/:id with direction and voiceSettings", () => {
  test("sets and removes one override key and keeps the comments", async () => {
    const call = makeApp(fakeProviders().providers);
    let response = await call("PATCH", `/api/items/${LINE}`, {
      voiceSettings: { style: 0.3, speed: 1.1 },
    });
    expect(response.status).toBe(200);
    let text = await scenarioText();
    expect(text).toContain("style: 0.3");
    expect(text).toContain("speed: 1.1");
    expect(text).toContain("# TODO: less shouty?");
    expect(text).toContain("# Stable ID, referenced by lines");

    response = await call("PATCH", `/api/items/${LINE}`, { voiceSettings: { style: null } });
    expect(response.status).toBe(200);
    text = await scenarioText();
    expect(text).not.toContain("style: 0.3");
    expect(text).toContain("speed: 1.1");
    expect(text).toContain("# TODO: less shouty?");

    // Removing the last key removes the override.
    response = await call("PATCH", `/api/items/${LINE}`, { voiceSettings: { speed: null } });
    expect(response.status).toBe(200);
    expect(await scenarioText()).not.toContain("speed");
    expect((await baseOf(call)).voiceSettings).toBeUndefined();
  });

  test("the change is in the change log", async () => {
    const call = makeApp(fakeProviders().providers);
    await call("PATCH", `/api/items/${LINE}`, { voiceSettings: { style: 0.3 } });
    const entries = await readEntries(project);
    expect(entries.some((e) => JSON.stringify(e).includes("style"))).toBe(true);
  });

  test("after a direction edit is kept, the next generation request carries it", async () => {
    const { providers, requests } = fakeProviders();
    const call = makeApp(providers);
    const response = await call("PATCH", `/api/items/${LINE}`, { direction: "whispering" });
    expect(response.status).toBe(200);
    await generateLine(call);
    expect(requests.at(-1)?.direction).toBe("whispering");

    // An empty direction removes it.
    await call("PATCH", `/api/items/${LINE}`, { direction: "" });
    expect((await baseOf(call)).direction).toBeUndefined();
    await generateLine(call);
    expect(requests.at(-1)?.direction).toBeUndefined();
  });

  test("refuses these fields on an SFX, and a bad value", async () => {
    const call = makeApp(fakeProviders().providers);
    expect((await call("PATCH", "/api/items/s1-waves", { direction: "x" })).status).toBe(400);
    expect((await call("PATCH", `/api/items/${LINE}`, { voiceSettings: "loud" })).status).toBe(400);
    expect((await call("PATCH", `/api/items/${LINE}`, { voiceSettings: [] })).status).toBe(400);
  });
});

describe("generation history", () => {
  test("a generation appends the line's own fields", async () => {
    const call = makeApp(fakeProviders().providers);
    await call("PATCH", `/api/items/${LINE}`, { voiceSettings: { style: 0.3 } });
    await generateLine(call);
    const entry = (await readTakes(project)).find((e) => e.item === LINE);
    expect(entry).toMatchObject({
      provider: "fake",
      line: "Is anyone up there?",
      direction: "shouting against the wind",
      voiceSettings: { style: 0.3 },
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      speakerSettings: { stability: 0.4, similarity: 0.8 },
    });
  });
});

describe("POST /api/items/:id/trials", () => {
  test("without confirm it returns the plan and generates nothing", async () => {
    const { providers, requests } = fakeProviders();
    const call = makeApp(providers);
    const response = await call("POST", `/api/items/${LINE}/trials`, {
      base: await baseOf(call),
      direction: "softly",
    });
    expect(response.status).toBe(200);
    const body = await json<GeneratePlanResponse>(response);
    expect(body.kind).toBe("plan");
    expect(body.plan.items.map((i) => i.status)).toEqual(["to-generate"]);
    expect(requests).toEqual([]);
    expect(await readTakes(project)).toEqual([]);
  });

  test("generates one asset and leaves scenario.yaml unchanged", async () => {
    const { providers, requests } = fakeProviders();
    const call = makeApp(providers);
    const before = await scenarioText();
    const response = await call("POST", `/api/items/${LINE}/trials`, {
      base: await baseOf(call),
      direction: "softly",
      voiceSettings: { style: 0.5 },
      confirm: true,
    });
    expect(response.status).toBe(200);
    const body = await json<TrialResponse>(response);
    expect(body.kind).toBe("trial");
    expect(body.url).toMatch(/^\/assets\//);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.direction).toBe("softly");
    expect(requests[0]?.settings).toMatchObject({ stability: 0.4, style: 0.5 });
    expect(await scenarioText()).toBe(before);
    const entries = await readTakes(project);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ trial: true, key: body.key, take: body.take });
    expect((await takes(call)).map((t) => t.trial)).toEqual([true]);
  });

  test("trying the same proposal twice gives two takes", async () => {
    const call = makeApp(fakeProviders().providers, { proposalReason: () => "Softer" });
    const request = async () =>
      json<TrialResponse>(
        await call("POST", `/api/items/${LINE}/trials`, {
          base: await baseOf(call),
          direction: "softly",
          proposalId: "p1",
          confirm: true,
        }),
      );
    const first = await request();
    const second = await request();
    expect(second.take).toBe(first.take + 1);
    expect(second.key).not.toBe(first.key);
    expect((await takes(call)).filter((t) => t.proposalId === "p1")).toHaveLength(2);
  });

  test("a failed trial changes nothing", async () => {
    const call = makeApp(fakeProviders("fake", { fail: true }).providers);
    const before = await scenarioText();
    const response = await call("POST", `/api/items/${LINE}/trials`, {
      base: await baseOf(call),
      direction: "softly",
      confirm: true,
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("provider is down");
    expect(text).not.toContain(dir);
    expect(await scenarioText()).toBe(before);
    expect(await readTakes(project)).toEqual([]);
    expect(await takes(call)).toEqual([]);
  });

  test("a stale base is 409 and generates nothing", async () => {
    const { providers, requests } = fakeProviders();
    const call = makeApp(providers);
    const base = await baseOf(call);
    await call("PATCH", `/api/items/${LINE}`, { text: "Hello?" });
    const response = await call("POST", `/api/items/${LINE}/trials`, {
      base,
      direction: "softly",
      confirm: true,
    });
    expect(response.status).toBe(409);
    expect((await json<ApiError>(response)).error).toBe("stale");
    expect(requests).toEqual([]);
    expect(await readTakes(project)).toEqual([]);
  });

  test("a paid provider needs the approved cost to confirm", async () => {
    const { providers, requests } = fakeProviders("fake", { paid: true });
    const call = makeApp(providers);
    const body = { base: await baseOf(call), direction: "softly", confirm: true };
    const refused = await call("POST", `/api/items/${LINE}/trials`, body);
    expect(refused.status).toBe(409);
    const error = await json<ConfirmRequiredError>(refused);
    expect(error.error).toBe("confirm-required");
    expect(requests).toEqual([]);
    const ok = await call("POST", `/api/items/${LINE}/trials`, {
      ...body,
      approved: error.plan.plan.cost,
    });
    expect(ok.status).toBe(200);
    expect(requests).toHaveLength(1);
  });

  test("an unknown item is 404, and an SFX is 400", async () => {
    const call = makeApp(fakeProviders().providers);
    const base = await baseOf(call);
    expect((await call("POST", "/api/items/nope/trials", { base })).status).toBe(404);
    expect((await call("POST", "/api/items/s1-waves/trials", { base })).status).toBe(400);
  });
});

describe("restore", () => {
  test("a version without an override removes the key tried since, plans no generation, and plays that asset", async () => {
    const { providers, requests } = fakeProviders();
    const call = makeApp(providers);
    await generateLine(call);
    const [original] = await takes(call);
    if (!original) throw new Error("expected a take");

    // Keep an override, and generate with it.
    await call("PATCH", `/api/items/${LINE}`, { voiceSettings: { style: 0.3 } });
    await generateLine(call);
    const listed = await takes(call);
    expect(listed).toHaveLength(2);
    expect(listed.find((t) => t.key === original.key)).toMatchObject({
      canUse: true,
      current: false,
    });
    const count = requests.length;

    const response = await call("PATCH", `/api/items/${LINE}`, {
      restore: { key: original.key, base: await baseOf(call) },
    });
    expect(response.status).toBe(200);
    expect(await scenarioText()).not.toContain("style: 0.3");
    expect((await baseOf(call)).voiceSettings).toBeUndefined();

    // No generation is planned, and the line plays the very asset of the version.
    const plan = await json<GeneratePlanResponse>(
      await call("POST", "/api/generate", { ids: [LINE], dryRun: true }),
    );
    expect(plan.plan.items[0]).toMatchObject({
      status: "cached",
      file: original.url?.replace("/assets/", ""),
    });
    expect(requests).toHaveLength(count);
    expect((await takes(call)).find((t) => t.key === original.key)?.current).toBe(true);
  });

  test("a version made with another provider is listed but cannot be restored, and they agree", async () => {
    const first = makeApp(fakeProviders("fake").providers);
    await generateLine(first);
    const second = makeApp(fakeProviders("elsewhere").providers);
    const [version] = await takes(second);
    expect(version).toMatchObject({
      provider: "fake",
      canUse: false,
      why: { code: "other-provider" },
    });
    const before = await scenarioText();
    const response = await second("PATCH", `/api/items/${LINE}`, {
      restore: { key: version?.key, base: await baseOf(second) },
    });
    expect(response.status).toBe(409);
    expect((await json<ApiError>(response)).error).toBe("stale");
    expect(await scenarioText()).toBe(before);
  });

  test("a version shadowed by a newer asset of another provider cannot be restored", async () => {
    const first = makeApp(fakeProviders("fake").providers);
    await generateLine(first);
    const [version] = await takes(first);
    expect(version?.canUse).toBe(true);
    // The same request made by another provider later: playback picks that one.
    const second = makeApp(fakeProviders("elsewhere").providers);
    await generateLine(second);
    const [again] = (await takes(first)).filter((t) => t.key === version?.key);
    expect(again).toMatchObject({ canUse: false, why: { code: "shadowed" } });
    const before = await scenarioText();
    const response = await first("PATCH", `/api/items/${LINE}`, {
      restore: { key: version?.key, base: await baseOf(first) },
    });
    expect(response.status).toBe(409);
    expect(await scenarioText()).toBe(before);
  });

  test("another voice or other speaker settings cannot be restored", async () => {
    const call = makeApp(fakeProviders().providers);
    await generateLine(call);
    const [version] = await takes(call);
    const original = await scenarioText();

    await writeFile(
      join(project, SCENARIO_FILE),
      original.replace("21m00Tcm4TlvDq8ikWAM", "another"),
    );
    expect((await takes(call)).find((t) => t.key === version?.key)?.why?.code).toBe("other-voice");

    await writeFile(
      join(project, SCENARIO_FILE),
      original.replace("stability: 0.4", "stability: 0.9"),
    );
    expect((await takes(call)).find((t) => t.key === version?.key)?.why?.code).toBe(
      "other-speaker-settings",
    );
    const response = await call("PATCH", `/api/items/${LINE}`, {
      restore: { key: version?.key, base: await baseOf(call) },
    });
    expect(response.status).toBe(409);
  });

  test("a restore with a stale base is 409 and changes nothing", async () => {
    const call = makeApp(fakeProviders().providers);
    await generateLine(call);
    const [version] = await takes(call);
    const base = await baseOf(call);
    await call("PATCH", `/api/items/${LINE}`, { direction: "other" });
    const before = await scenarioText();
    const response = await call("PATCH", `/api/items/${LINE}`, {
      restore: { key: version?.key, base },
    });
    expect(response.status).toBe(409);
    expect((await json<ApiError>(response)).error).toBe("stale");
    expect(await scenarioText()).toBe(before);
  });

  test("an unknown key is 404, and restore cannot be combined with other fields", async () => {
    const call = makeApp(fakeProviders().providers);
    const base = await baseOf(call);
    expect(
      (await call("PATCH", `/api/items/${LINE}`, { restore: { key: "a".repeat(64), base } }))
        .status,
    ).toBe(404);
    expect(
      (
        await call("PATCH", `/api/items/${LINE}`, {
          text: "x",
          restore: { key: "a".repeat(64), base },
        })
      ).status,
    ).toBe(400);
  });

  test("keeping a trial later still records its reason", async () => {
    const reasons = new Map([["p1", "Softer, as the user asked"]]);
    const kept: unknown[] = [];
    const call = makeApp(fakeProviders().providers, {
      proposalReason: (id) => reasons.get(id),
      onTakeKept: (k) => kept.push(k),
    });
    const trial = await json<TrialResponse>(
      await call("POST", `/api/items/${LINE}/trials`, {
        base: await baseOf(call),
        direction: "softly",
        proposalId: "p1",
        confirm: true,
      }),
    );
    // The proposal is gone from the agent's store by the time the user keeps it.
    reasons.clear();
    const response = await call("PATCH", `/api/items/${LINE}`, {
      restore: { key: trial.key, base: await baseOf(call) },
    });
    expect(response.status).toBe(200);
    expect(await scenarioText()).toContain("softly");
    const entries = await readEntries(project);
    expect(entries.some((e) => JSON.stringify(e).includes("Softer, as the user asked"))).toBe(true);
    expect(kept).toEqual([
      {
        itemId: LINE,
        key: trial.key,
        trial: true,
        proposalId: "p1",
        reason: "Softer, as the user asked",
      },
    ]);
  });
});

describe("restore as saved", () => {
  test("a line that reads back with another request is rolled back with 409", async () => {
    const call = makeApp(fakeProviders().providers);
    await generateLine(call);
    const [original] = await takes(call);
    await call("PATCH", `/api/items/${LINE}`, { voiceSettings: { style: 0.3 } });
    await generateLine(call);
    const before = await scenarioText();
    const entries = (await readEntries(project)).length;

    seam.corrupt = true;
    const response = await call("PATCH", `/api/items/${LINE}`, {
      restore: { key: original?.key, base: await baseOf(call) },
    });
    seam.corrupt = false;
    expect(response.status).toBe(409);
    expect((await json<ApiError>(response)).error).toBe("stale");
    expect(await scenarioText()).toBe(before);
    expect((await readEntries(project)).length).toBe(entries);
  });
});

describe("hooks and limits", () => {
  test("a throwing onTakeKept does not fail a saved restore", async () => {
    const call = makeApp(fakeProviders().providers, {
      onTakeKept: () => {
        throw new Error("hook broke");
      },
    });
    await generateLine(call);
    const [original] = await takes(call);
    await call("PATCH", `/api/items/${LINE}`, { voiceSettings: { style: 0.3 } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("PATCH", `/api/items/${LINE}`, {
      restore: { key: original?.key, base: await baseOf(call) },
    });
    spy.mockRestore();
    expect(response.status).toBe(200);
    expect((await baseOf(call)).voiceSettings).toBeUndefined();
  });

  test("the trial key is that of the generated asset", async () => {
    const call = makeApp(fakeProviders().providers);
    const trial = await json<TrialResponse>(
      await call("POST", `/api/items/${LINE}/trials`, {
        base: await baseOf(call),
        direction: "softly",
        confirm: true,
      }),
    );
    expect((await takes(call)).map((t) => t.key)).toEqual([trial.key]);
  });

  test("trial text over 500 characters and direction over 300 are 400", async () => {
    const call = makeApp(fakeProviders().providers);
    const base = await baseOf(call);
    const post = (extra: object) => call("POST", `/api/items/${LINE}/trials`, { base, ...extra });
    expect((await post({ text: "a".repeat(501) })).status).toBe(400);
    expect((await post({ direction: "a".repeat(301) })).status).toBe(400);
    expect((await post({ text: "a".repeat(500), direction: "a".repeat(300) })).status).toBe(200);
  });
});

describe("bad targets", () => {
  const key = "a".repeat(64);

  test("trials refuse an unknown item, an SFX, and ids with path characters", async () => {
    const call = makeApp(fakeProviders().providers);
    const base = await baseOf(call);
    expect((await call("POST", "/api/items/nope/trials", { base })).status).toBe(404);
    const sfx = await call("POST", "/api/items/s1-waves/trials", { base });
    expect(sfx.status).toBe(400);
    expect((await json<ApiError>(sfx)).message).toContain("only to lines");
    for (const id of ["..%2Fscenario", "a%2Fb", "%2E%2E", "a%00b"]) {
      const response = await call("POST", `/api/items/${id}/trials`, { base });
      expect([400, 404]).toContain(response.status);
    }
  });

  test("restore refuses a bad key, an unknown item, an SFX, and ids with path characters", async () => {
    const call = makeApp(fakeProviders().providers);
    const base = await baseOf(call);
    const before = await scenarioText();
    for (const bad of ["short", "G".repeat(64), "../x", 5]) {
      expect(
        (await call("PATCH", `/api/items/${LINE}`, { restore: { key: bad, base } })).status,
      ).toBe(400);
    }
    expect((await call("PATCH", "/api/items/nope", { restore: { key, base } })).status).toBe(404);
    expect((await call("PATCH", "/api/items/s1-waves", { restore: { key, base } })).status).toBe(
      400,
    );
    for (const id of ["..%2Fscenario", "a%2Fb", "%2E%2E", "a%00b"]) {
      const response = await call("PATCH", `/api/items/${id}`, { restore: { key, base } });
      expect([400, 404]).toContain(response.status);
    }
    expect(await scenarioText()).toBe(before);
  });
});

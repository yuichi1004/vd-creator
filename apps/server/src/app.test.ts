import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSETS_DIR } from "@vd-creator/core";
import { importEntry, initLibrary } from "@vd-creator/library";
import { SCENARIO_FILE } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  ApiError,
  ConfirmRequiredError,
  GeneratePlanResponse,
  GenerateRunResponse,
  LibraryResponse,
  ProjectResponse,
  VerifyLibraryEntryResponse,
} from "./api.js";
import { type AppOptions, createApp, type ServerProviders } from "./app.js";
import { TOKEN_COOKIE } from "./token.js";

const SAMPLE = fileURLToPath(
  new URL("../../../packages/scenario/fixtures/sample.yaml", import.meta.url),
);

/** Items of the sample that a provider generates. */
const GENERATED = ["s1", "s1-waves", "s1-l1", "s1-l2", "s2-l1"];

let dir: string;
let project: string;
let library: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-server-"));
  project = join(dir, "project");
  library = join(dir, "lib");
  await mkdir(project);
  await writeFile(join(project, SCENARIO_FILE), await readFile(SAMPLE, "utf8"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Fake providers that count their calls and record the TTS texts, optionally waiting before
 * each call. Never a real API.
 */
function fakeProviders(paid = false, options: { delayMs?: number } = {}) {
  const calls = { count: 0, texts: [] as string[] };
  const audio = async () => {
    calls.count++;
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    return { data: new Uint8Array([1, 2, 3]), format: "wav" as const, durationSec: 1, meta: {} };
  };
  const cost = () => ({ characters: 1, requests: 1 });
  const providers: ServerProviders = {
    tts: {
      id: "fake",
      paid,
      estimate: cost,
      synthesize: (req) => {
        calls.texts.push(req.text);
        return audio();
      },
    },
    sfx: { id: "fake", paid, estimate: cost, generate: audio },
    music: { id: "fake", paid, estimate: cost, generate: audio },
  };
  return { providers, calls };
}

type TestApp = { request(path: string, init?: RequestInit): Promise<Response> };

/** The app, with requests sent as from a browser on `localhost` unless they set `Host`. */
function makeApp(options: Partial<AppOptions> = {}): TestApp {
  const app = createApp({ projectDir: project, provider: fakeProviders().providers, ...options });
  return {
    request: async (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has("Host")) headers.set("Host", "localhost:5310");
      return app.request(path, { ...init, headers });
    },
  };
}

function send(app: TestApp, method: string, path: string, body?: unknown, headers = {}) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function getJson<T>(app: TestApp, path: string): Promise<T> {
  const response = await app.request(path);
  return (await response.json()) as T;
}

async function scenarioText(): Promise<string> {
  return readFile(join(project, SCENARIO_FILE), "utf8");
}

/** Checks the body is fixed text: no absolute path of the test folder. */
async function errorBody(response: Response): Promise<ApiError> {
  const text = await response.text();
  expect(text).not.toContain(dir);
  return JSON.parse(text) as ApiError;
}

async function addLibraryEntry() {
  await initLibrary(library, { name: "Test library" });
  const sound = join(dir, "door.wav");
  const evidence = join(dir, "terms.html");
  await writeFile(sound, "RIFF fake wav data");
  await writeFile(evidence, "<html>CC BY 4.0</html>");
  return importEntry(library, sound, {
    kind: "sfx",
    id: "door-creak-01",
    license: "CC-BY-4.0",
    title: "Old wooden door creak",
    tags: ["door", "wood"],
    url: "https://example.com/sounds/1",
    author: "Jane Doe",
    attribution: '"Old door" by Jane Doe, CC BY 4.0',
    date: "2026-10-29",
    evidence,
  });
}

describe("GET /api/project", () => {
  test("returns the scenario, timeline, provider, and whether there is a library", async () => {
    const response = await makeApp().request("/api/project");
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProjectResponse;
    expect(body.scenario?.title).toBe("The Lighthouse Keeper");
    expect(body.timeline).toBeDefined();
    expect(body.issues).toEqual([]);
    expect(body.licenseIssues).toEqual([]);
    expect(body.provider).toEqual({ id: "fake", paid: false });
    expect(body.library).toBe(false);
    const withLibrary = await getJson<ProjectResponse>(makeApp({ library }), "/api/project");
    expect(withLibrary.library).toBe(true);
  });

  test("returns the issues of an invalid scenario, without a scenario", async () => {
    await writeFile(join(project, SCENARIO_FILE), "version: 1\ntitle: [\n");
    const body = await getJson<ProjectResponse>(makeApp(), "/api/project");
    expect(body.scenario).toBeUndefined();
    expect(body.timeline).toBeUndefined();
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test("reports a missing scenario.yaml with fixed text", async () => {
    await rm(join(project, SCENARIO_FILE));
    const response = await makeApp().request("/api/project");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(dir);
    expect((JSON.parse(text) as ProjectResponse).scenario).toBeUndefined();
  });
});

describe("GET /api/events", () => {
  test("streams project-changed events from the event source", async () => {
    const listeners = new Set<(e: { file: "scenario.yaml" | "cache.json" }) => void>();
    const ending = new AbortController();
    const app = makeApp({
      signal: ending.signal,
      events: {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    const response = await app.request("/api/events");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/event-stream/);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(": connected")) text += decoder.decode((await reader.read()).value);
    for (const listener of listeners) listener({ file: "scenario.yaml" });
    while (!text.includes("project-changed")) text += decoder.decode((await reader.read()).value);
    expect(text).toContain('event: project-changed\ndata: {"file":"scenario.yaml"}');
    ending.abort();
    await reader.cancel();
  });
});

describe("PATCH /api/items/:id", () => {
  test("edits a line and keeps the comments in scenario.yaml", async () => {
    const response = await send(makeApp(), "PATCH", "/api/items/s1-l1", {
      text: "Hello?",
      take: 3,
      gapBeforeSec: 0.5,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProjectResponse;
    expect(JSON.stringify(body.scenario)).toContain("Hello?");
    const text = await scenarioText();
    expect(text).toContain('line: "Hello?"');
    expect(text).toContain("# TODO: less shouty?");
    expect(text).toContain("# The keeper answers.");
    expect(text).toContain("# Sample scenario that uses every item type.");
  });

  test("sets the source of an SFX to a library entry or a prompt", async () => {
    const app = makeApp();
    let response = await send(app, "PATCH", "/api/items/s1-waves", {
      source: { library: "waves-01" },
    });
    expect(response.status).toBe(200);
    expect(await scenarioText()).toMatch(/library: waves-01/);
    response = await send(app, "PATCH", "/api/items/s1-door", { source: { prompt: "a door" } });
    expect(response.status).toBe(200);
    expect(await scenarioText()).toContain("a door");
  });

  test("returns 404 for an unknown item", async () => {
    const response = await send(makeApp(), "PATCH", "/api/items/nope", { text: "x" });
    expect(response.status).toBe(404);
    expect((await errorBody(response)).error).toBe("not-found");
  });

  test("refuses fields that do not apply to the item, and invalid bodies, with 400", async () => {
    const app = makeApp();
    const before = await scenarioText();
    for (const [id, body] of [
      ["s1-waves", { text: "x" }],
      ["s1-l1", { source: { prompt: "x" } }],
      ["s1-l1", { text: "" }],
      ["s1-l1", { take: -1 }],
      ["s1-l1", { take: 1.5 }],
      ["s1-l1", { gapBeforeSec: "1" }],
      ["s1-l1", { other: 1 }],
      ["s1-l1", { source: { prompt: "x", library: "y" } }],
      ["s1-l1", [1]],
    ] as const) {
      const response = await send(app, "PATCH", `/api/items/${id}`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await errorBody(response)).error).toBe("bad-request");
    }
    expect(await scenarioText()).toBe(before);
  });

  test("refuses a body that is not JSON", async () => {
    const app = makeApp();
    let response = await app.request("/api/items/s1-l1", {
      method: "PATCH",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(response.status).toBe(400);
    response = await app.request("/api/items/s1-l1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
  });

  test("refuses a request from another site", async () => {
    const response = await send(
      makeApp(),
      "PATCH",
      "/api/items/s1-l1",
      { text: "x" },
      {
        "Sec-Fetch-Site": "cross-site",
      },
    );
    expect(response.status).toBe(400);
  });

  test("returns 422 with the scenario issues for an edit that makes it invalid", async () => {
    const before = await scenarioText();
    const response = await send(makeApp(), "PATCH", "/api/items/s1-l1", { speaker: "nobody" });
    expect(response.status).toBe(422);
    const text = await response.text();
    expect(text).not.toContain(dir);
    expect(text).not.toMatch(/\bat \S+:\d+/);
    expect(await scenarioText()).toBe(before);
  });
});

describe("PATCH /api/scenes/:id", () => {
  test("sets the BGM volume and keeps the comments", async () => {
    const response = await send(makeApp(), "PATCH", "/api/scenes/s1", { volume: 0.5 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProjectResponse;
    expect(body.scenario?.scenes[0]?.bgm).toEqual({ prompt: "quiet piano, rain", volume: 0.5 });
    const text = await scenarioText();
    expect(text).toContain("volume: 0.5");
    expect(text).toContain("# The keeper answers.");
    expect(text).toContain("# BGM from the shared library");
  });

  test("replaces the BGM source and keeps the volume", async () => {
    const response = await send(makeApp(), "PATCH", "/api/scenes/s1", {
      bgm: { library: "piano-01" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProjectResponse;
    expect(body.scenario?.scenes[0]?.bgm).toEqual({ library: "piano-01", volume: 0.3 });
    expect(await scenarioText()).toContain("# yaml-language-server");
  });

  test("switching a BGM between library and prompt keeps the source's comments", async () => {
    const withComment = (await scenarioText()).replace(
      '      prompt: "quiet piano, rain"\n',
      '      # Placeholder until the score is done\n      prompt: "quiet piano, rain" # Keep it soft\n',
    );
    await writeFile(join(project, SCENARIO_FILE), withComment);
    const app = makeApp();
    let response = await send(app, "PATCH", "/api/scenes/s1", { bgm: { library: "piano-01" } });
    expect(response.status).toBe(200);
    let text = await scenarioText();
    expect(text).toMatch(
      /# Placeholder until the score is done\n\s+library: piano-01 # Keep it soft\n/,
    );
    expect(text).not.toContain("quiet piano");

    response = await send(app, "PATCH", "/api/scenes/s2", { bgm: { prompt: "low hum" } });
    expect(response.status).toBe(200);
    text = await scenarioText();
    expect(text).toMatch(/prompt: low hum # BGM from the shared library\n/);
    expect(text).not.toContain("ambient-hum-low");
    const body = (await response.json()) as ProjectResponse;
    expect(body.scenario?.scenes[1]?.bgm).toMatchObject({ prompt: "low hum" });

    response = await send(app, "PATCH", "/api/scenes/s2", { bgm: { library: "hum-02" } });
    expect(response.status).toBe(200);
    expect(await scenarioText()).toMatch(/library: hum-02 # BGM from the shared library\n/);
  });

  test("adds a BGM to a scene without one", async () => {
    const text = (await scenarioText()).replace(
      '    bgm:\n      prompt: "quiet piano, rain"\n      volume: 0.3\n',
      "",
    );
    await writeFile(join(project, SCENARIO_FILE), text);
    const app = makeApp();
    expect((await send(app, "PATCH", "/api/scenes/s1", { volume: 0.4 })).status).toBe(422);
    const response = await send(app, "PATCH", "/api/scenes/s1", {
      bgm: { prompt: "strings" },
      volume: 0.4,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProjectResponse;
    expect(body.scenario?.scenes[0]?.bgm).toEqual({ prompt: "strings", volume: 0.4 });
  });

  test("returns 404 for an unknown scene and 400 for an invalid body", async () => {
    const app = makeApp();
    expect((await send(app, "PATCH", "/api/scenes/nope", { volume: 0.5 })).status).toBe(404);
    for (const body of [{}, { volume: 2 }, { volume: "1" }, { bgm: {} }, { title: "x" }]) {
      const response = await send(app, "PATCH", "/api/scenes/s1", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await errorBody(response);
    }
  });
});

describe("POST /api/generate", () => {
  test("a dry run returns the plan and never generates", async () => {
    for (const paid of [false, true]) {
      const { providers, calls } = fakeProviders(paid);
      const app = makeApp({ provider: providers });
      for (const confirm of [undefined, true]) {
        const response = await send(app, "POST", "/api/generate", { dryRun: true, confirm });
        expect(response.status).toBe(200);
        const body = (await response.json()) as GeneratePlanResponse;
        expect(body.kind).toBe("plan");
        expect(body.provider).toEqual({ id: "fake", paid });
        const toGenerate = body.plan.items.filter((i) => i.status === "to-generate");
        expect(toGenerate.map((i) => i.id).sort()).toEqual([...GENERATED].sort());
      }
      expect(calls.count).toBe(0);
    }
  });

  test("a paid provider without confirm returns 409 with the plan and makes no call", async () => {
    const { providers, calls } = fakeProviders(true);
    const app = makeApp({ provider: providers });
    for (const body of [{}, { confirm: false }, { ids: ["s1-l1"] }]) {
      const response = await send(app, "POST", "/api/generate", body);
      expect(response.status).toBe(409);
      const error = (await response.json()) as ConfirmRequiredError;
      expect(error.error).toBe("confirm-required");
      expect(error.plan.kind).toBe("plan");
      expect(error.plan.provider.paid).toBe(true);
      expect(error.plan.plan.items.length).toBeGreaterThan(0);
    }
    expect(calls.count).toBe(0);
  });

  test("a paid provider generates with confirm", async () => {
    const { providers, calls } = fakeProviders(true);
    const response = await send(makeApp({ provider: providers }), "POST", "/api/generate", {
      ids: ["s1-l1"],
      confirm: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as GenerateRunResponse;
    expect(body.kind).toBe("run");
    expect(body.failed).toBe(0);
    expect(body.items.map((i) => [i.id, i.status])).toEqual([["s1-l1", "generated"]]);
    expect(calls.count).toBe(1);
  });

  test("a free provider generates and ignores confirm", async () => {
    const { providers, calls } = fakeProviders(false);
    const app = makeApp({ provider: providers });
    const response = await send(app, "POST", "/api/generate", { confirm: false });
    expect(response.status).toBe(200);
    const body = (await response.json()) as GenerateRunResponse;
    expect(body.items.filter((i) => i.status === "generated")).toHaveLength(GENERATED.length);
    expect(calls.count).toBe(GENERATED.length);
    const project = await getJson<ProjectResponse>(app, "/api/project");
    expect(project.timeline).toBeDefined();
  });

  test("reports a failed item with the error's message only", async () => {
    const { providers } = fakeProviders(false);
    providers.tts = {
      ...providers.tts,
      synthesize: async () => {
        throw new Error(`secret failure in ${dir}`);
      },
    };
    const response = await send(makeApp({ provider: providers }), "POST", "/api/generate", {
      ids: ["s1-l1"],
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(dir);
    const body = JSON.parse(text) as GenerateRunResponse;
    expect(body.failed).toBe(1);
    expect(body.items[0]).toMatchObject({ id: "s1-l1", status: "failed" });
  });

  test("a run queued behind a PATCH generates the edited scenario", async () => {
    const { providers, calls } = fakeProviders(false, { delayMs: 100 });
    const app = makeApp({ provider: providers });
    const first = send(app, "POST", "/api/generate", { ids: ["s1-l1"] });
    // Let the first run take the queue before the edit and the second run are sent.
    await new Promise((r) => setTimeout(r, 30));
    const edit = send(app, "PATCH", "/api/items/s1-l2", { text: "Edited while busy" });
    await new Promise((r) => setTimeout(r, 10));
    const second = send(app, "POST", "/api/generate", { ids: ["s1-l2"] });
    expect((await first).status).toBe(200);
    expect((await edit).status).toBe(200);
    const response = await second;
    expect(response.status).toBe(200);
    expect(calls.texts).toEqual(["Is anyone up there?", "Edited while busy"]);
  });

  test("refuses empty ids, unknown ids, and invalid fields with 400", async () => {
    const { providers, calls } = fakeProviders(false);
    const app = makeApp({ provider: providers });
    for (const body of [
      { ids: [] },
      { ids: ["nope"] },
      { ids: "s1-l1" },
      { ids: [1] },
      { dryRun: "yes" },
      { confirm: 1 },
      { other: true },
    ]) {
      const response = await send(app, "POST", "/api/generate", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await errorBody(response)).error).toBe("bad-request");
    }
    expect(calls.count).toBe(0);
  });

  test("returns 422 for an invalid scenario", async () => {
    await writeFile(join(project, SCENARIO_FILE), "version: 1\n");
    const response = await send(makeApp(), "POST", "/api/generate", { dryRun: true });
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain(dir);
  });
});

describe("library routes", () => {
  test("return 404 without a library", async () => {
    const app = makeApp();
    for (const response of [
      await app.request("/api/library"),
      await send(app, "POST", "/api/library/sfx/door-creak-01/verify", { confirm: true }),
      await app.request("/library-files/sfx/door-creak-01"),
    ]) {
      expect(response.status).toBe(404);
      expect((await errorBody(response)).error).toBe("not-found");
    }
  });

  test("GET /api/library searches entries", async () => {
    await addLibraryEntry();
    const app = makeApp({ library });
    let response = await app.request("/api/library?q=door");
    expect(response.status).toBe(200);
    let body = (await response.json()) as LibraryResponse;
    expect(body.name).toBe("Test library");
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      id: "door-creak-01",
      kind: "sfx",
      title: "Old wooden door creak",
      license: { id: "CC-BY-4.0", verified: false },
    });
    expect(body.entries[0]?.licenseTerms).toBeDefined();
    expect(JSON.stringify(body)).not.toContain(dir);

    body = await getJson<LibraryResponse>(app, "/api/library?kind=bgm");
    expect(body.entries).toEqual([]);
    response = await app.request("/api/library?kind=nope");
    expect(response.status).toBe(400);
  });

  test("POST /api/library/:kind/:id/verify verifies an entry with confirm", async () => {
    await addLibraryEntry();
    const app = makeApp({ library });
    let response = await send(app, "POST", "/api/library/sfx/door-creak-01/verify", {});
    expect(response.status).toBe(400);
    response = await send(app, "POST", "/api/library/sfx/door-creak-01/verify", {
      confirm: true,
      approveCommercial: "yes",
    });
    expect(response.status).toBe(400);

    response = await send(app, "POST", "/api/library/sfx/door-creak-01/verify", {
      confirm: true,
      approveCommercial: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as VerifyLibraryEntryResponse;
    expect(body.verified).toBe(true);
    expect(body.entry.license).toMatchObject({ verified: true, approvedFor: "commercial" });

    response = await send(app, "POST", "/api/library/sfx/nope/verify", { confirm: true });
    expect(response.status).toBe(404);
    response = await send(app, "POST", "/api/library/nope/door-creak-01/verify", {
      confirm: true,
    });
    expect(response.status).toBe(404);
  });

  test("verify answers verified: false with fixed text when the library refuses", async () => {
    const { entry } = await addLibraryEntry();
    await rm(join(library, entry.entry.license.evidence ?? ""));
    const response = await send(
      makeApp({ library }),
      "POST",
      "/api/library/sfx/door-creak-01/verify",
      {
        confirm: true,
      },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(dir);
    const body = JSON.parse(text) as VerifyLibraryEntryResponse;
    expect(body.verified).toBe(false);
    expect(body.message).toBe("The entry was not verified; run vd library check");
  });

  test("GET /library-files/:kind/:id serves the entry's sound file", async () => {
    await addLibraryEntry();
    const response = await makeApp({ library }).request("/library-files/sfx/door-creak-01");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await response.text()).toBe("RIFF fake wav data");
  });

  test("GET /library-files/ refuses paths outside the library, also through a symlink", async () => {
    const { entry } = await addLibraryEntry();
    const app = makeApp({ library });
    for (const path of [
      "/library-files/sfx/..%2F..%2Fproject%2Fscenario.yaml",
      "/library-files/sfx/%2E%2E",
      "/library-files/../project/scenario.yaml",
      "/library-files/sfx/nope",
      "/library-files/nope/door-creak-01",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain("version: 1");
    }

    const secret = join(dir, "secret.wav");
    await writeFile(secret, "secret");
    const file = join(library, entry.dir, entry.entry.file);
    await rm(file);
    await symlink(secret, file);
    const response = await app.request("/library-files/sfx/door-creak-01");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("secret");
  });
});

describe("GET /assets/*", () => {
  beforeEach(async () => {
    await mkdir(join(project, ASSETS_DIR, "images"), { recursive: true });
    await writeFile(join(project, ASSETS_DIR, "images", "shore.svg"), "<svg/>");
  });

  test("serves a file in assets/, sandboxed", async () => {
    const response = await makeApp().request("/assets/images/shore.svg");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("<svg/>");
  });

  test("refuses paths outside assets/", async () => {
    const app = makeApp();
    for (const path of [
      "/assets/../scenario.yaml",
      "/assets/%2E%2E/scenario.yaml",
      "/assets/%2e%2e%2fscenario.yaml",
      "/assets/images/..%2F..%2Fscenario.yaml",
      "/assets/images%5C..%5C..%5Cscenario.yaml",
      "/assets//etc/passwd",
      "/assets/images",
      "/assets/missing.wav",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain("version: 1");
    }
  });

  test("refuses a symlink that leaves assets/", async () => {
    await symlink(join(project, SCENARIO_FILE), join(project, ASSETS_DIR, "link.yaml"));
    await symlink(dir, join(project, ASSETS_DIR, "up"));
    const app = makeApp();
    for (const path of ["/assets/link.yaml", "/assets/up/project/scenario.yaml"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain("version: 1");
    }
  });
});

describe("GET /* (web UI)", () => {
  let webDir: string;

  beforeEach(async () => {
    webDir = join(dir, "web");
    await mkdir(join(webDir, "ui"), { recursive: true });
    await writeFile(join(webDir, "index.html"), "<!doctype html>");
    await writeFile(join(webDir, "ui", "app.js"), "console.log(1)");
  });

  test("serves index.html and the ui/ files of the built UI from webDir", async () => {
    const app = makeApp({ webDir });
    let response = await app.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await response.text()).toBe("<!doctype html>");
    response = await app.request("/index.html");
    expect(response.status).toBe(200);
    response = await app.request("/ui/app.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/javascript/);
    expect(await response.text()).toBe("console.log(1)");
  });

  test("never serves the UI for /api/, /assets/, or /library-files/, nor outside webDir", async () => {
    await writeFile(join(webDir, "secret.txt"), "web file");
    for (const prefix of ["api", "assets", "library-files"]) {
      await mkdir(join(webDir, prefix), { recursive: true });
      await writeFile(join(webDir, prefix, "x.txt"), "web file");
    }
    await symlink(join(project, SCENARIO_FILE), join(webDir, "ui", "link.yaml"));
    const app = makeApp({ webDir });
    for (const path of [
      "/api/x.txt",
      "/assets/x.txt",
      "/library-files/x.txt",
      "/missing.js",
      "/../project/scenario.yaml",
      "/ui/%2E%2E/%2E%2E/project/scenario.yaml",
      "/ui/link.yaml",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      const text = await response.text();
      expect(text).not.toContain("web file");
      expect(text).not.toContain("version: 1");
    }
  });

  test("returns JSON 404 without webDir and for unknown API routes", async () => {
    const app = makeApp();
    for (const path of ["/", "/api/nope"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect((await errorBody(response)).error).toBe("not-found");
    }
  });
});

describe("Host check without a token", () => {
  test("accepts loopback names, .ts.net names, and allowedHosts, with or without a port", async () => {
    const app = makeApp({ allowedHosts: ["Studio.Example"] });
    for (const host of [
      "localhost",
      "localhost:5310",
      "LOCALHOST:5310",
      "127.0.0.1",
      "127.0.0.1:5310",
      "[::1]",
      "[::1]:5310",
      "pc.tail1234.ts.net",
      "PC.Tail1234.TS.NET:443",
      "studio.example",
      "studio.example:8080",
    ]) {
      const response = await app.request("/api/project", { headers: { Host: host } });
      expect(response.status, host).toBe(200);
    }
  });

  test("refuses any other Host with 403 and a fixed body, on every route", async () => {
    const webDir = join(dir, "web");
    await mkdir(webDir);
    await writeFile(join(webDir, "index.html"), "<!doctype html>");
    await mkdir(join(project, ASSETS_DIR));
    await writeFile(join(project, ASSETS_DIR, "a.wav"), "RIFF");
    const { providers, calls } = fakeProviders(true);
    const app = makeApp({ webDir, provider: providers, allowedHosts: ["studio.example"] });
    const before = await scenarioText();
    for (const host of [
      "evil.example",
      "evil.example:5310",
      "localhost.evil.example",
      "127.0.0.1.evil.example",
      "ts.net",
      "evil-ts.net",
      "127.0.0.2",
      "[::2]",
      "studio.example.evil",
      "localhost:",
      "localhost:abc",
      "localhost:5310:1",
      "[::1",
      "user@localhost",
      "localhost/x",
      "",
    ]) {
      const headers = { Host: host };
      for (const response of [
        await app.request("/api/project", { headers }),
        await app.request("/api/events", { headers }),
        await app.request("/", { headers }),
        await app.request("/assets/a.wav", { headers }),
        await send(app, "PATCH", "/api/items/s1-l1", { text: "pwned" }, headers),
        await send(app, "POST", "/api/generate", { confirm: true }, headers),
      ]) {
        expect(response.status, host).toBe(403);
        const body = await errorBody(response);
        expect(body.error).toBe("unauthorized");
        expect(JSON.stringify(body)).not.toContain(host || "\u0000");
      }
    }
    expect(calls.count).toBe(0);
    expect(await scenarioText()).toBe(before);
  });

  test("refuses a request without a Host header", async () => {
    const app = createApp({ projectDir: project, provider: fakeProviders().providers });
    const response = await app.request("/api/project");
    expect(response.status).toBe(403);
  });

  test("with a token, the token check applies instead", async () => {
    const app = makeApp({ token: "test-token-value" });
    const response = await app.request("/api/project", {
      headers: { Host: "192.168.1.5:5310", Cookie: `${TOKEN_COOKIE}=test-token-value` },
    });
    expect(response.status).toBe(200);
  });
});

describe("token", () => {
  const token = "test-token-value";

  test("requests without the token get 401", async () => {
    const app = makeApp({ token });
    for (const path of ["/api/project", "/assets/x.wav", "/", "/api/project?token=wrong"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(401);
      const body = await errorBody(response);
      expect(body.error).toBe("unauthorized");
      expect(JSON.stringify(body)).not.toContain(token);
    }
    const response = await app.request("/api/project", {
      headers: { Cookie: `${TOKEN_COOKIE}=wrong` },
    });
    expect(response.status).toBe(401);
  });

  test("a valid ?token= sets a cookie and redirects to the page without the token", async () => {
    const app = makeApp({ token });
    let response = await app.request(`/?token=${token}`);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("./");
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`${TOKEN_COOKIE}=${token}`);
    expect(cookie).toContain("HttpOnly");
    // Lax, so that the cookie survives the redirect after a link from another site.
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("SameSite=Strict");
    expect(cookie).not.toContain("Path=");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");

    response = await app.request(`/ui/page.html?a=1&token=${token}&b=2`);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("./page.html?a=1&b=2");
    expect(response.headers.get("Location")).not.toContain(token);
    response = await app.request(`/ui/?token=${token}`);
    expect(response.headers.get("Location")).toBe("./");

    response = await app.request("/api/project", {
      headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
    });
    expect(response.status).toBe(200);
  });

  test("no token is needed when none is set", async () => {
    expect((await makeApp().request("/api/project")).status).toBe(200);
  });
});

test("every response has Referrer-Policy: no-referrer", async () => {
  const webDir = join(dir, "web");
  await mkdir(webDir);
  await writeFile(join(webDir, "index.html"), "<!doctype html>");
  for (const [app, path] of [
    [makeApp({ webDir }), "/"],
    [makeApp(), "/api/project"],
    [makeApp(), "/api/nope"],
    [makeApp(), "/assets/nope.wav"],
    [makeApp({ token: "t" }), "/api/project"],
    [makeApp(), "/api/project?evil"],
  ] as const) {
    const response = await app.request(path);
    expect(response.headers.get("Referrer-Policy"), path).toBe("no-referrer");
  }
  const refused = await makeApp().request("/", { headers: { Host: "evil.example" } });
  expect(refused.headers.get("Referrer-Policy")).toBe("no-referrer");
});

test("errors from unexpected failures are fixed text", async () => {
  const { providers } = fakeProviders(false);
  const broken = { ...providers, tts: { ...providers.tts } };
  Object.defineProperty(broken.tts, "estimate", {
    value: () => {
      throw new Error(`boom at ${dir}`);
    },
  });
  const response = await send(makeApp({ provider: broken }), "POST", "/api/generate", {
    dryRun: true,
  });
  expect(response.status).toBe(500);
  const body = await errorBody(response);
  expect(body).toEqual({ error: "server-error", message: expect.any(String) });
  expect(body.message).not.toContain("boom");
});

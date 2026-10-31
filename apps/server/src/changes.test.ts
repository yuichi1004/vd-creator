import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChangeEntry,
  readEntries,
  reconcile,
  recordAgent,
  type TargetChangeEntry,
} from "@vd-creator/core";
import { SCENARIO_FILE } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChangesResponse, ProjectResponse } from "./api.js";
import { createApp, type ServerProviders } from "./app.js";
import { changedSinceReview } from "./changes.js";
import { type RunningServer, startServer } from "./server.js";

const SAMPLE = fileURLToPath(
  new URL("../../../packages/scenario/fixtures/sample.yaml", import.meta.url),
);

let dir: string;
let sample: string;
let running: RunningServer | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-server-changes-"));
  sample = await readFile(SAMPLE, "utf8");
  await writeFile(join(dir, SCENARIO_FILE), sample);
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** Fake providers; never a real API. The ID `mock` makes draft audio. */
function providers(id = "fake", paid = false): ServerProviders {
  const audio = async () => ({
    data: new Uint8Array([1, 2, 3]),
    format: "wav" as const,
    durationSec: 1,
    meta: {},
  });
  const cost = () => ({ characters: 1, requests: 1 });
  return {
    tts: { id, paid, estimate: cost, synthesize: audio },
    sfx: { id, paid, estimate: cost, generate: audio },
    music: { id, paid, estimate: cost, generate: audio },
  };
}

function request(app: ReturnType<typeof createApp>, method: string, path: string, init = {}) {
  const { body, headers, ...rest } = init as {
    body?: unknown;
    headers?: Record<string, string>;
  };
  return app.request(path, {
    method,
    headers: { Host: "localhost:5310", "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...rest,
  });
}

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

const targetEntries = (entries: ChangeEntry[]) =>
  entries.filter((e): e is TargetChangeEntry => e.source === "ui" || e.source === "file");

const writeScenario = (text: string) => writeFile(join(dir, SCENARIO_FILE), text);

describe("ui entries", () => {
  test("a PATCH writes one ui entry per field with the session ID, and no file entry", async () => {
    const app = createApp({ projectDir: dir, provider: providers() });
    const response = await request(app, "PATCH", "/api/items/s1-l1", {
      body: { text: "Hello?", gapBeforeSec: 0.5 },
      headers: { "X-VD-Session": "phone-1" },
    });
    expect(response.status).toBe(200);
    const entries = await readEntries(dir);
    expect(entries.map((e) => e.source)).toEqual(["ui", "ui"]);
    const [first, second] = targetEntries(entries);
    expect(first).toMatchObject({
      target: { kind: "item", id: "s1-l1" },
      change: "edited",
      field: "line",
      old: "Is anyone up there?",
      new: "Hello?",
      session: "phone-1",
    });
    expect(second).toMatchObject({ field: "gapBeforeSec", new: 0.5, session: "phone-1" });
    expect(first?.time).toBe(second?.time);
  });

  test("a scene PATCH is recorded too", async () => {
    const app = createApp({ projectDir: dir, provider: providers() });
    await request(app, "PATCH", "/api/scenes/s1", { body: { volume: 0.5 } });
    const [entry] = targetEntries(await readEntries(dir));
    expect(entry).toMatchObject({ source: "ui", target: { kind: "scene", id: "s1" } });
  });

  test("a bad session header is refused", async () => {
    const app = createApp({ projectDir: dir, provider: providers() });
    const response = await request(app, "PATCH", "/api/items/s1-l1", {
      body: { text: "x" },
      headers: { "X-VD-Session": "bad id!" },
    });
    expect(response.status).toBe(400);
  });

  test("an outside edit that the watcher has not seen is recorded as file before a PATCH", async () => {
    await reconcile(dir);
    const app = createApp({ projectDir: dir, provider: providers() });
    await writeScenario(sample.replace('line: "..."', 'line: "Hello"'));
    await request(app, "PATCH", "/api/items/s1-l1", { body: { text: "Hi" } });
    const entries = targetEntries(await readEntries(dir));
    expect(entries.map((e) => [e.source, e.target.id, e.id])).toEqual([
      ["file", "s1-l2", 1],
      ["ui", "s1-l1", 2],
    ]);
  });
});

describe("with a server", () => {
  const edited = () => sample.replace('line: "..."', 'line: "Hello"');

  test("an outside edit of scenario.yaml writes file entries", async () => {
    running = await startServer({ projectDir: dir, provider: providers(), port: 0 });
    await writeScenario(edited());
    await vi.waitFor(async () => {
      expect(targetEntries(await readEntries(dir))).toHaveLength(1);
    });
    const [entry] = targetEntries(await readEntries(dir));
    expect(entry).toMatchObject({ source: "file", target: { id: "s1-l2" }, field: "line" });
    // The page then sees the mark.
    const project = (await (
      await fetch(new URL("api/project", running.url))
    ).json()) as ProjectResponse;
    expect(project.changedSinceReview).toEqual([{ kind: "item", id: "s1-l2", count: 1 }]);
  });

  test("edits made while the server was stopped are recorded on start", async () => {
    await reconcile(dir);
    await writeScenario(edited());
    running = await startServer({ projectDir: dir, provider: providers(), port: 0 });
    const entries = targetEntries(await readEntries(dir));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "file", target: { id: "s1-l2" } });
  });
});

describe("review and marks", () => {
  test("review clears the marks, and an agent entry after it marks its targets again", async () => {
    await reconcile(dir);
    await writeScenario(sample.replace('line: "..."', 'line: "Hello"'));
    await reconcile(dir);
    const app = createApp({ projectDir: dir, provider: providers() });
    let project = await json<ProjectResponse>(await request(app, "GET", "/api/project"));
    expect(project.changedSinceReview).toEqual([{ kind: "item", id: "s1-l2", count: 1 }]);

    project = await json<ProjectResponse>(
      await request(app, "POST", "/api/changes/review", { body: {} }),
    );
    expect(project.changedSinceReview).toEqual([]);
    const { entries } = await json<ChangesResponse>(await request(app, "GET", "/api/changes"));
    expect(entries).toEqual([]);

    await recordAgent(dir, "Softened the reply");
    project = await json<ProjectResponse>(await request(app, "GET", "/api/project"));
    expect(project.changedSinceReview).toEqual([{ kind: "item", id: "s1-l2", count: 1 }]);
    const after = await json<ChangesResponse>(await request(app, "GET", "/api/changes"));
    expect(after.entries.map((e) => e.source)).toEqual(["agent"]);
  });

  test("GET /api/changes reads from an entry ID, and refuses a bad point", async () => {
    const app = createApp({ projectDir: dir, provider: providers() });
    await request(app, "PATCH", "/api/items/s1-l1", { body: { text: "a", gapBeforeSec: 1 } });
    const { entries } = await json<ChangesResponse>(
      await request(app, "GET", "/api/changes?since=1"),
    );
    expect(entries.map((e) => e.id)).toEqual([2]);
    expect((await request(app, "GET", "/api/changes?since=abc")).status).toBe(400);
  });

  test("GET /api/changes?since=start returns every entry, the first one too", async () => {
    const app = createApp({ projectDir: dir, provider: providers() });
    await request(app, "PATCH", "/api/items/s1-l1", { body: { text: "a", gapBeforeSec: 1 } });
    const { entries } = await json<ChangesResponse>(
      await request(app, "GET", "/api/changes?since=start"),
    );
    expect(entries.map((e) => e.id)).toEqual([1, 2]);
  });

  test("the page's own session is not marked", async () => {
    const app = createApp({ projectDir: dir, provider: providers() });
    const headers = { "X-VD-Session": "me" };
    const patched = await json<ProjectResponse>(
      await request(app, "PATCH", "/api/items/s1-l1", { body: { text: "mine" }, headers }),
    );
    expect(patched.changedSinceReview).toEqual([]);
    const other = await json<ProjectResponse>(await request(app, "GET", "/api/project"));
    expect(other.changedSinceReview).toEqual([{ kind: "item", id: "s1-l1", count: 1 }]);
  });

  test("a speaker and an item with the same ID are marked apart", () => {
    const base = { time: "2026-10-31T09:00:00.000Z", source: "file", change: "edited" } as const;
    const entries = [
      { ...base, id: 1, target: { kind: "item", id: "mira" }, field: "line", new: "a" },
      { ...base, id: 2, target: { kind: "speaker", id: "mira" }, field: "name", new: "b" },
      { ...base, id: 3, target: { kind: "item", id: "mira" }, field: "take", new: 1 },
    ] as const;
    expect(changedSinceReview([...entries])).toEqual([
      { kind: "item", id: "mira", count: 2 },
      { kind: "speaker", id: "mira", count: 1 },
    ]);
  });
});

describe("sessions", () => {
  test("a change without a session is not hidden from a request without one", async () => {
    const app = createApp({ projectDir: dir, provider: providers() });
    const patched = await json<ProjectResponse>(
      await request(app, "PATCH", "/api/items/s1-l1", { body: { text: "anon" } }),
    );
    expect(patched.changedSinceReview).toEqual([{ kind: "item", id: "s1-l1", count: 1 }]);
    const got = await json<ProjectResponse>(await request(app, "GET", "/api/project"));
    expect(got.changedSinceReview).toEqual([{ kind: "item", id: "s1-l1", count: 1 }]);
  });

  test("session IDs never appear in responses; own is set only for the requester", async () => {
    const app = createApp({ projectDir: dir, provider: providers() });
    const secret = "secret-session-id-0123456789abcdef";
    const patch = await request(app, "PATCH", "/api/items/s1-l1", {
      body: { text: "mine" },
      headers: { "X-VD-Session": secret },
    });
    expect(await patch.text()).not.toContain(secret);
    const get = (session?: string) =>
      request(app, "GET", "/api/changes?since=1", {
        headers: session ? { "X-VD-Session": session } : {},
      });
    await request(app, "PATCH", "/api/items/s1-l1", {
      body: { gapBeforeSec: 1 },
      headers: { "X-VD-Session": secret },
    });
    const own = await get(secret);
    const ownText = await own.text();
    expect(ownText).not.toContain(secret);
    expect(JSON.parse(ownText).entries).toEqual([expect.objectContaining({ own: true })]);
    for (const other of [undefined, "another-session"]) {
      const text = await (await get(other)).text();
      expect(text).not.toContain(secret);
      expect(text).not.toContain('"session"');
      expect(text).not.toContain('"own"');
    }
    const project = await (await request(app, "GET", "/api/project")).text();
    expect(project).not.toContain(secret);
  });
});

describe("live updates of the log", () => {
  test("a review or an agent reason reaches the event stream", async () => {
    running = await startServer({ projectDir: dir, provider: providers(), port: 0 });
    const events = await fetch(new URL("api/events", running.url));
    const reader = (events.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    const seen = async (needle: string) => {
      const until = Date.now() + 5000;
      while (!text.includes(needle) && Date.now() < until) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((r) =>
            setTimeout(() => r({ value: undefined, done: true }), 500),
          ),
        ]);
        if (value) text += new TextDecoder().decode(value);
        if (done && !value) continue;
      }
      return text.includes(needle);
    };
    expect(await seen(": connected")).toBe(true);
    text = "";
    const review = await fetch(new URL("api/changes/review", running.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(review.status).toBe(200);
    expect(await seen('"file":"changes.jsonl"')).toBe(true);
    text = "";
    await recordAgent(dir, "Only a reason");
    expect(await seen('"file":"changes.jsonl"')).toBe(true);
    await reader.cancel();
  });
});

describe("the new routes keep the request checks", () => {
  const routes: [string, string, unknown][] = [
    ["GET", "/api/changes", undefined],
    ["POST", "/api/changes/review", {}],
  ];

  test("a mutation must be JSON and not cross-site", async () => {
    const app = createApp({ projectDir: dir, provider: providers() });
    const plain = await app.request("/api/changes/review", {
      method: "POST",
      headers: { Host: "localhost:5310", "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(plain.status).toBe(400);
    const cross = await request(app, "POST", "/api/changes/review", {
      body: {},
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(cross.status).toBe(400);
    expect(await readEntries(dir)).toEqual([]);
  });

  test("a Host that is not allowed is refused", async () => {
    const app = createApp({ projectDir: dir, provider: providers() });
    for (const [method, path, body] of routes) {
      const response = await request(app, method, path, {
        body,
        headers: { Host: "evil.example" },
      });
      expect(response.status).toBe(403);
    }
    expect(await readEntries(dir)).toEqual([]);
  });

  test("with a token, both routes need it", async () => {
    const app = createApp({ projectDir: dir, provider: providers(), token: "tok" });
    for (const [method, path, body] of routes) {
      expect((await request(app, method, path, { body })).status).toBe(401);
      const ok = await request(app, method, path, { body, headers: { Cookie: "vd_token=tok" } });
      expect(ok.status).toBe(200);
    }
  });
});

describe("draft audio", () => {
  test("a mock asset is draft, library and paid assets are final", async () => {
    const mock = createApp({ projectDir: dir, provider: providers("mock") });
    const generate = (app: typeof mock, body: unknown) =>
      request(app, "POST", "/api/generate", { body });
    expect((await generate(mock, { ids: ["s1-l1"] })).status).toBe(200);
    const paid = createApp({ projectDir: dir, provider: providers("fake", true) });
    const plan = await json<{ plan: { cost: { characters: number; requests: number } } }>(
      await generate(paid, { ids: ["s1-l2"], dryRun: true }),
    );
    const run = await generate(paid, { ids: ["s1-l2"], confirm: true, approved: plan.plan.cost });
    expect(run.status).toBe(200);

    const project = await json<ProjectResponse>(await request(mock, "GET", "/api/project"));
    const audio = (id: string) => project.timeline?.items.find((i) => i.id === id)?.audio;
    expect(audio("s1-l1")).toBe("draft");
    expect(audio("s1-l2")).toBe("final");
    expect(audio("s1-door")).toBe("final");
    expect(audio("s2-l1")).toBeNull();
    expect(project.timeline?.bgm.find((b) => b.sceneId === "s2")?.audio).toBe("final");
  });
});

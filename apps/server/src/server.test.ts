import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIO_FILE } from "@vd-creator/scenario";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ServerProviders } from "./app.js";
import { type RunningServer, startServer } from "./server.js";
import { TOKEN_COOKIE } from "./token.js";

const SAMPLE = fileURLToPath(
  new URL("../../../packages/scenario/fixtures/sample.yaml", import.meta.url),
);

let dir: string;
let running: RunningServer | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-server-start-"));
  await writeFile(join(dir, SCENARIO_FILE), await readFile(SAMPLE, "utf8"));
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

function providers(): ServerProviders {
  const audio = async () => {
    throw new Error("not called in these tests");
  };
  const cost = () => ({ characters: 0, requests: 0 });
  return {
    tts: { id: "fake", paid: false, estimate: cost, synthesize: audio },
    sfx: { id: "fake", paid: false, estimate: cost, generate: audio },
    music: { id: "fake", paid: false, estimate: cost, generate: audio },
  };
}

test("listens on 127.0.0.1 without a token by default", async () => {
  running = await startServer({ projectDir: dir, provider: providers(), port: 0 });
  expect(running.url).toBe(`http://127.0.0.1:${running.port}/`);
  expect(running.token).toBeUndefined();
  const response = await fetch(new URL("api/project", running.url));
  expect(response.status).toBe(200);
});

test("needs the token when a host is given, and puts it in the URL", async () => {
  running = await startServer({
    projectDir: dir,
    provider: providers(),
    port: 0,
    host: "127.0.0.1",
  });
  const token = running.token as string;
  expect(token.length).toBeGreaterThanOrEqual(32);
  expect(running.url).toBe(`http://127.0.0.1:${running.port}/?token=${token}`);

  const base = `http://127.0.0.1:${running.port}`;
  const refused = await fetch(`${base}/api/project`);
  expect(refused.status).toBe(401);
  expect(await refused.text()).not.toContain(token);

  const first = await fetch(`${base}/api/project?token=${token}`);
  expect(first.status).toBe(200);
  expect(first.headers.get("Set-Cookie")).toContain(`${TOKEN_COOKIE}=${token}`);
  const later = await fetch(`${base}/api/project`, {
    headers: { Cookie: `${TOKEN_COOKIE}=${token}` },
  });
  expect(later.status).toBe(200);
});

test("each start makes a new token", async () => {
  const a = await startServer({
    projectDir: dir,
    provider: providers(),
    port: 0,
    host: "127.0.0.1",
  });
  const b = await startServer({
    projectDir: dir,
    provider: providers(),
    port: 0,
    host: "127.0.0.1",
  });
  try {
    expect(a.token).not.toBe(b.token);
  } finally {
    await a.close();
    await b.close();
  }
});

test("sends project-changed when scenario.yaml changes, and close ends the stream", async () => {
  running = await startServer({ projectDir: dir, provider: providers(), port: 0 });
  const response = await fetch(new URL("api/events", running.url));
  expect(response.status).toBe(200);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(": connected")) text += decoder.decode((await reader.read()).value);

  const yaml = await readFile(join(dir, SCENARIO_FILE), "utf8");
  await writeFile(join(dir, SCENARIO_FILE), yaml.replace("The Lighthouse Keeper", "Changed"));
  while (!text.includes("project-changed")) text += decoder.decode((await reader.read()).value);
  expect(text).toContain('data: {"file":"scenario.yaml"}');

  await running.close();
  running = undefined;
  let done = false;
  while (!done) done = (await reader.read().catch(() => ({ done: true }))).done;
}, 10_000);

test("rejects when the port is taken", async () => {
  running = await startServer({ projectDir: dir, provider: providers(), port: 0 });
  await expect(
    startServer({ projectDir: dir, provider: providers(), port: running.port }),
  ).rejects.toThrow();
});

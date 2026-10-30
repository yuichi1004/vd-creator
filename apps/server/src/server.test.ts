import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIO_FILE } from "@vd-creator/scenario";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ServerProviders } from "./app.js";
import { type RunningServer, startServer, urlHost } from "./server.js";
import { TOKEN_COOKIE } from "./token.js";
import { WatchError } from "./watcher.js";

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
  expect(running.address).toBe("127.0.0.1");
  const response = await fetch(new URL("api/project", running.url));
  expect(response.status).toBe(200);
});

test("reports the address a host name resolves to", async () => {
  running = await startServer({ projectDir: dir, provider: providers(), port: 0, host: "127.1" });
  expect(running.address).toBe("127.0.0.1");
});

test("without a host, refuses a Host header that is not allowed", async () => {
  running = await startServer({
    projectDir: dir,
    provider: providers(),
    port: 0,
    allowedHosts: ["studio.example"],
  });
  const url = new URL("api/project", running.url);
  expect((await fetch(url)).status).toBe(200);
  // fetch does not let a page set Host, but node's http module does.
  const status = (host: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
  expect(await status("evil.example")).toBe(403);
  expect(await status(`studio.example:${running.port}`)).toBe(200);
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

  const first = await fetch(`${base}/api/project?token=${token}`, { redirect: "manual" });
  expect(first.status).toBe(303);
  expect(first.headers.get("Location")).toBe("./project");
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
  const taken = startServer({ projectDir: dir, provider: providers(), port: running.port });
  await expect(taken).rejects.toMatchObject({ code: "EADDRINUSE" });
  await expect(taken).rejects.not.toBeInstanceOf(WatchError);
});

test("rejects with a WatchError, before listening, when the folder cannot be watched", async () => {
  const missing = join(dir, "missing");
  const started = startServer({ projectDir: missing, provider: providers(), port: 0 });
  await expect(started).rejects.toBeInstanceOf(WatchError);
  await expect(started).rejects.toMatchObject({ code: "ENOENT" });
});

test("urlHost brackets IPv6 addresses and encodes a zone", () => {
  expect(urlHost("127.0.0.1")).toBe("127.0.0.1");
  expect(urlHost("vd.example")).toBe("vd.example");
  expect(urlHost("fd00::20")).toBe("[fd00::20]");
  expect(urlHost("fe80::1%eth0")).toBe("[fe80::1%25eth0]");
  // The zone is split at the first `%`, and reserved characters in it are encoded.
  expect(urlHost("::1%a:b")).toBe("[::1%25a%3Ab]");
  expect(urlHost("fe80::1%a%b/c")).toBe("[fe80::1%25a%25b%2Fc]");
});

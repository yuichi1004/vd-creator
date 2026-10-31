import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSETS_DIR } from "@vd-creator/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ServerInfoResponse } from "./api.js";
import { createApp, type ServerProviders } from "./app.js";
import {
  defaultCacheDir,
  type FfmpegRunner,
  ffmpegOnPath,
  type PreviewOptions,
  parseTempo,
} from "./preview.js";
import { TOKEN_COOKIE } from "./token.js";

const providers: ServerProviders = {
  tts: {
    id: "fake",
    paid: false,
    estimate: () => ({ characters: 0, requests: 0 }),
    synthesize: async () => ({ data: new Uint8Array(), format: "wav", durationSec: 0, meta: {} }),
  },
  sfx: {
    id: "fake",
    paid: false,
    estimate: () => ({ characters: 0, requests: 0 }),
    generate: async () => ({ data: new Uint8Array(), format: "wav", durationSec: 0, meta: {} }),
  },
  music: {
    id: "fake",
    paid: false,
    estimate: () => ({ characters: 0, requests: 0 }),
    generate: async () => ({ data: new Uint8Array(), format: "wav", durationSec: 0, meta: {} }),
  },
};

const RATE = 8000;

/** A mono 16-bit PCM WAV of silence, `seconds` long. */
function wav(seconds: number): Buffer {
  const data = Buffer.alloc(Math.round(seconds * RATE) * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The length of a WAV in seconds, from its sizes. */
function wavSeconds(bytes: Uint8Array): number {
  const buf = Buffer.from(bytes);
  const byteRate = buf.readUInt32LE(28);
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "data") return size / byteRate;
    at += 8 + size;
  }
  throw new Error("no data chunk");
}

let dir: string;
let project: string;
let cache: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-preview-"));
  project = join(dir, "project");
  cache = join(dir, "cache");
  await mkdir(join(project, ASSETS_DIR), { recursive: true });
  await writeFile(join(project, ASSETS_DIR, "line.wav"), wav(2));
  await writeFile(join(project, "scenario.yaml"), "secret: yes\n");
  await writeFile(join(project, ASSETS_DIR, "notes.txt"), "not audio");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The WAV that ffmpeg would make of the 2 s `line.wav` with these arguments. */
function stretched(args: string[]): Buffer {
  const filter = args.find((a) => a.startsWith("atempo=")) ?? "atempo=1";
  return wav(2 / Number(filter.slice("atempo=".length)));
}

/** A runner that writes a few bytes to the output and records its calls. */
function fakeRunner(fail = false) {
  const calls: string[][] = [];
  const runner: FfmpegRunner = async (args, input) => {
    calls.push(args);
    expect(input.length).toBeGreaterThan(0);
    if (fail) {
      // A failure after the output was started.
      await writeFile(args[args.length - 1] as string, "partial");
      throw new Error("ffmpeg failed");
    }
    await writeFile(args[args.length - 1] as string, stretched(args));
  };
  return { calls, runner };
}

function makeApp(preview: PreviewOptions = {}, extra: { token?: string } = {}) {
  const app = createApp({
    projectDir: project,
    provider: providers,
    preview: { cacheDir: cache, ...preview },
    ...extra,
  });
  return (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("Host")) headers.set("Host", "localhost:5310");
    return app.request(path, { ...init, headers });
  };
}

async function cached(): Promise<string[]> {
  return readdir(cache).catch(() => []);
}

describe("parseTempo", () => {
  test("accepts 0.5 to 2.0 in steps of 0.05, compared as text", () => {
    expect(parseTempo("0.5")).toBe(50);
    expect(parseTempo("0.50")).toBe(50);
    expect(parseTempo("1")).toBe(100);
    expect(parseTempo("1.25")).toBe(125);
    expect(parseTempo("1.250")).toBe(125);
    expect(parseTempo("2")).toBe(200);
    expect(parseTempo("2.0")).toBe(200);
  });

  test("refuses everything else", () => {
    for (const bad of [
      undefined,
      "",
      "0.45",
      "0.4",
      "2.05",
      "3",
      "1.01",
      "1.2500000000000001",
      "1.251",
      "-1",
      "1e0",
      " 1",
      "abc",
      "NaN",
      "0x1",
    ]) {
      expect(parseTempo(bad)).toBeUndefined();
    }
  });
});

describe("GET /preview", () => {
  test("returns 400 for a tempo that is missing, repeated, or not allowed", async () => {
    const { runner, calls } = fakeRunner();
    const get = makeApp({ runner });
    for (const query of ["", "?tempo=", "?tempo=0.3", "?tempo=2.5", "?tempo=1.23", "?tempo=x"]) {
      expect((await get(`/preview/line.wav${query}`)).status, query).toBe(400);
    }
    expect((await get("/preview/line.wav?tempo=1.5&tempo=1.5")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("returns the original file at tempo 1 without running ffmpeg", async () => {
    const { runner, calls } = fakeRunner();
    const get = makeApp({ runner });
    const response = await get("/preview/line.wav?tempo=1.00");
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(wav(2));
    expect(calls).toHaveLength(0);
    expect(await cached()).toEqual([]);
  });

  test("refuses paths outside assets/, non-audio files, and symbolic links", async () => {
    const { runner, calls } = fakeRunner();
    const get = makeApp({ runner });
    await symlink(join(project, "scenario.yaml"), join(project, ASSETS_DIR, "link.wav"));
    await symlink(join(project, ASSETS_DIR, "line.wav"), join(project, ASSETS_DIR, "inner.wav"));
    await symlink(join(dir), join(project, ASSETS_DIR, "dirlink"));
    for (const tempo of ["1", "1.5"]) {
      const q = `?tempo=${tempo}`;
      expect((await get(`/preview/../scenario.yaml${q}`)).status).toBe(404);
      expect((await get(`/preview/..%2Fscenario.yaml${q}`)).status).toBe(404);
      expect((await get(`/preview/%2e%2e/scenario.yaml${q}`)).status).toBe(404);
      expect((await get(`/preview/notes.txt${q}`)).status).toBe(400);
      expect((await get(`/preview/link.wav${q}`)).status).toBe(404);
      expect((await get(`/preview/inner.wav${q}`)).status).toBe(404);
      expect((await get(`/preview/dirlink/project/assets/line.wav${q}`)).status).toBe(404);
      expect((await get(`/preview/missing.wav${q}`)).status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  test("makes a copy, then reuses the cached copy without running ffmpeg", async () => {
    const { runner, calls } = fakeRunner();
    const get = makeApp({ runner });
    const first = await get("/preview/line.wav?tempo=2");
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toBe("audio/wav");
    expect(wavSeconds(new Uint8Array(await first.arrayBuffer()))).toBeCloseTo(1, 1);
    expect(calls).toHaveLength(1);

    const args = calls[0] as string[];
    expect(args).toContain("atempo=2.00");
    expect(args.slice(args.indexOf("-f"), args.indexOf("-f") + 4)).toEqual([
      "-f",
      "wav",
      "-i",
      "pipe:0",
    ]);
    expect(args.filter((a) => a.includes("line.wav"))).toEqual([]);

    const second = await get("/preview/line.wav?tempo=2.0");
    expect(second.status).toBe(200);
    expect(calls).toHaveLength(1);
    // Another tempo is another copy.
    expect((await get("/preview/line.wav?tempo=1.25")).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(await cached()).toHaveLength(2);
  });

  test("leaves no file in the cache when a conversion fails, and says nothing about paths", async () => {
    const { runner } = fakeRunner(true);
    const get = makeApp({ runner });
    const response = await get("/preview/line.wav?tempo=1.5");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: "server-error",
      message: "The preview could not be made",
    });
    expect(text).not.toContain(dir);
    expect(await cached()).toEqual([]);
  });

  test("returns 500 and leaves no file when ffmpeg runs past the limit", async () => {
    const runner: FfmpegRunner = async (args, _input, { timeoutMs }) => {
      await writeFile(args[args.length - 1] as string, "partial");
      await new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs));
    };
    const get = makeApp({ runner, timeoutMs: 20 });
    expect((await get("/preview/line.wav?tempo=1.5")).status).toBe(500);
    expect(await cached()).toEqual([]);
  });

  test("runs at most two ffmpeg processes at once", async () => {
    let active = 0;
    let peak = 0;
    const runner: FfmpegRunner = async (args) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      await writeFile(args[args.length - 1] as string, stretched(args));
      active--;
    };
    const get = makeApp({ runner });
    const tempos = ["0.5", "0.75", "1.25", "1.5", "1.75", "2"];
    const responses = await Promise.all(tempos.map((t) => get(`/preview/line.wav?tempo=${t}`)));
    expect(responses.map((r) => r.status)).toEqual(tempos.map(() => 200));
    expect(peak).toBe(2);
  });

  test("shares one conversion between identical requests", async () => {
    const { runner, calls } = fakeRunner();
    const get = makeApp({ runner });
    const responses = await Promise.all([1, 2, 3].map(() => get("/preview/line.wav?tempo=1.5")));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(calls).toHaveLength(1);
  });

  test("removes the oldest copies when the cache is over its limit", async () => {
    const { runner } = fakeRunner();
    const limit = wav(2 / 1.5).length + wav(2 / 1.75).length;
    const get = makeApp({ runner, maxCacheBytes: limit });
    for (const t of ["1.25", "1.5", "1.75"]) {
      expect((await get(`/preview/line.wav?tempo=${t}`)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 15));
    }
    const left = await cached();
    expect(left).toHaveLength(2);
    expect(left.some((name) => name.endsWith("-125.wav"))).toBe(false);
  });

  test("serves a copy larger than the whole cache without keeping it", async () => {
    const { runner } = fakeRunner();
    const get = makeApp({ runner, maxCacheBytes: 1000 });
    const response = await get("/preview/line.wav?tempo=1.25");
    expect(response.status).toBe(200);
    expect(wavSeconds(new Uint8Array(await response.arrayBuffer()))).toBeCloseTo(1.6, 1);
    expect(await cached()).toEqual([]);
  });

  test("two concurrent conversions under a small limit both return 200", async () => {
    const { runner } = fakeRunner();
    const limit = wav(2 / 1.5).length;
    const get = makeApp({ runner, maxCacheBytes: limit });
    const responses = await Promise.all(
      ["1.5", "1.75", "1.25", "2"].map((t) => get(`/preview/line.wav?tempo=${t}`)),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    for (const response of responses) {
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(44);
    }
    const left = await cached();
    expect(left.length).toBeLessThanOrEqual(1);
  });

  test("treats a header-only or far too short WAV as a failed conversion", async () => {
    const results: Buffer[] = [wav(0), wav(0.1)];
    for (const output of results) {
      const runner: FfmpegRunner = async (args) => {
        await writeFile(args[args.length - 1] as string, output);
      };
      const get = makeApp({ runner });
      const response = await get("/preview/line.wav?tempo=1.5");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "server-error",
        message: "The preview could not be made",
      });
      expect(await cached()).toEqual([]);
    }
  });

  test("treats a header-only WAV of an .m4a as a failed conversion", async () => {
    await writeFile(join(project, ASSETS_DIR, "line.m4a"), Buffer.from("not really m4a"));
    const runner: FfmpegRunner = async (args) => {
      await writeFile(args[args.length - 1] as string, wav(0));
    };
    const get = makeApp({ runner });
    expect((await get("/preview/line.m4a?tempo=1.5")).status).toBe(500);
    expect(await cached()).toEqual([]);
  });

  test("refuses a folder swapped for a link between the check and the open", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "line.wav"), wav(2));
    const inside = join(project, ASSETS_DIR, "sub");
    await mkdir(inside);
    await writeFile(join(inside, "line.wav"), wav(2));
    const { runner, calls } = fakeRunner();
    const swap = async () => {
      await rm(inside, { recursive: true });
      await symlink(outside, inside);
    };
    const get = makeApp({ runner, beforeOpen: swap });
    expect((await get("/preview/sub/line.wav?tempo=1.5")).status).toBe(404);
    expect(calls).toHaveLength(0);
    expect(await cached()).toEqual([]);
  });

  test("returns 500 for a tempo other than 1 when ffmpeg is missing", async () => {
    const get = makeApp({ available: false });
    expect((await get("/preview/line.wav?tempo=1.5")).status).toBe(500);
    expect((await get("/preview/line.wav?tempo=1")).status).toBe(200);
  });

  test("needs the token with a host, and never falls back to the web UI", async () => {
    const webDir = join(dir, "web");
    await mkdir(webDir);
    await writeFile(join(webDir, "index.html"), "<p>ui</p>");
    const { runner } = fakeRunner();
    const app = createApp({
      projectDir: project,
      provider: providers,
      token: "t0ken",
      webDir,
      preview: { cacheDir: cache, runner },
    });
    const get = (path: string, headers: Record<string, string> = {}) =>
      app.request(path, { headers: { Host: "localhost:5310", ...headers } });
    expect((await get("/preview/line.wav?tempo=1.5")).status).toBe(401);
    expect((await get("/api/server")).status).toBe(401);
    const cookie = { Cookie: `${TOKEN_COOKIE}=t0ken` };
    expect((await get("/preview/line.wav?tempo=1.5", cookie)).status).toBe(200);
    const missing = await get("/preview/nope.txt?tempo=1.5", cookie);
    expect(missing.status).toBe(400);
    expect(await missing.text()).not.toContain("<p>ui</p>");
    const none = await get("/preview/", cookie);
    expect(none.status).toBe(404);
    expect(await none.text()).not.toContain("<p>ui</p>");
  });
});

describe("GET /api/server", () => {
  test("reports the provider, version, and keepPitch, with no library by default", async () => {
    const get = makeApp({ available: true });
    const response = await get("/api/server");
    expect(response.status).toBe(200);
    const body = (await response.json()) as ServerInfoResponse;
    expect(body).toEqual({
      provider: { id: "fake", paid: false },
      version: expect.any(String),
      preview: { keepPitch: true },
    });
    expect(body).not.toHaveProperty("library");
    expect(JSON.stringify(body)).not.toContain(dir);
  });

  test("reports keepPitch false without ffmpeg", async () => {
    const get = makeApp({ available: false });
    const body = (await (await get("/api/server")).json()) as ServerInfoResponse;
    expect(body.preview).toEqual({ keepPitch: false });
  });
});

describe("helpers", () => {
  test("ffmpegOnPath finds nothing on an empty PATH", () => {
    expect(ffmpegOnPath("")).toBe(false);
    expect(ffmpegOnPath(join(dir, "nowhere"))).toBe(false);
  });

  test("defaultCacheDir follows XDG_CACHE_HOME", () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/x/cache" })).toBe(
      join("/x/cache", "vd-creator", "preview"),
    );
    expect(defaultCacheDir({})).toMatch(/\.cache[\\/]vd-creator[\\/]preview$/);
  });
});

describe.skipIf(!ffmpegOnPath())("with real ffmpeg", () => {
  test("a 2.0 s WAV at tempo 2 comes back about 1.0 s long", async () => {
    const get = makeApp();
    const response = await get("/preview/line.wav?tempo=2");
    expect(response.status).toBe(200);
    expect(wavSeconds(new Uint8Array(await response.arrayBuffer()))).toBeCloseTo(1, 1);
    expect((await cached()).filter((n) => n.endsWith(".wav"))).toHaveLength(1);
    expect((await cached()).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createProviders } from "../index.js";
import type { AudioResult, TtsRequest } from "../types.js";
import {
  createElevenLabsProviders,
  ElevenLabsError,
  ElevenLabsMusicProvider,
  type ElevenLabsOptions,
  ElevenLabsSfxProvider,
  ElevenLabsTtsProvider,
} from "./index.js";
import { mp3DurationSec, mp3Frames } from "./mp3.js";
import { containsSecret, redactKey } from "./redact.js";

const FAKE_KEY = "test-key-not-real";
const env = { ELEVENLABS_API_KEY: FAKE_KEY };
/** A random-looking fake key, so that no English word in an error can match a piece of it. */
const LEAK_KEY = "sk_9f3a7c1e5b2d8046aa71";
/** Node's own fetch, saved before each test replaces the global with a guard. */
const nodeFetch = globalThis.fetch;

/** MPEG 1 Layer III, 128 kbps, 44.1 kHz, no padding: 417 bytes and 1152 samples per frame. */
function fakeMp3(frames: number): Uint8Array {
  const frameLength = 417;
  const data = new Uint8Array(frames * frameLength);
  for (let i = 0; i < frames; i++) data.set([0xff, 0xfb, 0x90, 0x00], i * frameLength);
  return data;
}

type Call = { url: URL; init: RequestInit };

function stubFetch(response: () => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function audioResponse(frames = 10): Response {
  return new Response(fakeMp3(frames), {
    status: 200,
    headers: { "Content-Type": "audio/mpeg" },
  });
}

function options(fetchFn: typeof fetch): ElevenLabsOptions {
  return { env, fetch: fetchFn };
}

function bodyOf(call: Call | undefined): unknown {
  return JSON.parse(String(call?.init.body));
}

beforeEach(() => {
  // Any call that bypasses the injected stub fails instead of reaching the real API.
  vi.stubGlobal("fetch", () => {
    throw new Error("The real fetch must not be called in tests");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("all three providers are paid and registered as elevenlabs", () => {
  const set = createProviders("elevenlabs");
  expect(set.tts).toBeInstanceOf(ElevenLabsTtsProvider);
  expect(set.sfx).toBeInstanceOf(ElevenLabsSfxProvider);
  expect(set.music).toBeInstanceOf(ElevenLabsMusicProvider);
  for (const provider of [set.tts, set.sfx, set.music]) {
    expect(provider.id).toBe("elevenlabs");
    expect(provider.paid).toBe(true);
  }
});

test("TTS sends the text, model, and voice settings to the voice's endpoint", async () => {
  const stub = stubFetch(() => audioResponse());
  const tts = new ElevenLabsTtsProvider(options(stub.fetch));
  await tts.synthesize({
    text: "Hello there.",
    voiceId: "voice-1",
    direction: "whispers",
    settings: { stability: 0.4, similarityBoost: 0.8, speed: 1.1, unknown: true },
    take: 2,
  });
  expect(stub.calls).toHaveLength(1);
  const call = stub.calls[0];
  expect(call?.url.origin).toBe("https://api.elevenlabs.io");
  expect(call?.url.pathname).toBe("/v1/text-to-speech/voice-1");
  expect(call?.url.searchParams.get("output_format")).toBe("mp3_44100_128");
  expect(call?.init.method).toBe("POST");
  expect(bodyOf(call)).toEqual({
    text: "Hello there.",
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.1 },
  });
});

test("TTS sends the direction as an audio tag only to eleven_v3", async () => {
  const stub = stubFetch(() => audioResponse());
  const tts = new ElevenLabsTtsProvider(options(stub.fetch));
  const req = {
    text: "Hi.",
    voiceId: "v",
    direction: "whispers",
    settings: { modelId: "eleven_v3" },
    take: 0,
  };
  await tts.synthesize(req);
  expect(bodyOf(stub.calls[0])).toEqual({ text: "[whispers] Hi.", model_id: "eleven_v3" });
  expect(tts.estimate(req)).toEqual({ characters: "[whispers] Hi.".length, requests: 1 });
  expect(tts.estimate({ text: "Hi.", voiceId: "v", direction: "whispers", take: 0 })).toEqual({
    characters: 3,
    requests: 1,
  });
});

test("SFX and music send their prompt and duration", async () => {
  const stub = stubFetch(() => audioResponse());
  const set = createElevenLabsProviders(options(stub.fetch));
  await set.sfx.generate({ prompt: "door creaks", durationSec: 2.5, take: 0 });
  await set.sfx.generate({ prompt: "thunder", take: 1 });
  await set.music.generate({ prompt: "calm piano", durationSec: 30, take: 0 });
  expect(stub.calls.map((c) => c.url.pathname)).toEqual([
    "/v1/sound-generation",
    "/v1/sound-generation",
    "/v1/music",
  ]);
  expect(bodyOf(stub.calls[0])).toEqual({ text: "door creaks", duration_seconds: 2.5 });
  expect(bodyOf(stub.calls[1])).toEqual({ text: "thunder" });
  expect(bodyOf(stub.calls[2])).toEqual({
    prompt: "calm piano",
    music_length_ms: 30000,
    model_id: "music_v1",
  });
});

test("SFX and music estimates count requests only, not prompt characters", () => {
  const set = createElevenLabsProviders({ env: {} });
  for (const durationSec of [3, 30]) {
    expect(set.sfx.estimate({ prompt: "thunder", durationSec, take: 0 })).toEqual({
      characters: 0,
      requests: 1,
    });
    expect(set.music.estimate({ prompt: "calm piano", durationSec, take: 0 })).toEqual({
      characters: 0,
      requests: 1,
    });
  }
  expect(set.sfx.estimate({ prompt: "thunder", take: 0 })).toEqual({ characters: 0, requests: 1 });
});

test("the API key header comes from the environment", async () => {
  const stub = stubFetch(() => audioResponse());
  await new ElevenLabsSfxProvider(options(stub.fetch)).generate({ prompt: "x", take: 0 });
  const headers = new Headers(stub.calls[0]?.init.headers);
  expect(headers.get("xi-api-key")).toBe(FAKE_KEY);
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.get("accept")).toBe("audio/mpeg");
});

test("the registered providers read process.env and the global fetch at call time", async () => {
  const stub = stubFetch(() => audioResponse());
  vi.stubEnv("ELEVENLABS_API_KEY", "env-key-not-real");
  vi.stubGlobal("fetch", stub.fetch);
  await createProviders("elevenlabs").music.generate({ prompt: "x", durationSec: 10, take: 0 });
  expect(new Headers(stub.calls[0]?.init.headers).get("xi-api-key")).toBe("env-key-not-real");
});

test("a missing key fails before any request and names the item", async () => {
  const stub = stubFetch(() => audioResponse());
  const tts = new ElevenLabsTtsProvider({ env: {}, fetch: stub.fetch });
  await expect(
    tts.synthesize({ text: "Good morning.", voiceId: "alice", take: 0 }),
  ).rejects.toThrow(
    'ElevenLabs TTS failed for voice "alice", take 0, text "Good morning.": ELEVENLABS_API_KEY is not set (missing_api_key)',
  );
  await expect(
    new ElevenLabsSfxProvider({ env: { ELEVENLABS_API_KEY: "" }, fetch: stub.fetch }).generate({
      prompt: "x",
      take: 0,
    }),
  ).rejects.toThrow(/ELEVENLABS_API_KEY is not set/);
  expect(stub.calls).toHaveLength(0);
});

test("estimate needs no key and makes no request", () => {
  const stub = stubFetch(() => audioResponse());
  const tts = new ElevenLabsTtsProvider({ env: {}, fetch: stub.fetch });
  expect(tts.estimate({ text: "Hello", voiceId: "v", take: 0 })).toEqual({
    characters: 5,
    requests: 1,
  });
  expect(stub.calls).toHaveLength(0);
});

test("a known API error code reaches the message, with only our fields", async () => {
  const stub = stubFetch(
    () =>
      new Response(
        JSON.stringify({ detail: { status: "quota_exceeded", message: "You are out of credits" } }),
        { status: 401, statusText: "Unauthorized" },
      ),
  );
  const error = await new ElevenLabsTtsProvider(options(stub.fetch))
    .synthesize({ text: "Hi.", voiceId: "bob", take: 3 })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ElevenLabsError);
  const e = error as ElevenLabsError;
  expect(e.message).toBe(
    'ElevenLabs TTS failed for voice "bob", take 3, text "Hi.": HTTP 401, quota exceeded (quota_exceeded)',
  );
  expect({ kind: e.kind, code: e.code, status: e.status }).toEqual({
    kind: "tts",
    code: "quota_exceeded",
    status: 401,
  });
  expect(e.message).not.toContain("credits");
  expect(e.message).not.toContain("Unauthorized");
});

test("an unknown API error code, or a body of no known shape, becomes unknown", async () => {
  for (const body of [
    JSON.stringify({ detail: { status: "brand_new_code", message: "new" } }),
    JSON.stringify({ detail: { status: "__proto__" } }),
    JSON.stringify({ detail: { status: "toString" } }),
    "upstream timeout",
    "",
  ]) {
    const stub = stubFetch(() => new Response(body, { status: 503 }));
    await expect(
      new ElevenLabsMusicProvider(options(stub.fetch)).generate({
        prompt: "jazz",
        durationSec: 10,
        take: 1,
      }),
    ).rejects.toThrow(
      'ElevenLabs music failed for take 1, prompt "jazz": HTTP 503, unknown API error (unknown)',
    );
  }
});

test("a validation error and a 429 get their own codes", async () => {
  const validation = stubFetch(
    () => new Response(JSON.stringify({ detail: [{ msg: "duration too long" }] }), { status: 422 }),
  );
  await expect(
    new ElevenLabsSfxProvider(options(validation.fetch)).generate({ prompt: "boom", take: 0 }),
  ).rejects.toThrow(
    'ElevenLabs SFX failed for take 0, prompt "boom": HTTP 422, request rejected as invalid (validation_error)',
  );
  const limited = stubFetch(() => new Response("slow down", { status: 429 }));
  await expect(
    new ElevenLabsSfxProvider(options(limited.fetch)).generate({ prompt: "boom", take: 0 }),
  ).rejects.toThrow(/HTTP 429, rate limited \(rate_limited\)$/);
});

test("a long text is shortened in the error message", async () => {
  const stub = stubFetch(() => new Response("", { status: 500 }));
  const text = "a".repeat(100);
  await expect(
    new ElevenLabsTtsProvider(options(stub.fetch)).synthesize({ text, voiceId: "v", take: 0 }),
  ).rejects.toThrow(`text "${"a".repeat(24)}…": HTTP 500`);
});

test("a network error has a fixed message and carries no cause", async () => {
  const stub = stubFetch(() => Promise.reject(new TypeError("fetch failed")));
  const error = await new ElevenLabsSfxProvider(options(stub.fetch))
    .generate({ prompt: "rain", take: 0 })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ElevenLabsError);
  const e = error as ElevenLabsError;
  expect(e.message).toBe(
    'ElevenLabs SFX failed for take 0, prompt "rain": network error (network_error)',
  );
  expect({ kind: e.kind, code: e.code, status: e.status }).toEqual({
    kind: "sfx",
    code: "network_error",
    status: undefined,
  });
  expect(e.cause).toBeUndefined();
});

test("bad audio in a successful response has a fixed message", async () => {
  for (const body of [JSON.stringify({ ok: true }), new Uint8Array(0)]) {
    const stub = stubFetch(() => new Response(body, { status: 200 }));
    await expect(
      new ElevenLabsTtsProvider(options(stub.fetch)).synthesize({
        text: "Hi.",
        voiceId: "carol",
        take: 0,
      }),
    ).rejects.toThrow(
      'ElevenLabs TTS failed for voice "carol", take 0, text "Hi.": HTTP 200, the response is not MP3 audio (bad_audio)',
    );
  }
});

test("a successful response returns the MP3 with its duration and meta", async () => {
  const stub = stubFetch(() => audioResponse(100));
  const result = await new ElevenLabsTtsProvider(options(stub.fetch)).synthesize({
    text: "Hi.",
    voiceId: "dave",
    take: 4,
  });
  expect(result.format).toBe("mp3");
  expect(result.data).toEqual(fakeMp3(100));
  expect(result.durationSec).toBeCloseTo((100 * 1152) / 44100, 9);
  expect(result.meta).toEqual({
    provider: "elevenlabs",
    voiceId: "dave",
    modelId: "eleven_multilingual_v2",
    take: 4,
  });
});

test("mp3DurationSec skips an ID3v2 tag and drops the frame before trailing bytes", () => {
  const tag = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
  const frames = fakeMp3(3);
  const trailer = new Uint8Array([0x54, 0x41, 0x47, 0]);
  const data = new Uint8Array([...tag, ...frames, ...trailer]);
  // The third frame is not followed by a frame header or the end of the data, so it is dropped.
  expect(mp3DurationSec(data)).toBeCloseTo((2 * 1152) / 44100, 9);
  expect(mp3DurationSec(new Uint8Array([...tag, ...frames]))).toBeCloseTo((3 * 1152) / 44100, 9);
  expect(() => mp3DurationSec(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/not MP3/);
});

// Leak tests. Every case from the security reviews checks that the fake key, in none of the
// forms below, appears in the thrown error or in the returned metadata.

/** Each form is built here, independently of the code under test, and never throws. */
function encodings(text: string): string[] {
  const attempt = (f: () => string) => {
    try {
      return [f()];
    } catch {
      return [];
    }
  };
  const codePoints = [...text].map((c) => c.codePointAt(0) ?? 0);
  return [
    text,
    ...attempt(() => encodeURIComponent(text)),
    ...attempt(() => encodeURI(text)),
    JSON.stringify(text).slice(1, -1),
    text
      .split("")
      .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
    Buffer.from(text).toString("hex"),
    codePoints.map((c) => `&#x${c.toString(16)};`).join(""),
    codePoints.map((c) => `&#${c};`).join(""),
  ];
}

/** Base64 of the key from each byte offset, without the last group, which depends on padding. */
function base64Forms(key: string): string[] {
  const bytes = Buffer.from(key);
  return [0, 1, 2].map((shift) => bytes.subarray(shift).toString("base64").slice(0, -4));
}

function leakForms(key: string): string[] {
  const all = [...encodings(key), ...base64Forms(key)];
  for (let i = 0; i + 8 <= key.length; i++) all.push(...encodings(key.slice(i, i + 8)));
  return all.map((f) => f.toLowerCase());
}

/** Everything an error exposes: message, stack, String(), JSON, and every own property. */
function serialize(error: Error): string {
  const props = Object.getOwnPropertyNames(error).map((name) =>
    String((error as unknown as Record<string, unknown>)[name]),
  );
  return [
    error.message,
    String(error.stack),
    String(error),
    JSON.stringify(error),
    JSON.stringify(Object.getOwnPropertyDescriptors(error)),
    ...props,
  ].join("\n");
}

function expectNoLeak(text: string, key: string): void {
  const lower = text.toLowerCase();
  for (const form of leakForms(key)) expect(lower).not.toContain(form);
}

/** Asserts that the error is one we built and that nothing it exposes holds the key. */
function expectNoKey(error: unknown, key = LEAK_KEY): ElevenLabsError {
  expect(error).toBeInstanceOf(ElevenLabsError);
  const e = error as ElevenLabsError;
  expect(e.cause).toBeUndefined();
  expectNoLeak(serialize(e), key);
  return e;
}

/** Runs one call with its own key and returns the error it throws. */
async function failWith(
  key: string,
  response: () => Response | Promise<Response>,
  call: (set: ReturnType<typeof createElevenLabsProviders>) => Promise<unknown>,
  extra: Partial<ElevenLabsOptions> = {},
): Promise<{ error: unknown; calls: Call[] }> {
  const stub = stubFetch(response);
  const set = createElevenLabsProviders({
    env: { ELEVENLABS_API_KEY: key },
    fetch: stub.fetch,
    ...extra,
  });
  const error = await call(set).then(
    () => new Error("expected the call to fail"),
    (e: unknown) => e,
  );
  return { error, calls: stub.calls };
}

const sfx = (set: ReturnType<typeof createElevenLabsProviders>) =>
  set.sfx.generate({ prompt: "x", take: 0 });

/** An object that throws on every way of reading it, except toJSON, which returns the key. */
function hostile(key: string): object {
  return {
    get message(): string {
      throw new Error(key);
    },
    get stack(): string {
      throw new Error(key);
    },
    [Symbol.toPrimitive]() {
      throw new Error(key);
    },
    toJSON: () => key,
    toString: () => key,
  };
}

test("leak: the key in a response body, in any encoding, is never shown", async () => {
  const unicode = LEAK_KEY.split("")
    .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");
  const htmlEntities = [...LEAK_KEY].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join("");
  const bodies = {
    literal: JSON.stringify({ detail: { status: LEAK_KEY, message: `bad key ${LEAK_KEY}` } }),
    percent: JSON.stringify({ detail: `bad key ${encodeURIComponent(`${LEAK_KEY}/+=`)}` }),
    unicode: `{"detail": {"message": "key ${unicode}"}, "error": "${unicode}"}`,
    hex: JSON.stringify({ detail: { message: Buffer.from(LEAK_KEY).toString("hex") } }),
    htmlEntities: JSON.stringify({ detail: { message: htmlEntities } }),
    base64Fragment: JSON.stringify({
      detail: { message: Buffer.from(LEAK_KEY).toString("base64").slice(4, 20) },
    }),
  };
  for (const [name, body] of Object.entries(bodies)) {
    const { error } = await failWith(
      LEAK_KEY,
      () => new Response(body, { status: 401, headers: { "request-id": LEAK_KEY } }),
      sfx,
    );
    const e = expectNoKey(error);
    expect(e.message, name).toBe(
      'ElevenLabs SFX failed for take 0, prompt "x": HTTP 401, unknown API error (unknown)',
    );
  }
});

test("leak: a request-id equal to the key is kept neither in errors nor in success meta", async () => {
  const { error } = await failWith(
    LEAK_KEY,
    () => new Response("", { status: 500, headers: { "request-id": LEAK_KEY } }),
    (set) => set.music.generate({ prompt: "x", durationSec: 10, take: 0 }),
  );
  const e = expectNoKey(error);
  expect(e).not.toHaveProperty("requestId");

  const stub = stubFetch(
    () =>
      new Response(fakeMp3(2), {
        status: 200,
        headers: { "request-id": LEAK_KEY, "x-request-id": LEAK_KEY },
      }),
  );
  const set = createElevenLabsProviders({
    env: { ELEVENLABS_API_KEY: LEAK_KEY },
    fetch: stub.fetch,
  });
  const results: AudioResult[] = [
    await set.tts.synthesize({ text: "Hi.", voiceId: "dave", take: 0 }),
    await set.sfx.generate({ prompt: "x", take: 0 }),
    await set.music.generate({ prompt: "x", durationSec: 10, take: 0 }),
  ];
  expect(results.map((r) => r.meta)).toEqual([
    { provider: "elevenlabs", voiceId: "dave", modelId: "eleven_multilingual_v2", take: 0 },
    { provider: "elevenlabs", take: 0 },
    { provider: "elevenlabs", take: 0 },
  ]);
  for (const result of results) expectNoLeak(JSON.stringify(result.meta), LEAK_KEY);
});

test("leak: a fetch rejection is never read, even with throwing getters and toPrimitive", async () => {
  for (const reason of [
    hostile(LEAK_KEY),
    Object.assign(new TypeError(`fetch failed with xi-api-key: ${LEAK_KEY}`), {
      cause: { headers: { "xi-api-key": LEAK_KEY } },
    }),
    LEAK_KEY,
  ]) {
    const { error } = await failWith(LEAK_KEY, () => Promise.reject(reason), sfx);
    expect(error).not.toBe(reason);
    expect(expectNoKey(error).message).toBe(
      'ElevenLabs SFX failed for take 0, prompt "x": network error (network_error)',
    );
  }
});

test("leak: a fetch that throws synchronously is replaced, not rethrown", async () => {
  const reason = hostile(LEAK_KEY);
  const set = createElevenLabsProviders({
    env: { ELEVENLABS_API_KEY: LEAK_KEY },
    fetch: (() => {
      throw reason;
    }) as unknown as typeof fetch,
  });
  const error = await sfx(set).catch((e: unknown) => e);
  expect(error).not.toBe(reason);
  expect(expectNoKey(error).code).toBe("network_error");
});

test("leak: a body read failure is never read, for audio and for an error body", async () => {
  const failing = (status: number) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(hostile(LEAK_KEY));
        },
      }),
      { status },
    );
  const audio = await failWith(LEAK_KEY, () => failing(200), sfx);
  expect(expectNoKey(audio.error).message).toBe(
    'ElevenLabs SFX failed for take 0, prompt "x": HTTP 200, response body read failed (body_read_failed)',
  );
  const errorBody = await failWith(LEAK_KEY, () => failing(500), sfx);
  expect(expectNoKey(errorBody.error).message).toBe(
    'ElevenLabs SFX failed for take 0, prompt "x": HTTP 500, response body read failed (body_read_failed)',
  );
});

test("leak: a response object whose getters throw becomes an internal error", async () => {
  const response = {
    get ok(): boolean {
      throw hostile(LEAK_KEY);
    },
    status: 500,
  } as unknown as Response;
  const { error } = await failWith(LEAK_KEY, () => response, sfx);
  expect(expectNoKey(error).message).toBe(
    'ElevenLabs SFX failed for take 0, prompt "x": internal error (internal_error)',
  );
});

test("leak: a request whose fields throw becomes an internal error with a fixed label", async () => {
  const req = {
    text: "Hi.",
    voiceId: "v",
    take: 0,
    get settings(): Record<string, unknown> {
      throw hostile(LEAK_KEY);
    },
  } as unknown as TtsRequest;
  const { error, calls } = await failWith(
    LEAK_KEY,
    () => audioResponse(),
    (set) => set.tts.synthesize(req),
  );
  expect(expectNoKey(error).message).toBe("ElevenLabs TTS failed: internal error (internal_error)");
  expect(calls).toHaveLength(0);
});

test("leak: an Error.prepareStackTrace that returns the key does not reach the stack", async () => {
  const original = Error.prepareStackTrace;
  let result: { error: unknown };
  try {
    Error.prepareStackTrace = () => LEAK_KEY;
    result = await failWith(LEAK_KEY, () => new Response("", { status: 500 }), sfx);
    // Read everything while the hook is still set.
    result = { error: result.error };
    const text = serialize(result.error as Error);
    Error.prepareStackTrace = original;
    expectNoLeak(text, LEAK_KEY);
  } finally {
    Error.prepareStackTrace = original;
  }
  expect(expectNoKey(result.error).message).toBe(
    'ElevenLabs SFX failed for take 0, prompt "x": HTTP 500, unknown API error (unknown)',
  );
});

test("leak: the key as a voice ID or a model ID is rejected before any request", async () => {
  const voice = await failWith(
    LEAK_KEY,
    () => audioResponse(),
    (set) => set.tts.synthesize({ text: "Hi.", voiceId: LEAK_KEY, take: 0 }),
  );
  expect(expectNoKey(voice.error).message).toBe(
    'ElevenLabs TTS failed for voice (invalid), take 0, text "Hi.": the voice ID is not a plain token (invalid_voice_id)',
  );
  expect(voice.calls).toHaveLength(0);

  const model = await failWith(
    LEAK_KEY,
    () => audioResponse(),
    (set) =>
      set.tts.synthesize({ text: "Hi.", voiceId: "v", settings: { modelId: LEAK_KEY }, take: 0 }),
  );
  expect(expectNoKey(model.error).code).toBe("invalid_model_id");
  expect(model.calls).toHaveLength(0);

  for (const voiceId of ["voice/1", "a b", "", "x".repeat(65)]) {
    const odd = await failWith(
      LEAK_KEY,
      () => audioResponse(),
      (set) => set.tts.synthesize({ text: "Hi.", voiceId, take: 0 }),
    );
    expect((odd.error as ElevenLabsError).code, voiceId).toBe("invalid_voice_id");
    expect(odd.calls).toHaveLength(0);
  }
});

test("leak: a base URL with credentials, a query, or plain http is rejected and never shown", async () => {
  for (const baseUrl of [
    `https://user:${LEAK_KEY}@api.example.com`,
    `https://${LEAK_KEY}@api.example.com`,
    `https://api.example.com/?key=${LEAK_KEY}`,
    `https://api.example.com/#${LEAK_KEY}`,
    "https://api.example.com/?",
    `http://api.example.com/${LEAK_KEY}`,
    `not a url ${LEAK_KEY}`,
  ]) {
    const { error, calls } = await failWith(LEAK_KEY, () => audioResponse(), sfx, { baseUrl });
    const e = expectNoKey(error);
    expect(e.message, baseUrl).toBe(
      'ElevenLabs SFX failed for take 0, prompt "x": the base URL must be https with no credentials, query, or fragment (invalid_base_url)',
    );
    expect(calls).toHaveLength(0);
  }
  // A key in the path is allowed through, but the base URL is never part of a message.
  const path = await failWith(LEAK_KEY, () => new Response("", { status: 500 }), sfx, {
    baseUrl: `https://api.example.com/${LEAK_KEY}/`,
  });
  expect(path.calls).toHaveLength(1);
  expectNoKey(path.error);
});

test("leak: a key with a lone surrogate is redacted without throwing", async () => {
  const key = "sk_\uD800lone_surrogate_42";
  expect(() => redactKey(`a${key}b`, key)).not.toThrow();
  expect(redactKey(`a${key}b\uDC00`, key)).toBe("a[redacted]b\uDC00");
  expect(containsSecret("\uDFFF", key)).toBe(false);
  const { error } = await failWith(
    key,
    () => new Response(JSON.stringify({ detail: key }), { status: 400 }),
    (set) => set.sfx.generate({ prompt: `say ${key} \uDC00`, take: 0 }),
  );
  expect(expectNoKey(error, key).message).toBe(
    'ElevenLabs SFX failed for take 0, prompt "say [redacted] \\udc00": ELEVENLABS_API_KEY must be printable ASCII with no whitespace (malformed_api_key)',
  );
});

test("leak: a key after filler in the prompt is redacted before the label is truncated", async () => {
  const prompt = `${"f".repeat(20)}${LEAK_KEY}`;
  const { error } = await failWith(
    LEAK_KEY,
    () => new Response("", { status: 500 }),
    (set) => set.sfx.generate({ prompt, take: 0 }),
  );
  expect(expectNoKey(error).message).toBe(
    `ElevenLabs SFX failed for take 0, prompt "${"f".repeat(20)}[red…": HTTP 500, unknown API error (unknown)`,
  );
});

test("leak: a key with a quote and a backslash is redacted before it is quoted", async () => {
  const key = 'sk"quote\\back-key-0123';
  const { error } = await failWith(
    key,
    () => new Response("", { status: 400 }),
    (set) => set.tts.synthesize({ text: `say ${key}`, voiceId: "v", take: 0 }),
  );
  expect(expectNoKey(error, key).message).toBe(
    'ElevenLabs TTS failed for voice "v", take 0, text "say [redacted]": HTTP 400, unknown API error (unknown)',
  );
});

test("leak: the final guard replaces a label that holds a piece of the key", async () => {
  // A 10-character piece is not the whole key, so redaction leaves it, but the guard catches it.
  const { error } = await failWith(
    LEAK_KEY,
    () => new Response("", { status: 401 }),
    (set) => set.sfx.generate({ prompt: `partial ${LEAK_KEY.slice(3, 13)}`, take: 2 }),
  );
  const e = expectNoKey(error);
  expect(e.message).toBe("ElevenLabs SFX failed: HTTP 401, unknown API error (unknown)");
  expect({ kind: e.kind, code: e.code, status: e.status }).toEqual({
    kind: "sfx",
    code: "unknown",
    status: 401,
  });
});

test("redirect: fetch is told not to follow redirects, and a 3xx is an error", async () => {
  const stub = stubFetch(
    () => new Response(null, { status: 302, headers: { location: "http://other.example/x" } }),
  );
  const set = createElevenLabsProviders({
    env: { ELEVENLABS_API_KEY: LEAK_KEY },
    fetch: stub.fetch,
  });
  const error = await sfx(set).catch((e: unknown) => e);
  expect(stub.calls).toHaveLength(1);
  expect(stub.calls[0]?.init.redirect).toBe("manual");
  const e = expectNoKey(error);
  expect(e.message).toBe(
    'ElevenLabs SFX failed for take 0, prompt "x": HTTP 302, the API answered with a redirect, which is not followed (unexpected_redirect)',
  );
  // A browser-style opaque redirect has status 0 and is rejected the same way.
  const opaque = { type: "opaqueredirect", status: 0, ok: false } as unknown as Response;
  const { error: opaqueError } = await failWith(LEAK_KEY, () => opaque, sfx);
  expect((opaqueError as ElevenLabsError).code).toBe("unexpected_redirect");
});

test("redirect: Node's fetch never sends the key to the origin a 302 points at", async () => {
  // An in-memory dispatcher for Node's built-in fetch, so the real redirect logic runs without
  // any socket. The API host answers 302 to a plain-http origin, which would answer with audio.
  const seen: Array<{ origin: string; headers: unknown }> = [];
  const dispatcher = {
    dispatch(
      opts: { origin: unknown; headers: unknown },
      handler: {
        onConnect?: (abort: () => void) => void;
        onHeaders?: (status: number, headers: Buffer[], resume: () => void, text: string) => void;
        onData?: (chunk: Buffer) => void;
        onComplete?: (trailers: Buffer[]) => void;
      },
    ) {
      const origin = String(opts.origin);
      seen.push({ origin, headers: opts.headers });
      const isApi = origin === "https://api.elevenlabs.io";
      const headers = isApi
        ? ["location", "http://attacker.example/steal"]
        : ["content-type", "audio/mpeg"];
      queueMicrotask(() => {
        handler.onConnect?.(() => {});
        handler.onHeaders?.(
          isApi ? 302 : 200,
          headers.map((h) => Buffer.from(h)),
          () => {},
          "",
        );
        if (!isApi) handler.onData?.(Buffer.from(fakeMp3(2)));
        handler.onComplete?.([]);
      });
      return true;
    },
    close() {},
    destroy() {},
    on() {
      return this;
    },
    off() {
      return this;
    },
  };
  const fetchWithDispatcher = ((input: string | URL | Request, init?: RequestInit) =>
    nodeFetch(input, { ...init, dispatcher } as unknown as RequestInit)) as typeof fetch;
  const set = createElevenLabsProviders({
    env: { ELEVENLABS_API_KEY: LEAK_KEY },
    fetch: fetchWithDispatcher,
  });
  const error = await sfx(set).catch((e: unknown) => e);
  expect(seen.map((s) => s.origin)).toEqual(["https://api.elevenlabs.io"]);
  expect(expectNoKey(error).code).toBe("unexpected_redirect");
});

test("audio: ID3 tags and trailing bytes are dropped, with the frame before trailing data", async () => {
  const marker = new TextEncoder().encode(`key=${LEAK_KEY}`);
  // An ID3v2 tag whose 40-byte body holds the key.
  const id3v2Body = new Uint8Array(40);
  id3v2Body.set(marker);
  const id3v2 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 40, ...id3v2Body]);
  // An ID3v1 tag: "TAG" and 125 bytes, with the key in the title.
  const id3v1 = new Uint8Array(128);
  id3v1.set([0x54, 0x41, 0x47]);
  id3v1.set(marker, 3);
  const frames = fakeMp3(5);
  for (const [parts, kept] of [
    [[id3v2, frames], 5],
    [[frames, id3v1], 4],
    [[frames, marker], 4],
    [[id3v2, frames, id3v1, marker], 4],
  ] as const) {
    const body = new Uint8Array(parts.flatMap((p) => [...p]));
    const stub = stubFetch(() => new Response(body, { status: 200 }));
    const result = await createElevenLabsProviders({
      env: { ELEVENLABS_API_KEY: LEAK_KEY },
      fetch: stub.fetch,
    }).sfx.generate({ prompt: "x", take: 0 });
    expect(result.data).toEqual(fakeMp3(kept));
    expect(result.durationSec).toBeCloseTo(mp3DurationSec(body), 9);
    expect(result.durationSec).toBeCloseTo((kept * 1152) / 44100, 9);
    expectNoLeak(Buffer.from(result.data).toString("latin1"), LEAK_KEY);
  }
});

test("key: an empty, whitespace, or control-character key is rejected before any request", async () => {
  for (const key of [" ", "\t", "  \n "]) {
    const { error, calls } = await failWith(key, () => audioResponse(), sfx);
    expect((error as ElevenLabsError).code, JSON.stringify(key)).toBe("missing_api_key");
    expect(calls).toHaveLength(0);
  }
  for (const key of [
    " sk_7f3q9z2x8k",
    "sk_7f3q9z2x8k ",
    "sk_7f3q9 z2x8k",
    "sk_7f3q9\tz2x8k",
    "sk_7f3q9z2x8k\n",
    "sk_7f3q9\u0000z2x8k",
    "sk_7f3q9\u007fz2x8k",
    "sk_7f3q9\u00a0z2x8k",
    "sk_7f3q9\u2028z2x8k",
  ]) {
    const { error, calls } = await failWith(key, () => audioResponse(), sfx);
    const e = expectNoKey(error, key);
    expect(e.message, JSON.stringify(key)).toBe(
      'ElevenLabs SFX failed for take 0, prompt "x": ELEVENLABS_API_KEY must be printable ASCII with no whitespace (malformed_api_key)',
    );
    expect(calls).toHaveLength(0);
  }
});

/** One MPEG 1 Layer III frame of 417 bytes (128 kbps, 44.1 kHz), with a channel mode byte. */
function frame(channelByte = 0x00): Uint8Array {
  const data = new Uint8Array(417);
  data.set([0xff, 0xfb, 0x90, channelByte]);
  return data;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(parts.flatMap((p) => [...p]));
}

function ascii(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}

async function generateAudio(body: Uint8Array): Promise<AudioResult> {
  const stub = stubFetch(() => new Response(body, { status: 200 }));
  return createElevenLabsProviders({
    env: { ELEVENLABS_API_KEY: LEAK_KEY },
    fetch: stub.fetch,
  }).sfx.generate({ prompt: "x", take: 0 });
}

test("audio: a truncated frame cannot pull a trailing tag into the audio", async () => {
  // A whole frame, then the first 300 bytes of a frame that claims 417, then a tag with the key.
  // Against the whole response, the truncated frame would look complete and cover the tag.
  const id3v1 = new Uint8Array(128);
  id3v1.set(ascii("TAG"));
  id3v1.set(ascii(LEAK_KEY), 3);
  const items = concat(ascii(`title\u0000${LEAK_KEY}`), new Uint8Array(100));
  const apeFooter = (flags: number) => {
    const footer = new Uint8Array(32);
    footer.set(ascii("APETAGEX"));
    new DataView(footer.buffer).setUint32(8, 2000, true);
    new DataView(footer.buffer).setUint32(12, items.length + 32, true);
    new DataView(footer.buffer).setUint32(16, 1, true);
    new DataView(footer.buffer).setUint32(20, flags, true);
    return footer;
  };
  const ape = concat(apeFooter(0xa0000000), items, apeFooter(0x80000000));
  const whole = frame();
  const truncated = frame().subarray(0, 300);
  for (const [name, body] of [
    ["ID3v1", concat(whole, truncated, id3v1)],
    ["APEv2", concat(whole, truncated, ape)],
    ["APEv2 and ID3v1", concat(whole, truncated, ape, id3v1)],
  ] as const) {
    const result = await generateAudio(body);
    expect(result.data, name).toEqual(whole);
    expect(result.durationSec).toBeCloseTo(1152 / 44100, 9);
    expectNoLeak(Buffer.from(result.data).toString("latin1"), LEAK_KEY);
  }
});

/** A header frame: an Info or Xing tag with all four optional fields, then a LAME tag. */
function headerFrame(
  tag: "Info" | "Xing",
  audioFrames: number,
  lame?: { delay: number; padding: number; encoder?: string },
  channelByte = 0x00,
): Uint8Array {
  const data = frame(channelByte);
  const view = new DataView(data.buffer);
  const at = channelByte >> 6 === 0b11 ? 4 + 17 : 4 + 32;
  data.set(ascii(tag), at);
  view.setUint32(at + 4, 0x0f);
  view.setUint32(at + 8, audioFrames);
  view.setUint32(at + 12, audioFrames * 417);
  const lameAt = at + 8 + 4 + 4 + 100 + 4;
  if (lame) {
    data.set(ascii(lame.encoder ?? "LAME3.100"), lameAt);
    data[lameAt + 21] = lame.delay >> 4;
    data[lameAt + 22] = ((lame.delay & 0x0f) << 4) | (lame.padding >> 8);
    data[lameAt + 23] = lame.padding & 0xff;
  }
  return data;
}

test("audio: a header frame is not audio, and the LAME delay and padding are subtracted", async () => {
  // 40 audio frames are 46080 samples. With 576 samples of delay and 1404 of padding, the audio
  // is exactly 44100 samples: one second, as ffmpeg decodes it.
  const audio = Array.from({ length: 40 }, () => frame());
  for (const [name, header] of [
    ["Info, LAME", headerFrame("Info", 40, { delay: 576, padding: 1404 })],
    ["Xing, Lavc", headerFrame("Xing", 40, { delay: 576, padding: 1404, encoder: "Lavc59.37" })],
    ["Info, LAME, mono", headerFrame("Info", 40, { delay: 576, padding: 1404 }, 0xc0)],
  ] as const) {
    const body = concat(header, ...audio);
    const result = await generateAudio(body);
    expect(Math.abs(result.durationSec - 1), name).toBeLessThan(0.001);
    expect(mp3DurationSec(body)).toBeCloseTo(1, 9);
    // The header frame stays in the returned audio, since decoders need it.
    expect(result.data).toEqual(body);
  }
  // A header with no LAME tag, or a VBRI header, still does not count as audio.
  const noLame = concat(headerFrame("Info", 40), ...audio);
  expect(mp3DurationSec(noLame)).toBeCloseTo((40 * 1152) / 44100, 9);
  const vbri = frame();
  vbri.set(ascii("VBRI"), 36);
  expect(mp3DurationSec(concat(vbri, ...audio))).toBeCloseTo((40 * 1152) / 44100, 9);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test.skipIf(!hasFfmpeg)("audio: the duration matches what ffmpeg decodes", () => {
  const dir = mkdtempSync(join(tmpdir(), "vd-mp3-"));
  try {
    const file = join(dir, "tone.mp3");
    const encoded = spawnSync("ffmpeg", [
      ...["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=1.3:sample_rate=44100"],
      ...["-c:a", "libmp3lame", "-b:a", "128k", file],
    ]);
    // Without the LAME encoder, there is nothing to compare.
    if (encoded.status !== 0) return;
    const pcm = execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-"],
      {
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const decodedSec = pcm.length / 2 / 44100;
    expect(Math.abs(mp3DurationSec(readFileSync(file)) - decodedSec)).toBeLessThan(0.001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An ID3v1 tag and an APEv2 tag with a header and footer, each holding the key. */
function trailingTags(): { id3v1: Uint8Array; ape: Uint8Array } {
  const id3v1 = new Uint8Array(128);
  id3v1.set(ascii("TAG"));
  id3v1.set(ascii(LEAK_KEY), 3);
  const items = concat(ascii(`title\u0000${LEAK_KEY}`), new Uint8Array(100));
  const apeBlock = (flags: number) => {
    const block = new Uint8Array(32);
    const view = new DataView(block.buffer);
    block.set(ascii("APETAGEX"));
    view.setUint32(8, 2000, true);
    view.setUint32(12, items.length + 32, true);
    view.setUint32(16, 1, true);
    view.setUint32(20, flags, true);
    return block;
  };
  return { id3v1, ape: concat(apeBlock(0xa0000000), items, apeBlock(0x80000000)) };
}

test("audio: stacked or reversed trailing tags after a truncated frame never enter the audio", async () => {
  const { id3v1, ape } = trailingTags();
  const whole = frame();
  const truncated = frame().subarray(0, 300);
  for (const [name, tail] of [
    ["two ID3v1", [id3v1, id3v1]],
    ["two APEv2", [ape, ape]],
    ["ID3v1 then APEv2", [id3v1, ape]],
    ["APEv2, ID3v1, APEv2", [ape, id3v1, ape]],
  ] as const) {
    const result = await generateAudio(concat(whole, truncated, ...tail));
    expect(result.data, name).toEqual(whole);
    expect(result.durationSec).toBeCloseTo(1152 / 44100, 9);
    expectNoLeak(Buffer.from(result.data).toString("latin1"), LEAK_KEY);
  }
});

test("audio: tag signatures inside the last frame do not drop it", async () => {
  // A clean file whose final frame happens to hold "TAG" 128 bytes and "APETAGEX" 32 bytes before
  // the end, in its ancillary data. Every frame is real audio and is kept.
  const frames = Array.from({ length: 10 }, () => frame());
  const body = concat(...frames);
  body.set(ascii("TAG"), body.length - 128);
  body.set(ascii("APETAGEX"), body.length - 32);
  const result = await generateAudio(body);
  expect(result.data).toEqual(body);
  expect(result.durationSec).toBeCloseTo((10 * 1152) / 44100, 9);
});

test("audio: a clean file with no trailing data keeps every frame", async () => {
  const body = concat(headerFrame("Info", 40, { delay: 576, padding: 1404 }), fakeMp3(40));
  const result = await generateAudio(body);
  expect(result.data).toEqual(body);
  expect(Math.abs(result.durationSec - 1)).toBeLessThan(0.001);
});

test.skipIf(!hasFfmpeg)(
  "audio: ffmpeg audio keeps every frame, even with tag signatures in it",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "vd-mp3-"));
    try {
      const file = join(dir, "tone.mp3");
      const encoded = spawnSync("ffmpeg", [
        ...["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=0.7:sample_rate=44100"],
        ...["-c:a", "libmp3lame", "-b:a", "128k", file],
      ]);
      if (encoded.status !== 0) return;
      const clean = new Uint8Array(readFileSync(file));
      const parsed = mp3Frames(clean);
      expect(parsed.end).toBe(clean.length);
      // The same bytes with the signatures written into the final frame's data.
      const signed = clean.slice();
      signed.set(ascii("TAG"), signed.length - 128);
      signed.set(ascii("APETAGEX"), signed.length - 32);
      expect(mp3Frames(signed)).toEqual(parsed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

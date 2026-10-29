import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createProviders } from "../index.js";
import {
  createElevenLabsProviders,
  ElevenLabsMusicProvider,
  type ElevenLabsOptions,
  ElevenLabsSfxProvider,
  ElevenLabsTtsProvider,
} from "./index.js";
import { mp3DurationSec } from "./mp3.js";

const FAKE_KEY = "test-key-not-real";
const env = { ELEVENLABS_API_KEY: FAKE_KEY };

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
    headers: { "Content-Type": "audio/mpeg", "request-id": "req-123" },
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
    voiceId: "voice/1",
    direction: "whispers",
    settings: { stability: 0.4, similarityBoost: 0.8, speed: 1.1, unknown: true },
    take: 2,
  });
  expect(stub.calls).toHaveLength(1);
  const call = stub.calls[0];
  expect(call?.url.origin).toBe("https://api.elevenlabs.io");
  expect(call?.url.pathname).toBe("/v1/text-to-speech/voice%2F1");
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
  expect(set.sfx.estimate({ prompt: "thunder", take: 0 })).toEqual({ characters: 7, requests: 1 });
  expect(set.music.estimate({ prompt: "calm piano", durationSec: 30, take: 0 })).toEqual({
    characters: 10,
    requests: 1,
  });
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
    'ElevenLabs TTS failed for voice "alice", take 0, text "Good morning.": ELEVENLABS_API_KEY is not set',
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

test("an HTTP error names the item, the status, and the API's message, but not the key", async () => {
  const stub = stubFetch(
    () =>
      new Response(
        JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }),
        {
          status: 401,
          statusText: "Unauthorized",
        },
      ),
  );
  const tts = new ElevenLabsTtsProvider(options(stub.fetch));
  const error = await tts
    .synthesize({ text: "Hi.", voiceId: "bob", take: 3 })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    'ElevenLabs TTS failed for voice "bob", take 3, text "Hi.": HTTP 401 Unauthorized: Invalid API key',
  );
  expect((error as Error).message).not.toContain(FAKE_KEY);
});

test("an HTTP error reads validation details and plain-text bodies", async () => {
  const validation = stubFetch(
    () =>
      new Response(
        JSON.stringify({ detail: [{ msg: "duration too long" }, { msg: "bad prompt" }] }),
        { status: 422 },
      ),
  );
  await expect(
    new ElevenLabsSfxProvider(options(validation.fetch)).generate({ prompt: "boom", take: 0 }),
  ).rejects.toThrow(
    'ElevenLabs SFX failed for take 0, prompt "boom": HTTP 422: duration too long; bad prompt',
  );

  const plain = stubFetch(() => new Response("upstream timeout", { status: 503 }));
  await expect(
    new ElevenLabsMusicProvider(options(plain.fetch)).generate({
      prompt: "jazz",
      durationSec: 10,
      take: 1,
    }),
  ).rejects.toThrow(
    'ElevenLabs music failed for take 1, prompt "jazz": HTTP 503: upstream timeout',
  );
});

test("a long text is shortened in the error message", async () => {
  const stub = stubFetch(() => new Response("", { status: 500 }));
  const text = "a".repeat(100);
  await expect(
    new ElevenLabsTtsProvider(options(stub.fetch)).synthesize({ text, voiceId: "v", take: 0 }),
  ).rejects.toThrow(`text "${"a".repeat(40)}…": HTTP 500`);
});

test("a network error names the item and keeps the cause", async () => {
  const cause = new TypeError("fetch failed");
  const stub = stubFetch(() => Promise.reject(cause));
  const error = await new ElevenLabsSfxProvider(options(stub.fetch))
    .generate({ prompt: "rain", take: 0 })
    .catch((e: unknown) => e);
  expect((error as Error).message).toBe(
    'ElevenLabs SFX failed for take 0, prompt "rain": network error: fetch failed',
  );
  expect((error as Error).cause).toBe(cause);
});

test("bad audio in a successful response names the item", async () => {
  const stub = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await expect(
    new ElevenLabsTtsProvider(options(stub.fetch)).synthesize({
      text: "Hi.",
      voiceId: "carol",
      take: 0,
    }),
  ).rejects.toThrow(
    /^ElevenLabs TTS failed for voice "carol", take 0, text "Hi.": bad audio in the response/,
  );

  const empty = stubFetch(() => new Response(new Uint8Array(0), { status: 200 }));
  await expect(
    new ElevenLabsMusicProvider(options(empty.fetch)).generate({
      prompt: "x",
      durationSec: 10,
      take: 0,
    }),
  ).rejects.toThrow(/bad audio in the response \(0 bytes\)/);
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
    requestId: "req-123",
  });
});

test("mp3DurationSec skips an ID3v2 tag and trailing bytes", () => {
  const tag = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
  const frames = fakeMp3(3);
  const trailer = new Uint8Array([0x54, 0x41, 0x47, 0]);
  const data = new Uint8Array([...tag, ...frames, ...trailer]);
  expect(mp3DurationSec(data)).toBeCloseTo((3 * 1152) / 44100, 9);
  expect(() => mp3DurationSec(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/not MP3/);
});

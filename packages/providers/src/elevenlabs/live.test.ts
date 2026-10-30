// The one test that calls the real ElevenLabs API. Each run is a paid call, so it is skipped
// unless VD_LIVE_ELEVENLABS=1, ELEVENLABS_API_KEY, and VD_LIVE_ELEVENLABS_VOICE are all set.
// See docs/providers.md for how to run it.
//
// The key and the voice ID are never printed. The whole test body runs inside withSafeFailure,
// which replaces any failure with a fixed message: the step that failed, plus an allowlisted
// error code or HTTP status. No path, cause, stderr, buffer, or provider message gets through,
// since an ElevenLabsError's label names the voice and the save path may too. The offline tests
// at the end check that with a made-up key and voice ID.

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { AudioResult, TtsRequest } from "../types.js";
import {
  ELEVENLABS_API_ERRORS,
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_DEFAULT_TTS_MODEL,
  readsAudioTags,
} from "./api.js";
import { ElevenLabsError, type ElevenLabsErrorCode, ElevenLabsTtsProvider } from "./index.js";

const env = process.env;
const voiceId = env.VD_LIVE_ELEVENLABS_VOICE ?? "";
const modelId = env.VD_LIVE_ELEVENLABS_MODEL || ELEVENLABS_DEFAULT_TTS_MODEL;
/** Where to save the MP3 for listening, such as to hear whether a model reads the audio tag. */
const outFile = env.VD_LIVE_ELEVENLABS_OUT ?? "";
const live =
  env.VD_LIVE_ELEVENLABS === "1" &&
  (env[ELEVENLABS_API_KEY_ENV] ?? "").trim() !== "" &&
  voiceId.trim() !== "";

/** The line sent. With a model that reads audio tags, the direction goes as "[whispers] ". */
const LINE = { text: "Is anyone there? Hello?", direction: "whispers" };
/** The most characters one run may send. */
const MAX_CHARACTERS = 50;

/** What the test was doing. Only these fixed texts can appear in a failure message. */
const STEPS = [
  "start",
  "check ffmpeg",
  "check the save path",
  "estimate",
  "call the API",
  "check the result",
  "decode with ffmpeg",
  "save the audio",
] as const;
type Step = (typeof STEPS)[number];

/** ElevenLabsError codes that may be shown. They are fixed words that hold no input. */
const SAFE_PROVIDER_CODES = new Set<string>([
  ...Object.keys(ELEVENLABS_API_ERRORS),
  ...([
    "missing_api_key",
    "malformed_api_key",
    "invalid_voice_id",
    "invalid_model_id",
    "invalid_base_url",
    "network_error",
    "unexpected_redirect",
    "body_read_failed",
    "bad_audio",
    "audio_holds_key",
    "internal_error",
  ] satisfies ElevenLabsErrorCode[]),
]);
/** Node.js system error codes that may be shown. */
const SAFE_SYSTEM_CODES = new Set([
  "EACCES",
  "EEXIST",
  "EISDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "ENOBUFS",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
  "ETIMEDOUT",
]);

/** A fixed failure message: the step, and an allowlisted code or HTTP status if there is one. */
function safeFailureMessage(step: Step, error: unknown): string {
  const at = (STEPS as readonly string[]).includes(step) ? step : "an unknown step";
  const details: string[] = [];
  if (error instanceof ElevenLabsError) {
    if (SAFE_PROVIDER_CODES.has(error.code)) details.push(error.code);
    const status: unknown = error.status;
    if (Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599) {
      details.push(`HTTP ${status}`);
    }
  } else if (error instanceof Error && error.name === "AssertionError") {
    details.push("assertion failed");
  } else if (typeof error === "object" && error !== null) {
    const code: unknown = (error as { code?: unknown }).code;
    if (typeof code === "string" && SAFE_SYSTEM_CODES.has(code)) details.push(code);
  }
  return `ElevenLabs live TTS failed at ${at}${details.length > 0 ? `: ${details.join(", ")}` : ""}`;
}

/** Runs body and rethrows any failure as a new Error with only a fixed message and no cause. */
async function withSafeFailure(
  body: (at: (step: Step) => void) => Promise<void> | void,
): Promise<void> {
  let step: Step = "start";
  let message: string | undefined;
  try {
    await body((next) => {
      step = next;
    });
  } catch (error) {
    message = safeFailureMessage(step, error);
  }
  // Thrown outside the catch block so that nothing links the new error to the caught one.
  if (message !== undefined) throw new Error(message);
}

/** Fails, before any paid call, unless the folder exists and nothing is at the path yet. */
function checkSavePath(path: string): void {
  if (!statSync(dirname(resolve(path))).isDirectory()) {
    throw Object.assign(new Error("not a folder"), { code: "ENOTDIR" });
  }
  // lstat, so that a symbolic link counts as taken even when it points nowhere.
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw Object.assign(new Error("already exists"), { code: "EEXIST" });
  }
}

test.skipIf(!live)(
  "live: ElevenLabs TTS returns playable audio of a plausible length",
  // One paid call per run: a retry or a repeat would pay again.
  { timeout: 60_000, retry: 0, repeats: 0 },
  () =>
    withSafeFailure(async (at) => {
      at("check ffmpeg");
      expect(spawnSync("ffmpeg", ["-version"]).status).toBe(0);
      if (outFile) {
        at("check the save path");
        checkSavePath(outFile);
      }

      at("estimate");
      const provider = new ElevenLabsTtsProvider();
      const req: TtsRequest = { ...LINE, voiceId, settings: { modelId }, take: 0 };
      const { characters } = provider.estimate(req);
      expect(characters).toBeLessThan(MAX_CHARACTERS);

      at("call the API");
      const result: AudioResult = await provider.synthesize(req);

      at("check the result");
      expect(result.format).toBe("mp3");
      // About 2 seconds of speech. A wide range still catches empty or runaway audio.
      expect(result.durationSec).toBeGreaterThan(0.5);
      expect(result.durationSec).toBeLessThan(10);

      // Playable means ffmpeg decodes it to sound of the same length.
      at("decode with ffmpeg");
      const dir = mkdtempSync(join(tmpdir(), "vd-live-"));
      try {
        const file = join(dir, "line.mp3");
        writeFileSync(file, result.data);
        const pcm = execFileSync(
          "ffmpeg",
          ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", "44100", "-"],
          { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
        );
        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
        const decodedSec = samples.length / 44100;
        expect(Math.abs(decodedSec - result.durationSec)).toBeLessThan(0.1);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        // Not silence: about -30 dBFS or louder at the peak.
        expect(peak).toBeGreaterThan(1000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      if (outFile) {
        at("save the audio");
        // "wx" fails if anything, even a symbolic link, appeared at the path since the check.
        writeFileSync(outFile, result.data, { flag: "wx" });
      }

      const tag = readsAudioTags(modelId) ? "sent as an audio tag" : "not sent";
      console.log(
        `ElevenLabs live TTS: model ${modelId}, ${characters} characters, direction ${tag}, ` +
          `${result.durationSec.toFixed(2)} s${outFile ? ", saved to VD_LIVE_ELEVENLABS_OUT" : ""}`,
      );
    }),
);

describe("live test failure messages (offline)", () => {
  const KEY = "sk_offline_test_key_0123456789abcdef";
  const VOICE = "OfflineVoice9x7Q";

  async function failureOf(body: () => Promise<void> | void, step: Step = "start") {
    try {
      await withSafeFailure((at) => {
        at(step);
        return body();
      });
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected a failure");
  }

  function expectNoSecrets(error: Error): void {
    expect(error.constructor).toBe(Error);
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error)).toEqual([]);
    for (const text of [error.message, String(error.stack)]) {
      expect(text.includes(KEY)).toBe(false);
      expect(text.includes(VOICE)).toBe(false);
    }
  }

  test("keeps only the code and HTTP status of a provider error", async () => {
    const error = await failureOf(() => {
      throw new ElevenLabsError("tts", `ElevenLabs TTS voice=${VOICE}`, "invalid_api_key", 401);
    }, "call the API");
    expect(error.message).toBe(
      "ElevenLabs live TTS failed at call the API: invalid_api_key, HTTP 401",
    );
    expectNoSecrets(error);
  });

  test("drops a provider code or status that is not allowlisted", async () => {
    const error = await failureOf(() => {
      const forged = new ElevenLabsError("tts", VOICE, "unknown", 500);
      Object.defineProperty(forged, "code", { value: VOICE });
      Object.defineProperty(forged, "status", { value: `${KEY}` });
      throw forged;
    }, "call the API");
    expect(error.message).toBe("ElevenLabs live TTS failed at call the API");
    expectNoSecrets(error);
  });

  test("keeps only the code of a file system error, not its path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vd-live-offline-"));
    try {
      const missing = await failureOf(() => {
        writeFileSync(join(dir, "missing", `${VOICE}.mp3`), KEY, { flag: "wx" });
      }, "save the audio");
      expect(missing.message).toBe("ElevenLabs live TTS failed at save the audio: ENOENT");
      expectNoSecrets(missing);

      const taken = join(dir, `${VOICE}.mp3`);
      writeFileSync(taken, "old");
      const exists = await failureOf(() => checkSavePath(taken), "check the save path");
      expect(exists.message).toBe("ElevenLabs live TTS failed at check the save path: EEXIST");
      expectNoSecrets(exists);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drops the stderr, output, and arguments of a failed child process", async () => {
    const script = `process.stdout.write(${JSON.stringify(KEY)});process.stderr.write(${JSON.stringify(VOICE)});process.exit(3)`;
    const error = await failureOf(() => {
      execFileSync(process.execPath, ["-e", script, VOICE], { stdio: ["ignore", "pipe", "pipe"] });
    }, "decode with ffmpeg");
    expect(error.message).toBe("ElevenLabs live TTS failed at decode with ffmpeg");
    expectNoSecrets(error);
  });

  test("drops the values of a failed assertion", async () => {
    const error = await failureOf(() => {
      expect(VOICE).toBe(KEY);
    }, "check the result");
    expect(error.message).toBe("ElevenLabs live TTS failed at check the result: assertion failed");
    expectNoSecrets(error);
  });

  test("drops anything else that is thrown", async () => {
    const error = await failureOf(() => {
      throw `${KEY} ${VOICE}`;
    });
    expect(error.message).toBe("ElevenLabs live TTS failed at start");
    expectNoSecrets(error);
  });
});

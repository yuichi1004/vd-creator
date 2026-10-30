// The one test that calls the real ElevenLabs API. Each run is a paid call, so it is skipped
// unless VD_LIVE_ELEVENLABS=1, ELEVENLABS_API_KEY, and VD_LIVE_ELEVENLABS_VOICE are all set.
// See docs/providers.md for how to run it.
//
// The key and the voice ID are never printed. A failure is reported with the error code and the
// HTTP status only, since an ElevenLabsError's label names the voice. Nothing from the result's
// meta, which holds the voice ID, is passed to an assertion that could print it.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AudioResult, TtsRequest } from "../types.js";
import { ELEVENLABS_API_KEY_ENV, ELEVENLABS_DEFAULT_TTS_MODEL, readsAudioTags } from "./api.js";
import { ElevenLabsError, ElevenLabsTtsProvider } from "./index.js";

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

test.skipIf(!live)(
  "live: ElevenLabs TTS returns playable audio of a plausible length",
  async () => {
    const provider = new ElevenLabsTtsProvider();
    const req: TtsRequest = { ...LINE, voiceId, settings: { modelId }, take: 0 };
    const { characters } = provider.estimate(req);
    expect(characters).toBeLessThan(MAX_CHARACTERS);

    let result: AudioResult;
    try {
      result = await provider.synthesize(req);
    } catch (error) {
      // The provider's own message names the voice, so only the code and status are kept.
      if (error instanceof ElevenLabsError) {
        const http = error.status === undefined ? "" : `, HTTP ${error.status}`;
        throw new Error(`ElevenLabs live TTS failed: ${error.code}${http}`);
      }
      throw new Error("ElevenLabs live TTS failed with an unexpected error");
    }

    expect(result.format).toBe("mp3");
    // About 2 seconds of speech. A wide range still catches empty or runaway audio.
    expect(result.durationSec).toBeGreaterThan(0.5);
    expect(result.durationSec).toBeLessThan(10);

    // Playable means ffmpeg decodes it to sound of the same length.
    expect(spawnSync("ffmpeg", ["-version"]).status, "ffmpeg is required").toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "vd-live-"));
    try {
      const file = join(dir, "line.mp3");
      writeFileSync(file, result.data);
      const pcm = execFileSync(
        "ffmpeg",
        ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", "44100", "-"],
        { maxBuffer: 64 * 1024 * 1024 },
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
    if (outFile) writeFileSync(outFile, result.data);

    const tag = readsAudioTags(modelId) ? "sent as an audio tag" : "not sent";
    console.log(
      `ElevenLabs live TTS: model ${modelId}, ${characters} characters, direction ${tag}, ` +
        `${result.durationSec.toFixed(2)} s${outFile ? ", saved to VD_LIVE_ELEVENLABS_OUT" : ""}`,
    );
  },
  60_000,
);

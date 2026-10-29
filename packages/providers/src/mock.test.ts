import { describe, expect, test } from "vitest";
import {
  MOCK_SFX_DEFAULT_DURATION_SEC,
  MockMusicProvider,
  MockSfxProvider,
  MockTtsProvider,
  mockTakeFrequency,
} from "./mock.js";
import type { AudioResult } from "./types.js";
import { readWavInfo } from "./wav.js";

const tts = new MockTtsProvider();
const sfx = new MockSfxProvider();
const music = new MockMusicProvider();

const ttsRequest = { text: "Hello there, this is a test line.", voiceId: "narrator", take: 0 };

const kinds: { name: string; run: (take: number) => Promise<AudioResult> }[] = [
  { name: "tts", run: (take) => tts.synthesize({ ...ttsRequest, take }) },
  { name: "sfx", run: (take) => sfx.generate({ prompt: "door slam", durationSec: 0.8, take }) },
  { name: "music", run: (take) => music.generate({ prompt: "calm", durationSec: 2, take }) },
];

describe.each(kinds)("mock $name", ({ run }) => {
  test("returns a valid WAV whose header duration matches durationSec", async () => {
    const result = await run(0);
    expect(result.format).toBe("wav");
    const info = readWavInfo(result.data);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.durationSec).toBe(result.durationSec);
  });

  test("is deterministic", async () => {
    const [a, b] = await Promise.all([run(1), run(1)]);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(a).toEqual(b);
  });

  test("gives different bytes for different takes", async () => {
    const results = await Promise.all([0, 1, 2, 3].map(run));
    const hex = new Set(results.map((r) => Buffer.from(r.data).toString("hex")));
    expect(hex.size).toBe(4);
  });

  test("is not silent", async () => {
    const { data } = await run(0);
    const pcm = new Int16Array(data.buffer.slice(44));
    expect(Math.max(...pcm.map(Math.abs))).toBeGreaterThan(1000);
  });

  test("rejects an invalid take", async () => {
    await expect(run(-1)).rejects.toThrow(/take/);
    await expect(run(1.5)).rejects.toThrow(/take/);
  });
});

describe("mock providers", () => {
  test("are free and identify as mock", () => {
    for (const provider of [tts, sfx, music]) {
      expect(provider.id).toBe("mock");
      expect(provider.paid).toBe(false);
    }
  });

  test("TTS length follows the text at about 15 characters per second", async () => {
    const result = await tts.synthesize({ ...ttsRequest, text: "x".repeat(45) });
    expect(result.durationSec).toBeCloseTo(3, 3);
  });

  test("TTS has a minimum length for short or empty text", async () => {
    const result = await tts.synthesize({ ...ttsRequest, text: "" });
    expect(result.durationSec).toBeCloseTo(0.5, 3);
    expect(readWavInfo(result.data).durationSec).toBe(result.durationSec);
  });

  test("SFX and music follow the requested duration", async () => {
    expect((await sfx.generate({ prompt: "x", durationSec: 1.25, take: 0 })).durationSec).toBe(
      1.25,
    );
    expect((await music.generate({ prompt: "x", durationSec: 4, take: 0 })).durationSec).toBe(4);
  });

  test("SFX has a default duration", async () => {
    const result = await sfx.generate({ prompt: "x", take: 0 });
    expect(result.durationSec).toBeCloseTo(MOCK_SFX_DEFAULT_DURATION_SEC, 3);
  });

  test("rejects an invalid duration", async () => {
    await expect(sfx.generate({ prompt: "x", durationSec: 0, take: 0 })).rejects.toThrow();
    await expect(
      music.generate({ prompt: "x", durationSec: Number.NaN, take: 0 }),
    ).rejects.toThrow();
  });

  test("takes have audibly different pitches", () => {
    const pitches = [0, 1, 2, 3, 4, 5, 6, 7].map(mockTakeFrequency);
    for (const pitch of pitches) {
      expect(pitch).toBeGreaterThanOrEqual(220);
      expect(pitch).toBeLessThan(660);
    }
    for (let i = 1; i < pitches.length; i++) {
      // At least a semitone apart from the previous take.
      const ratio =
        Math.max(pitches[i] ?? 0, pitches[i - 1] ?? 0) /
        Math.min(pitches[i] ?? 0, pitches[i - 1] ?? 0);
      expect(ratio).toBeGreaterThan(2 ** (1 / 12));
    }
  });

  test("estimate counts characters and one request", () => {
    expect(tts.estimate({ ...ttsRequest, text: "こんにちは" })).toEqual({
      characters: 5,
      requests: 1,
    });
    expect(sfx.estimate({ prompt: "rain", take: 0 })).toEqual({ characters: 4, requests: 1 });
    expect(music.estimate({ prompt: "calm", durationSec: 10, take: 0 })).toEqual({
      characters: 4,
      requests: 1,
    });
  });
});

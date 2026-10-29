// Mock providers: real, playable WAV tone patterns made in code, with no network access.
// Output is deterministic, and each take has its own pitch so that regeneration is audible.

import { registerProviders } from "./registry.js";
import type {
  AudioResult,
  Cost,
  MusicProvider,
  MusicRequest,
  ProviderSet,
  SfxProvider,
  SfxRequest,
  TtsProvider,
  TtsRequest,
} from "./types.js";
import { encodeWav } from "./wav.js";

export const MOCK_PROVIDER_ID = "mock";
export const MOCK_SAMPLE_RATE = 24000;
/** Speaking rate of the mock TTS. */
export const MOCK_TTS_CHARS_PER_SEC = 15;
export const MOCK_TTS_MIN_DURATION_SEC = 0.5;
export const MOCK_SFX_DEFAULT_DURATION_SEC = 1.5;

const GOLDEN_RATIO_FRACTION = 0.6180339887498949;
const AMPLITUDE = 0.3;
const FADE_SEC = 0.01;

/**
 * The base pitch of a take, between 220 and 660 Hz. Stepping by the golden ratio keeps
 * neighboring takes far apart and never repeats a pitch.
 */
export function mockTakeFrequency(take: number): number {
  return 220 + ((take * GOLDEN_RATIO_FRACTION) % 1) * 440;
}

export class MockTtsProvider implements TtsProvider {
  readonly id = MOCK_PROVIDER_ID;
  readonly paid = false;

  async synthesize(req: TtsRequest): Promise<AudioResult> {
    checkTake(req.take);
    const chars = [...req.text];
    const durationSec = Math.max(MOCK_TTS_MIN_DURATION_SEC, chars.length / MOCK_TTS_CHARS_PER_SEC);
    const base = mockTakeFrequency(req.take);
    // One "syllable" per 0.12 s, with a pitch that follows the text.
    const syllableSec = 0.12;
    const codes = chars.length > 0 ? chars.map((c) => c.codePointAt(0) ?? 0) : [0];
    return render(
      durationSec,
      (t) => {
        const index = Math.floor(t / syllableSec);
        const local = t - index * syllableSec;
        if (local > syllableSec - 0.02) return 0;
        const step = (codes[index % codes.length] ?? 0) % 5;
        const freq = base * 2 ** (step / 12);
        return Math.sin(2 * Math.PI * freq * t) * fade(local, syllableSec - 0.02);
      },
      req.take,
      { voiceId: req.voiceId },
    );
  }

  estimate(req: TtsRequest): Cost {
    return { characters: [...req.text].length, requests: 1 };
  }
}

export class MockSfxProvider implements SfxProvider {
  readonly id = MOCK_PROVIDER_ID;
  readonly paid = false;

  async generate(req: SfxRequest): Promise<AudioResult> {
    checkTake(req.take);
    const durationSec = req.durationSec ?? MOCK_SFX_DEFAULT_DURATION_SEC;
    checkDuration(durationSec);
    const base = mockTakeFrequency(req.take);
    // A falling sweep from two octaves up to the base pitch, with a decay.
    const k = Math.log(4) / durationSec;
    return render(
      durationSec,
      (t) => {
        const phase = (4 * base * (1 - Math.exp(-k * t))) / k;
        return Math.sin(2 * Math.PI * phase) * Math.exp((-3 * t) / durationSec);
      },
      req.take,
    );
  }

  estimate(req: SfxRequest): Cost {
    return { characters: [...req.prompt].length, requests: 1 };
  }
}

export class MockMusicProvider implements MusicProvider {
  readonly id = MOCK_PROVIDER_ID;
  readonly paid = false;

  async generate(req: MusicRequest): Promise<AudioResult> {
    checkTake(req.take);
    checkDuration(req.durationSec);
    const base = mockTakeFrequency(req.take) / 2;
    // A major arpeggio, one note per 0.25 s.
    const noteSec = 0.25;
    const ratios = [1, 5 / 4, 3 / 2, 2];
    return render(
      req.durationSec,
      (t) => {
        const index = Math.floor(t / noteSec);
        const local = t - index * noteSec;
        const freq = base * (ratios[index % ratios.length] ?? 1);
        return Math.sin(2 * Math.PI * freq * t) * fade(local, noteSec);
      },
      req.take,
    );
  }

  estimate(req: MusicRequest): Cost {
    return { characters: [...req.prompt].length, requests: 1 };
  }
}

export function createMockProviders(): ProviderSet {
  return { tts: new MockTtsProvider(), sfx: new MockSfxProvider(), music: new MockMusicProvider() };
}

registerProviders(MOCK_PROVIDER_ID, createMockProviders);

function render(
  durationSec: number,
  wave: (t: number) => number,
  take: number,
  meta: Record<string, unknown> = {},
): AudioResult {
  const count = Math.max(1, Math.round(durationSec * MOCK_SAMPLE_RATE));
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = i / MOCK_SAMPLE_RATE;
    samples[i] = AMPLITUDE * wave(t) * fade(t, count / MOCK_SAMPLE_RATE);
  }
  return {
    data: encodeWav(samples, MOCK_SAMPLE_RATE),
    format: "wav",
    // Exactly the length of the encoded audio, so that it matches the WAV header.
    durationSec: count / MOCK_SAMPLE_RATE,
    meta: { ...meta, provider: MOCK_PROVIDER_ID, take, frequencyHz: mockTakeFrequency(take) },
  };
}

/** A short linear fade in and out at the edges of a span, to avoid clicks. */
function fade(t: number, spanSec: number): number {
  return Math.max(0, Math.min(1, t / FADE_SEC, (spanSec - t) / FADE_SEC));
}

function checkTake(take: number): void {
  if (!Number.isInteger(take) || take < 0) {
    throw new Error(`Invalid take: ${take}. It must be a non-negative integer.`);
  }
}

function checkDuration(durationSec: number): void {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`Invalid durationSec: ${durationSec}. It must be a positive number.`);
  }
}

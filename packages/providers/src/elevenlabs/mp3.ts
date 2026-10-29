// MP3 duration by walking the MPEG audio frames. Only Layer III is supported, which is what
// ElevenLabs returns for its mp3_* output formats.

// Kilobits per second, by bitrate index. Index 0 (free) and 15 (bad) are not supported.
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
// Hertz, by sample rate index, for MPEG 1. MPEG 2 halves them and MPEG 2.5 quarters them.
const SAMPLE_RATES_V1 = [44100, 48000, 32000];

/** The byte range of the MPEG frames in MP3 data, and their duration in seconds. */
export type Mp3Frames = { start: number; end: number; durationSec: number };

/**
 * Finds the run of MPEG Layer III frames that starts after an optional ID3v2 tag, or throws if
 * there is none. Anything after the last whole frame, such as an ID3v1 tag, is outside the range.
 */
export function mp3Frames(data: Uint8Array): Mp3Frames {
  const start = id3v2Length(data);
  let offset = start;
  let frames = 0;
  let samples = 0;
  let sampleRate = 0;
  while (offset + 4 <= data.length) {
    const frame = parseFrameHeader(data, offset);
    if (!frame || offset + frame.length > data.length) break;
    frames++;
    samples += frame.samples;
    sampleRate = frame.sampleRate;
    offset += frame.length;
  }
  if (frames === 0) {
    throw new Error("The audio is not MP3: no MPEG Layer III frame found");
  }
  return { start, end: offset, durationSec: samples / sampleRate };
}

/**
 * Returns the duration in seconds of MP3 data, or throws if the data does not start with
 * MPEG Layer III frames (after an optional ID3v2 tag). Trailing bytes after the last frame,
 * such as an ID3v1 tag, are ignored.
 */
export function mp3DurationSec(data: Uint8Array): number {
  return mp3Frames(data).durationSec;
}

type FrameHeader = { length: number; samples: number; sampleRate: number };

function parseFrameHeader(data: Uint8Array, offset: number): FrameHeader | undefined {
  const b1 = data[offset] ?? 0;
  const b2 = data[offset + 1] ?? 0;
  const b3 = data[offset + 2] ?? 0;
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return undefined;
  const version = (b2 >> 3) & 0b11; // 0: MPEG 2.5, 1: reserved, 2: MPEG 2, 3: MPEG 1
  const layer = (b2 >> 1) & 0b11; // 1: Layer III
  if (version === 1 || layer !== 1) return undefined;
  const mpeg1 = version === 3;
  const bitrate = ((mpeg1 ? BITRATES_V1 : BITRATES_V2)[b3 >> 4] ?? 0) * 1000;
  const baseRate = SAMPLE_RATES_V1[(b3 >> 2) & 0b11];
  if (bitrate === 0 || baseRate === undefined) return undefined;
  const sampleRate = mpeg1 ? baseRate : version === 2 ? baseRate / 2 : baseRate / 4;
  const padding = (b3 >> 1) & 1;
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  return { length, samples, sampleRate };
}

/** The length of a leading ID3v2 tag, including its header and footer, or 0 if there is none. */
function id3v2Length(data: Uint8Array): number {
  if (data.length < 10 || data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return 0;
  // The size is a 28-bit "syncsafe" integer: 7 bits per byte.
  let size = 0;
  for (let i = 6; i < 10; i++) size = (size << 7) | ((data[i] ?? 0) & 0x7f);
  const hasFooter = ((data[5] ?? 0) & 0x10) !== 0;
  return 10 + size + (hasFooter ? 10 : 0);
}

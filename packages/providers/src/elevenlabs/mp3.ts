// MP3 duration by walking the MPEG audio frames. Only Layer III is supported, which is what
// ElevenLabs returns for its mp3_* output formats.

// Kilobits per second, by bitrate index. Index 0 (free) and 15 (bad) are not supported.
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
// Hertz, by sample rate index, for MPEG 1. MPEG 2 halves them and MPEG 2.5 quarters them.
const SAMPLE_RATES_V1 = [44100, 48000, 32000];

const ID3V1_LENGTH = 128;
const ID3V1_ENHANCED_LENGTH = 227;
const APE_FOOTER_LENGTH = 32;
/** Encoder strings that start a LAME-style tag with the encoder delay and padding. */
const LAME_ENCODERS = ["LAME", "Lavc", "Lavf"];

/**
 * The byte range of the MPEG frames in MP3 data, and the duration of the audio they hold. The
 * range keeps a leading Xing, Info, or VBRI header frame, since decoders need it.
 */
export type Mp3Frames = { start: number; end: number; durationSec: number };

/**
 * Finds the run of whole MPEG Layer III frames after an optional ID3v2 tag, or throws if there is
 * none. Trailing ID3v1 and APEv2 tags are removed first, so a truncated last frame cannot reach
 * into them, and an incomplete last frame is left out of the range.
 */
export function mp3Frames(data: Uint8Array): Mp3Frames {
  const start = id3v2Length(data);
  const limit = trailingTagsStart(data, start);
  let offset = start;
  let frames = 0;
  let sampleRate = 0;
  let samplesPerFrame = 0;
  let header: GaplessInfo | undefined;
  while (offset + 4 <= limit) {
    const frame = parseFrameHeader(data, offset);
    if (!frame || offset + frame.length > limit) break;
    if (frames === 0) header = gaplessInfo(data.subarray(offset, offset + frame.length), frame);
    frames++;
    sampleRate = frame.sampleRate;
    samplesPerFrame = frame.samples;
    offset += frame.length;
  }
  if (frames === 0) {
    throw new Error("The audio is not MP3: no MPEG Layer III frame found");
  }
  // A header frame holds no audio. The LAME tag in it says how many samples the encoder added.
  const audioFrames = header ? frames - 1 : frames;
  const trimmed = header ? header.delay + header.padding : 0;
  const samples = Math.max(0, audioFrames * samplesPerFrame - trimmed);
  return { start, end: offset, durationSec: samples / sampleRate };
}

/**
 * Returns the duration in seconds of MP3 data, or throws if the data does not start with
 * MPEG Layer III frames (after an optional ID3v2 tag). A Xing, Info, or VBRI header frame does
 * not count as audio, and the encoder delay and padding of a LAME tag are subtracted.
 */
export function mp3DurationSec(data: Uint8Array): number {
  return mp3Frames(data).durationSec;
}

type FrameHeader = {
  length: number;
  samples: number;
  sampleRate: number;
  /** Bytes from the frame start to the end of the side info, where a Xing or Info tag starts. */
  sideInfoEnd: number;
};

function parseFrameHeader(data: Uint8Array, offset: number): FrameHeader | undefined {
  const b1 = data[offset] ?? 0;
  const b2 = data[offset + 1] ?? 0;
  const b3 = data[offset + 2] ?? 0;
  const b4 = data[offset + 3] ?? 0;
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
  const crc = (b2 & 1) === 0 ? 2 : 0;
  const mono = b4 >> 6 === 0b11;
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return { length, samples, sampleRate, sideInfoEnd: 4 + crc + sideInfo };
}

type GaplessInfo = { delay: number; padding: number };

/**
 * If the frame is a Xing, Info, or VBRI header, returns the encoder delay and padding in samples
 * from its LAME tag, or zeros when there is none. Returns undefined for an audio frame.
 */
function gaplessInfo(frame: Uint8Array, header: FrameHeader): GaplessInfo | undefined {
  const none = { delay: 0, padding: 0 };
  // VBRI sits 32 bytes after the frame header, whatever the channel mode.
  if (ascii(frame, 4 + 32, 4) === "VBRI") return none;
  const xing = header.sideInfoEnd;
  const tag = ascii(frame, xing, 4);
  if (tag !== "Xing" && tag !== "Info") return undefined;
  const flags = readUint32(frame, xing + 4);
  let lame = xing + 8;
  if (flags & 0x1) lame += 4; // frame count
  if (flags & 0x2) lame += 4; // byte count
  if (flags & 0x4) lame += 100; // table of contents
  if (flags & 0x8) lame += 4; // quality
  if (!LAME_ENCODERS.includes(ascii(frame, lame, 4)) || lame + 24 > frame.length) return none;
  // 12 bits of delay, then 12 bits of padding, 21 bytes into the LAME tag.
  const b0 = frame[lame + 21] ?? 0;
  const b1 = frame[lame + 22] ?? 0;
  const b2 = frame[lame + 23] ?? 0;
  return { delay: (b0 << 4) | (b1 >> 4), padding: ((b1 & 0x0f) << 8) | b2 };
}

/**
 * Where the trailing tags start: an ID3v1 tag (with an optional enhanced TAG+ block before it),
 * and an APEv2 tag before that, if present. Never before `start`.
 */
function trailingTagsStart(data: Uint8Array, start: number): number {
  let end = data.length;
  if (end - ID3V1_LENGTH >= start && ascii(data, end - ID3V1_LENGTH, 3) === "TAG") {
    end -= ID3V1_LENGTH;
    const enhanced = end - ID3V1_ENHANCED_LENGTH;
    if (enhanced >= start && ascii(data, enhanced, 4) === "TAG+") end = enhanced;
  }
  const footer = end - APE_FOOTER_LENGTH;
  if (footer >= start && ascii(data, footer, 8) === "APETAGEX") {
    // The size counts the items and the footer. A header, when flagged, adds 32 more bytes.
    const size = readUint32LE(data, footer + 12);
    const hasHeader = ((data[footer + 23] ?? 0) & 0x80) !== 0;
    const tagStart = end - size - (hasHeader ? APE_FOOTER_LENGTH : 0);
    end = Math.max(start, Math.min(footer, tagStart));
  }
  return end;
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > data.length) return "";
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    (((data[offset] ?? 0) << 24) >>> 0) +
    ((data[offset + 1] ?? 0) << 16) +
    ((data[offset + 2] ?? 0) << 8) +
    (data[offset + 3] ?? 0)
  );
}

function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] ?? 0) +
    ((data[offset + 1] ?? 0) << 8) +
    ((data[offset + 2] ?? 0) << 16) +
    (((data[offset + 3] ?? 0) << 24) >>> 0)
  );
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

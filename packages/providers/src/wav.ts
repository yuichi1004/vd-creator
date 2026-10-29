// Minimal PCM WAV encoder and header reader, with no dependency.

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;

export type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationSec: number;
};

/** Encodes mono samples in [-1, 1] as a 16-bit PCM WAV file. Values outside the range are clipped. */
export function encodeWav(samples: ArrayLike<number>, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid WAV sample rate: ${sampleRate}`);
  }
  const channels = 1;
  const blockAlign = channels * (BITS_PER_SAMPLE / 8);
  const dataBytes = samples.length * blockAlign;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(HEADER_BYTES + i * 2, Math.round(s * 32767), true);
  }
  return bytes;
}

/** Reads the format and duration of a PCM WAV file. Throws if the data is not a valid WAV. */
export function readWavInfo(data: Uint8Array): WavInfo {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 12 || readAscii(view, 0) !== "RIFF" || readAscii(view, 8) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  if (view.getUint32(4, true) + 8 !== data.byteLength) {
    throw new Error("RIFF size does not match the data length");
  }

  let format: Omit<WavInfo, "dataBytes" | "durationSec"> | undefined;
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const id = readAscii(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > data.byteLength) {
      throw new Error(`WAV chunk "${id}" runs past the end of the data`);
    }
    if (id === "fmt ") {
      if (size < 16 || view.getUint16(body, true) !== 1) {
        throw new Error("Only PCM WAV is supported");
      }
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) {
        throw new Error('WAV "data" chunk comes before "fmt "');
      }
      const bytesPerSecond = format.sampleRate * format.channels * (format.bitsPerSample / 8);
      return { ...format, dataBytes: size, durationSec: size / bytesPerSecond };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no "data" chunk');
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function readAscii(view: DataView, offset: number): string {
  let text = "";
  for (let i = 0; i < 4; i++) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}

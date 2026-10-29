import { describe, expect, test } from "vitest";
import { encodeWav, readWavInfo } from "./wav.js";

describe("encodeWav", () => {
  test("writes a 16-bit mono PCM header", () => {
    const data = encodeWav(new Float32Array(8000), 8000);
    expect(data.byteLength).toBe(44 + 16000);
    expect(readWavInfo(data)).toEqual({
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 16000,
      durationSec: 1,
    });
  });

  test("writes every fixed header field", () => {
    const data = encodeWav(new Float32Array(1000), 22050);
    const view = new DataView(data.buffer);
    const ascii = (offset: number) => new TextDecoder().decode(data.subarray(offset, offset + 4));
    expect(ascii(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 2000); // RIFF size
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(22050); // sample rate
    expect(view.getUint32(28, true)).toBe(44100); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(2000); // data size
  });

  test("clips samples outside [-1, 1]", () => {
    const data = encodeWav([2, -2, 0.5], 8000);
    const view = new DataView(data.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
    expect(view.getInt16(48, true)).toBe(16384);
  });

  test("rejects an invalid sample rate", () => {
    expect(() => encodeWav([0], 0)).toThrow(/sample rate/);
  });
});

describe("readWavInfo", () => {
  test("rejects data that is not a WAV", () => {
    expect(() => readWavInfo(new TextEncoder().encode("not a wav file at all"))).toThrow(/RIFF/);
  });

  test("rejects a truncated WAV", () => {
    const data = encodeWav(new Float32Array(100), 8000);
    expect(() => readWavInfo(data.subarray(0, 100))).toThrow();
  });
});

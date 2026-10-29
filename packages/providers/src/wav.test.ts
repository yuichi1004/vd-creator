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

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Timeline } from "@vd-creator/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { jpegOrientation, ORIENTATION_FILTERS, readImageOrientations } from "./exif.js";

/** The bytes of a 16-bit number in a byte order. */
function u16(value: number, little: boolean): number[] {
  return little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff];
}

/** A TIFF block with one IFD of `entries`, each [tag, type, value]. */
function tiff(entries: [number, number, number][], little = false): number[] {
  const bytes = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42, little)];
  bytes.push(...(little ? [8, 0, 0, 0] : [0, 0, 0, 8]), ...u16(entries.length, little));
  for (const [tag, type, value] of entries) {
    bytes.push(
      ...u16(tag, little),
      ...u16(type, little),
      ...(little ? [1, 0, 0, 0] : [0, 0, 0, 1]),
    );
    bytes.push(...u16(value, little), 0, 0);
  }
  return [...bytes, 0, 0, 0, 0];
}

/** A segment with a marker and a payload. */
function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16(payload.length + 2, false), ...payload];
}

const EXIF = [0x45, 0x78, 0x69, 0x66, 0, 0];
const JFIF = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const START_OF_SCAN = [0xff, 0xda, 0, 2, 0x12, 0x34];

function jpeg(...segments: number[][]): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...segments.flat(), ...START_OF_SCAN]);
}

describe("jpegOrientation", () => {
  test("reads the orientation of a big- or little-endian EXIF segment", () => {
    for (let orientation = 1; orientation <= 8; orientation++) {
      expect(
        jpegOrientation(jpeg(segment(0xe1, [...EXIF, ...tiff([[0x0112, 3, orientation]])]))),
      ).toBe(orientation);
      expect(
        jpegOrientation(
          jpeg(JFIF, segment(0xe1, [...EXIF, ...tiff([[0x0112, 3, orientation]], true)])),
        ),
      ).toBe(orientation);
    }
  });

  test("finds the orientation after other tags and other APP1 segments", () => {
    const xmp = segment(0xe1, [...Buffer.from("http://ns.adobe.com/xap/1.0/\0")]);
    const exif = segment(0xe1, [
      ...EXIF,
      ...tiff([
        [0x010f, 3, 1],
        [0x0112, 3, 6],
      ]),
    ]);
    expect(jpegOrientation(jpeg(JFIF, xmp, exif))).toBe(6);
  });

  test("is 1 for a file with no or no valid orientation", () => {
    const bad = (entries: [number, number, number][]) =>
      jpegOrientation(jpeg(segment(0xe1, [...EXIF, ...tiff(entries)])));
    expect(jpegOrientation(jpeg(JFIF))).toBe(1);
    expect(bad([[0x0112, 3, 9]])).toBe(1);
    expect(bad([[0x0112, 3, 0]])).toBe(1);
    // A LONG is not the SHORT that the orientation is.
    expect(bad([[0x0112, 4, 6]])).toBe(1);
    // EXIF after the image data is not read.
    const late = Uint8Array.from([
      ...jpeg(JFIF),
      ...segment(0xe1, [...EXIF, ...tiff([[0x0112, 3, 6]])]),
    ]);
    expect(jpegOrientation(late)).toBe(1);
  });

  test("is 1 for a file that is not a JPEG or is cut short", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(jpegOrientation(png)).toBe(1);
    expect(jpegOrientation(new Uint8Array())).toBe(1);
    const full = jpeg(segment(0xe1, [...EXIF, ...tiff([[0x0112, 3, 6]])]));
    for (let length = 0; length < full.length - START_OF_SCAN.length; length++) {
      expect(jpegOrientation(full.subarray(0, length))).toBe(1);
    }
    // A wrong IFD offset points past the segment.
    const exif = [...EXIF, ...tiff([[0x0112, 3, 6]])];
    const farIfd = [...exif];
    farIfd[EXIF.length + 7] = 200;
    expect(jpegOrientation(jpeg(segment(0xe1, farIfd)))).toBe(1);
    // An entry count past the segment, with no orientation before the end.
    const manyEntries = [...EXIF, ...tiff([[0x010f, 3, 1]])];
    manyEntries[EXIF.length + 9] = 50;
    expect(jpegOrientation(jpeg(segment(0xe1, manyEntries)))).toBe(1);
  });

  test("has a filter for every orientation that turns the image", () => {
    expect(Object.keys(ORIENTATION_FILTERS).map(Number)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("readImageOrientations", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vd-render-exif-"));
    await mkdir(join(dir, "assets", "images"), { recursive: true });
    const exif = (orientation: number) =>
      jpeg(segment(0xe1, [...EXIF, ...tiff([[0x0112, 3, orientation]])]));
    await writeFile(join(dir, "assets", "images", "side.jpg"), exif(8));
    await writeFile(join(dir, "assets", "images", "upright.jpg"), exif(1));
    await writeFile(join(dir, "assets", "images", "plain.jpg"), jpeg(JFIF));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("lists the shown images that need turning, and skips files it cannot read", async () => {
    const files = ["side.jpg", "upright.jpg", "plain.jpg", "gone.jpg", "side.jpg"];
    const timeline: Timeline = {
      items: [],
      bgm: [],
      scenes: [],
      durationSec: files.length,
      images: [
        ...files.map((file, i) => ({
          imageId: String(i),
          file: `images/${file}`,
          startSec: i,
          endSec: i + 1,
        })),
        { imageId: "none", startSec: 5, endSec: 5 },
      ],
    };
    expect(await readImageOrientations(dir, timeline)).toEqual(new Map([["images/side.jpg", 8]]));
  });
});

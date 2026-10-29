// The EXIF orientation of JPEG images, so that a phone photo is not shown on its side.

import { open } from "node:fs/promises";
import { join } from "node:path";
import { ASSETS_DIR, type Timeline } from "@vd-creator/core";

/**
 * The ffmpeg filters that turn an image with an EXIF orientation upright. Orientation 1, and
 * any value that is not listed, needs none.
 */
export const ORIENTATION_FILTERS: Readonly<Record<number, string>> = {
  2: "hflip",
  3: "hflip,vflip",
  4: "vflip",
  5: "transpose=cclock_flip",
  6: "transpose=clock",
  7: "transpose=clock_flip",
  8: "transpose=cclock",
};

/** How much of an image file is read to find its EXIF data, which comes before the pixels. */
const HEAD_BYTES = 256 * 1024;
const ORIENTATION_TAG = 0x0112;
const TYPE_SHORT = 3;

/**
 * The EXIF orientation, 1 to 8, of a JPEG file from its first bytes. A file that is not a JPEG,
 * or has no valid orientation, has 1.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return 1;
    const marker = bytes[at + 1] as number;
    // A fill byte before a marker.
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Markers without a length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // The image data starts, or the image ends, with no EXIF before it.
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = view.getUint16(at + 2);
    if (length < 2) return 1;
    const end = at + 2 + length;
    if (marker === 0xe1 && end <= bytes.length && isExifHeader(bytes, at + 4)) {
      const orientation = tiffOrientation(view, at + 10, end);
      if (orientation !== undefined) return orientation;
    }
    at = end;
  }
  return 1;
}

/** Whether `Exif\0\0` starts at `at`. */
function isExifHeader(bytes: Uint8Array, at: number): boolean {
  const header = [0x45, 0x78, 0x69, 0x66, 0, 0];
  return header.every((b, i) => bytes[at + i] === b);
}

/** The orientation in the first IFD of the TIFF data from `start` to `end`, if it is valid. */
function tiffOrientation(view: DataView, start: number, end: number): number | undefined {
  if (start + 8 > end) return undefined;
  const order = view.getUint16(start);
  if (order !== 0x4949 && order !== 0x4d4d) return undefined;
  const little = order === 0x4949;
  if (view.getUint16(start + 2, little) !== 42) return undefined;
  const ifd = start + view.getUint32(start + 4, little);
  if (ifd + 2 > end) return undefined;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return undefined;
    if (view.getUint16(entry, little) !== ORIENTATION_TAG) continue;
    if (view.getUint16(entry + 2, little) !== TYPE_SHORT) return undefined;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}

/**
 * The EXIF orientations of the images shown in a timeline, by their file relative to
 * `<projectDir>/assets/`. Only images that need turning are listed. A file that cannot be read
 * is left out: the render that reads it reports it.
 */
export async function readImageOrientations(
  projectDir: string,
  timeline: Timeline,
): Promise<Map<string, number>> {
  const orientations = new Map<string, number>();
  const files = new Set(timeline.images.flatMap((span) => span.file ?? []));
  for (const file of files) {
    const orientation = await readHead(join(projectDir, ASSETS_DIR, file)).then(
      jpegOrientation,
      () => 1,
    );
    if (orientation !== 1) orientations.set(file, orientation);
  }
  return orientations;
}

/** The first `HEAD_BYTES` of a file. */
async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

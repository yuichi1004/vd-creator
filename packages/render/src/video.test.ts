import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import { AssetCache, defaultResolvers, runGeneration, type Timeline } from "@vd-creator/core";
import { createMockProviders } from "@vd-creator/providers";
import { loadScenario } from "@vd-creator/scenario";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RenderError } from "./errors.js";
import { FfmpegError } from "./ffmpeg.js";
import * as render from "./index.js";
import { buildVideoArgs, renderVideo } from "./video.js";

const run = promisify(execFile);

function timeline(images: Timeline["images"], durationSec: number): Timeline {
  return { items: [], images, bgm: [], scenes: [], durationSec };
}

const OPTIONS = { audio: "out/drama.mp3", output: "out/drama.mp4", stillsDir: "out/stills" };

/** The concat list as [still, frames] pairs, checking the repeated last entry. */
function listed(concatList: string): [string, number][] {
  const lines = concatList.trim().split("\n");
  expect(lines[0]).toBe("ffconcat version 1.0");
  const pairs: [string, number][] = [];
  for (let i = 1; i + 1 < lines.length; i += 2) {
    const still = /^file (\S+)$/.exec(lines[i] as string)?.[1] as string;
    const sec = Number(/^duration ([\d.]+)$/.exec(lines[i + 1] as string)?.[1]);
    pairs.push([still, Math.round(sec * 30)]);
  }
  expect(lines.at(-1)).toBe(`file ${pairs.at(-1)?.[0]}`);
  return pairs;
}

describe("buildVideoArgs", () => {
  test("makes one fitted still per distinct image and lists each span with its frames", () => {
    const { stills, concatList } = buildVideoArgs(
      timeline(
        [
          { imageId: "a", file: "images/a.png", startSec: 0, endSec: 2 },
          { imageId: "b", file: "images/b.jpg", startSec: 2, endSec: 5 },
          { imageId: "a", file: "images/a.png", startSec: 5, endSec: 6 },
        ],
        6,
      ),
      OPTIONS,
    );
    expect(stills).toHaveLength(2);
    expect(stills[0]).toEqual([
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-noautorotate",
      "-f",
      "image2",
      "-pattern_type",
      "none",
      "-i",
      join("assets", "images/a.png"),
      "-filter_complex",
      "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease[img];" +
        "color=c=black:s=1920x1080[bg];[bg][img]overlay=(W-w)/2:(H-h)/2:shortest=1,setsar=1,format=rgb24",
      "-frames:v",
      "1",
      "-update",
      "1",
      "-c:v",
      "png",
      "-f",
      "image2",
      join("out/stills", "0.png"),
    ]);
    expect(stills[1]).toContain(join("assets", "images/b.jpg"));
    expect(stills[1]?.at(-1)).toBe(join("out/stills", "1.png"));
    expect(listed(concatList)).toEqual([
      ["0.png", 60],
      ["1.png", 90],
      ["0.png", 30],
    ]);
  });

  test("turns each image upright by its EXIF orientation before fitting it", () => {
    const images = ["a.jpg", "b.jpg", "c.png"].map((file, i) => ({
      imageId: String(i),
      file: `images/${file}`,
      startSec: i,
      endSec: i + 1,
    }));
    const { stills } = buildVideoArgs(timeline(images, 3), {
      ...OPTIONS,
      orientations: new Map([
        ["images/a.jpg", 6],
        ["images/b.jpg", 3],
      ]),
    });
    const graph = (i: number) => stills[i]?.[(stills[i]?.indexOf("-filter_complex") ?? 0) + 1];
    expect(graph(0)).toMatch(/^\[0:v\]transpose=clock,scale=1920:1080:/);
    expect(graph(1)).toMatch(/^\[0:v\]hflip,vflip,scale=1920:1080:/);
    expect(graph(2)).toMatch(/^\[0:v\]scale=1920:1080:/);
    // ffmpeg itself never turns the image too.
    for (const still of stills.slice(0, 3)) {
      expect(still.indexOf("-noautorotate")).toBeLessThan(still.indexOf("-i"));
    }
  });

  test("encodes the list and the audio as H.264 for still images with AAC into an MP4", () => {
    const { args } = buildVideoArgs(timeline([], 1.5), OPTIONS);
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    const inputs = args.flatMap((a, i) => (a === "-i" ? [args[i + 1]] : []));
    expect(inputs).toEqual(["out/drama.mp3", join("out/stills", "list.txt")]);
    expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4)).toEqual([
      "-map",
      "1:v",
      "-map",
      "0:a",
    ]);
    expect(after("-frames:v")).toBe("45");
    expect(after("-c:v")).toBe("libx264");
    expect(after("-tune")).toBe("stillimage");
    expect(after("-pix_fmt")).toBe("yuv420p");
    expect(after("-r")).toBe("30");
    expect(after("-c:a")).toBe("aac");
    expect(args.slice(-3)).toEqual(["-f", "mp4", "out/drama.mp4"]);
  });

  test("fills the time before the first image with black", () => {
    const { stills, concatList } = buildVideoArgs(
      timeline([{ imageId: "a", file: "a.png", startSec: 1.5, endSec: 4 }], 4),
      OPTIONS,
    );
    expect(stills).toHaveLength(2);
    expect(stills[1]).toEqual([
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1920x1080",
      "-frames:v",
      "1",
      "-update",
      "1",
      "-c:v",
      "png",
      "-f",
      "image2",
      join("out/stills", "black.png"),
    ]);
    expect(listed(concatList)).toEqual([
      ["black.png", 45],
      ["0.png", 75],
    ]);
  });

  test("shows black for the whole timeline when it has no images", () => {
    const { stills, concatList } = buildVideoArgs(timeline([], 2), OPTIONS);
    expect(stills).toHaveLength(1);
    expect(listed(concatList)).toEqual([["black.png", 60]]);
  });

  test("makes at least one frame from a timeline under half a frame", () => {
    const { args, concatList } = buildVideoArgs(timeline([], 0.01), OPTIONS);
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    expect(listed(concatList)).toEqual([["black.png", 1]]);
  });

  test("rounds span ends from the start, so the frames add up to the timeline", () => {
    const images = [0, 1, 2, 3, 4, 5].map((i) => ({
      imageId: `i${i}`,
      file: `${i}.png`,
      startSec: i * 0.345,
      endSec: (i + 1) * 0.345,
    }));
    const { concatList } = buildVideoArgs(timeline(images, 6 * 0.345), OPTIONS);
    const frames = listed(concatList).map(([, f]) => f);
    expect(frames.reduce((a, b) => a + b, 0)).toBe(Math.round(6 * 0.345 * 30));
  });

  test("drops spans under a frame or past the end, and fills gaps with black", () => {
    const { stills, concatList } = buildVideoArgs(
      timeline(
        [
          { imageId: "a", file: "a.png", startSec: 0, endSec: 0.01 },
          { imageId: "b", file: "b.png", startSec: 0.01, endSec: 1 },
          { imageId: "c", startSec: 1, endSec: 2 },
          { imageId: "d", file: "d.png", startSec: 2, endSec: 3 },
          { imageId: "e", file: "e.png", startSec: 2.99, endSec: 3.5 },
        ],
        3,
      ),
      OPTIONS,
    );
    expect(listed(concatList)).toEqual([
      ["0.png", 30],
      ["black.png", 30],
      ["1.png", 30],
    ]);
    // Only the images that are shown are made into stills.
    expect(stills.map((s) => s[s.indexOf("-i") + 1])).toEqual([
      join("assets", "b.png"),
      join("assets", "d.png"),
      "color=c=black:s=1920x1080",
    ]);
  });

  test("keeps scenario file names out of the concat list", () => {
    const { concatList } = buildVideoArgs(
      timeline([{ imageId: "a", file: "it's a\nfile 'x.png", startSec: 0, endSec: 1 }], 1),
      OPTIONS,
    );
    expect(concatList).toBe("ffconcat version 1.0\nfile 0.png\nduration 1.000000\nfile 0.png\n");
  });

  test("uses the given assets folder", () => {
    const { stills } = buildVideoArgs(
      timeline([{ imageId: "a", file: "a.png", startSec: 0, endSec: 1 }], 1),
      { ...OPTIONS, assetsDir: "media" },
    );
    expect(stills[0]).toContain(join("media", "a.png"));
  });

  test("throws a RenderError for an empty timeline", () => {
    expect(() => buildVideoArgs(timeline([], 0), OPTIONS)).toThrow(RenderError);
  });

  test("is exported from the package index", () => {
    expect(render.buildVideoArgs).toBe(buildVideoArgs);
    expect(render.renderVideo).toBe(renderVideo);
  });
});

// The wide image is transparent and is shown twice; the screen is black before it.
const YAML = `
version: 1
title: Video
speakers:
  - id: a
    name: Ann
    voice: { provider: mock, voiceId: v1 }
images:
  - id: wide
    file: images/wide.png
  - id: tall
    file: images/tall.jpg
scenes:
  - id: s1
    items:
      - line: The screen is dark at first.
        id: l1
        speaker: a
      - image: wide
      - line: Then a wide picture appears.
        id: l2
        speaker: a
      - pause: 1
      - image: tall
      - line: And a tall one.
        id: l3
        speaker: a
      - image: wide
      - line: And the wide one again.
        id: l4
        speaker: a
`;

const resolvers = defaultResolvers(createMockProviders());

async function probe(file: string, entries: string, stream?: string): Promise<string[]> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    ...(stream ? ["-select_streams", stream] : []),
    "-show_entries",
    entries,
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return stdout.trim().split("\n");
}

/** The gray level, 0 to 255, of the center pixel of the video at a time. */
function centerGray(file: string, sec: number): Promise<number> {
  return grayAt(file, sec, 959, 539);
}

/** The gray level, 0 to 255, of the pixel at `x`, `y` of the video at a time. */
async function grayAt(file: string, sec: number, x: number, y: number): Promise<number> {
  const { stdout } = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-ss",
      String(sec),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `crop=2:2:${x}:${y},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer" },
  );
  return stdout[0] as number;
}

/** A JPEG file with an EXIF APP1 segment that holds only `orientation`, added after its SOI. */
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const exif = Buffer.from([
    0xff,
    0xe1,
    0,
    34,
    0x45,
    0x78,
    0x69,
    0x66,
    0,
    0,
    // A big-endian TIFF header and one IFD with one entry: tag 0x0112, SHORT, count 1.
    0x4d,
    0x4d,
    0,
    42,
    0,
    0,
    0,
    8,
    0,
    1,
    0x01,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    orientation,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

/** Makes a project with generated mock audio and, if asked, two images of other sizes. */
async function mockProject(prefix: string, images: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(dir, "scenario.yaml"), YAML);
  const { scenario } = await loadScenario(dir);
  if (!scenario) throw new Error("invalid test scenario");
  const result = await runGeneration(scenario, await AssetCache.load(dir), resolvers);
  expect(result.failed).toBe(0);
  if (images) {
    await mkdir(join(dir, "assets", "images"), { recursive: true });
    for (const [file, source] of [
      ["wide.png", "color=c=white@0.0:s=800x300,format=rgba"],
      ["tall.jpg", "color=c=white:s=400x900"],
    ] as const) {
      await run("ffmpeg", [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        source,
        "-frames:v",
        "1",
        join(dir, "assets", "images", file),
      ]);
    }
  }
  return dir;
}

describe("renderVideo", { timeout: 120_000 }, () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mockProject("vd-render-video-", true);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("renders a 1920x1080 MP4 as long as the audio", async () => {
    const result = await renderVideo(dir, { resolvers });
    expect(result.file).toBe("out/drama.mp4");
    expect(result.audio.file).toBe("out/drama.mp3");
    const spans = result.audio.timeline.images;
    expect(spans.map((s) => s.imageId)).toEqual(["wide", "tall", "wide"]);
    expect(spans[0]?.startSec).toBeGreaterThan(0);

    const video = join(dir, result.file);
    const [codec, width, height, pixFmt] = await probe(
      video,
      "stream=codec_name,width,height,pix_fmt",
      "v:0",
    );
    expect({ codec, width, height, pixFmt }).toEqual({
      codec: "h264",
      width: "1920",
      height: "1080",
      pixFmt: "yuv420p",
    });
    expect(await probe(video, "stream=codec_name", "a:0")).toEqual(["aac"]);
    const [videoSec] = (await probe(video, "format=duration")).map(Number);
    const [audioSec] = (await probe(join(dir, result.audio.file), "format=duration")).map(Number);
    expect(Math.abs((videoSec as number) - (audioSec as number))).toBeLessThan(0.1);
    expect(Math.abs((videoSec as number) - result.audio.timeline.durationSec)).toBeLessThan(0.1);
    expect((await readdir(join(dir, "out"))).sort()).toEqual(["drama.mp3", "drama.mp4"]);

    // Black before the first image, black where the image is transparent, white for the JPEG.
    const middle = (i: number) => ((spans[i]?.startSec ?? 0) + (spans[i]?.endSec ?? 0)) / 2;
    expect(await centerGray(video, (spans[0]?.startSec ?? 0) / 2)).toBeLessThan(30);
    expect(await centerGray(video, middle(0))).toBeLessThan(30);
    expect(await centerGray(video, middle(1))).toBeGreaterThan(220);
  });

  test("uses WAV audio too", async () => {
    const result = await renderVideo(dir, { resolvers, format: "wav" });
    expect(result.audio.file).toBe("out/drama.wav");
    const [videoSec] = (await probe(join(dir, result.file), "format=duration")).map(Number);
    expect(Math.abs((videoSec as number) - result.audio.timeline.durationSec)).toBeLessThan(0.1);
  });

  test("reports a missing image by its relative path and keeps no partial output", async () => {
    const broken = await mockProject("vd-render-video-broken-", false);
    try {
      const error = await renderVideo(broken, { resolvers }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FfmpegError);
      const shown = inspect(error, { depth: Number.POSITIVE_INFINITY, showHidden: true });
      expect(shown).toContain("assets/images/wide.png");
      expect(shown).not.toContain(broken);
      expect(shown).not.toContain(tmpdir());
      expect((error as RenderError).cause).not.toBeInstanceOf(Error);
      // Neither the audio nor the video replaces an output, and the temporary files are removed.
      expect(await readdir(join(broken, "out"))).toEqual([]);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  test("keeps the previous audio and video when the video fails", async () => {
    const project = await mockProject("vd-render-video-pair-", true);
    try {
      await renderVideo(project, { resolvers });
      const files = ["drama.mp3", "drama.mp4"].map((f) => join(project, "out", f));
      const before = await Promise.all(files.map((f) => stat(f)));
      await rm(join(project, "assets", "images", "tall.jpg"));

      const error = await renderVideo(project, { resolvers }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FfmpegError);
      expect((await readdir(join(project, "out"))).sort()).toEqual(["drama.mp3", "drama.mp4"]);
      // Both are the files of the first render: a rename would give each a new inode.
      const after = await Promise.all(files.map((f) => stat(f)));
      expect(after.map((s) => s.ino)).toEqual(before.map((s) => s.ino));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("shows a JPEG upright by its EXIF orientation", async () => {
    const project = await mockProject("vd-render-video-exif-", true);
    try {
      // A tall image, white on top and black below. Orientation 6 turns it clockwise to a wide
      // one, white on the right; shown as stored, it is a narrow strip with black at both sides.
      const tall = join(project, "assets", "images", "tall.jpg");
      await run("ffmpeg", [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:s=400x900,drawbox=x=0:y=450:w=400:h=450:color=black:t=fill",
        "-frames:v",
        "1",
        tall,
      ]);
      await writeFile(tall, withOrientation(await readFile(tall), 6));

      const result = await renderVideo(project, { resolvers });
      const span = result.audio.timeline.images[1];
      const sec = ((span?.startSec ?? 0) + (span?.endSec ?? 0)) / 2;
      const video = join(project, result.file);
      expect(await grayAt(video, sec, 1500, 539)).toBeGreaterThan(220);
      expect(await grayAt(video, sec, 400, 539)).toBeLessThan(30);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("passes on the audio's errors without absolute paths", async () => {
    const missing = join(tmpdir(), "vd-render-video-missing-alice", "drama");
    const error = await renderVideo(missing, { resolvers }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenderError);
    const shown = inspect(error, { depth: Number.POSITIVE_INFINITY, showHidden: true });
    expect(shown).toContain("Could not read scenario.yaml (ENOENT)");
    expect(shown).not.toContain("alice");
  });
});

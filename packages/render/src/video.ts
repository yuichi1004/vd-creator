// The video export: the timeline's still images over the mixed audio.
// See "Video" in docs/plans/0006-rendering.md.

import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ASSETS_DIR, type ImageSpan, type Timeline } from "@vd-creator/core";
import { OUT_BASENAME, OUT_DIR } from "./audio.js";
import { RenderError, stepError } from "./errors.js";
import { ORIENTATION_FILTERS, readImageOrientations } from "./exif.js";
import { runFfmpeg } from "./ffmpeg.js";
import type { RenderAudioOptions, RenderAudioResult } from "./render-audio.js";
import {
  audioFile,
  inProject,
  loadRenderProject,
  mixAudio,
  prepareOutDir,
  removeQuietly,
} from "./steps.js";

export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const VIDEO_FPS = 30;
export const AAC_BITRATE = "192k";
/** Name of the concat list in the stills folder. */
export const CONCAT_LIST = "list.txt";
/** Name of the black still in the stills folder. */
const BLACK_STILL = "black.png";

export type VideoOptions = {
  /** The mixed audio file, as ffmpeg sees it. */
  audio: string;
  /** The output file, as ffmpeg sees it. It is always written as MP4. */
  output: string;
  /**
   * A folder for the stills and the concat list, as ffmpeg sees it. The caller creates it
   * before the stills are made and removes it afterwards.
   */
  stillsDir: string;
  /** The folder that image files are relative to, as ffmpeg sees it. Default "assets". */
  assetsDir?: string;
  /**
   * The EXIF orientations of image files, as `readImageOrientations` finds them. Each listed
   * image is turned upright before it is fitted.
   */
  orientations?: ReadonlyMap<string, number>;
};

export type VideoCommands = {
  /**
   * The ffmpeg arguments, without the program name, that make each still, run before `args`:
   * one per distinct image file, fitted to the video size, and a black one if it is used.
   */
  stills: string[][];
  /** The text of the concat list, to be written to `CONCAT_LIST` in the stills folder. */
  concatList: string;
  /** The ffmpeg arguments that encode the stills and the audio into the video. */
  args: string[];
};

/** The filters, each followed by a comma, that turn an image with an EXIF orientation upright. */
function upright(orientation: number | undefined): string {
  const filters = orientation === undefined ? undefined : ORIENTATION_FILTERS[orientation];
  return filters === undefined ? "" : `${filters},`;
}

/** A run of frames that shows one still. */
type Segment = { still: string; frames: number };

/** An image span with a file, which is shown. */
function isShown(span: ImageSpan): span is ImageSpan & { file: string } {
  return span.file !== undefined;
}

/**
 * The frames of the video: one segment per image span with a file, and black wherever no image
 * is shown, such as before the first image. Span ends are rounded to whole frames from the
 * start of the timeline, so rounding never adds up and the frames sum to `total`.
 */
function segments(timeline: Timeline, still: (file: string) => string, total: number): Segment[] {
  const frame = (sec: number) => Math.round(sec * VIDEO_FPS);
  const result: Segment[] = [];
  let at = 0;
  for (const span of timeline.images.filter(isShown)) {
    const from = Math.min(total, Math.max(at, frame(span.startSec)));
    const to = Math.min(total, frame(span.endSec));
    if (to <= from) continue;
    if (from > at) result.push({ still: BLACK_STILL, frames: from - at });
    result.push({ still: still(span.file), frames: to - from });
    at = to;
  }
  if (at < total) result.push({ still: BLACK_STILL, frames: total - at });
  return result;
}

/**
 * The ffmpeg runs that make an MP4 from a timeline's images and the mixed audio.
 *
 * Each distinct image file is decoded once, turned upright by its orientation in
 * `options.orientations`, and fitted to `VIDEO_WIDTH`x`VIDEO_HEIGHT` without cropping, over black, so that transparent parts show black. The stills are PNG files in the
 * stills folder, which have the same size and format, as the concat demuxer needs. The concat
 * list shows each still for its frames, and black wherever no image is shown. The video is
 * H.264 (`yuv420p`, `VIDEO_FPS` fps, `-tune stillimage`) with the audio as AAC, and has the
 * timeline's length, rounded to a frame. Throws a `RenderError` if the timeline has no length.
 */
export function buildVideoArgs(timeline: Timeline, options: VideoOptions): VideoCommands {
  if (!(timeline.durationSec > 0))
    throw new RenderError("The timeline is empty: nothing to render");
  const assetsDir = options.assetsDir ?? ASSETS_DIR;
  const head = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  const black = `color=c=black:s=${VIDEO_WIDTH}x${VIDEO_HEIGHT}`;
  const pngOut = (name: string) => [
    "-frames:v",
    "1",
    "-update",
    "1",
    "-c:v",
    "png",
    "-f",
    "image2",
    join(options.stillsDir, name),
  ];

  // Stills are named by their order, so no file name from the scenario reaches the list.
  const names = new Map<string, string>();
  const still = (file: string) => {
    let name = names.get(file);
    if (name === undefined) {
      name = `${names.size}.png`;
      names.set(file, name);
    }
    return name;
  };
  // At least one frame, so that a timeline under half a frame still makes a video.
  const total = Math.max(1, Math.round(timeline.durationSec * VIDEO_FPS));
  const parts = segments(timeline, still, total);

  const stills = [...names].map(([file, name]) => [
    ...head,
    // The orientation is applied by the filters below only, never also by ffmpeg.
    "-noautorotate",
    // image2 with no pattern, so a "%" in a file name is not read as a sequence.
    "-f",
    "image2",
    "-pattern_type",
    "none",
    "-i",
    join(assetsDir, file),
    "-filter_complex",
    `[0:v]${upright(options.orientations?.get(file))}scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease[img];` +
      `${black}[bg];[bg][img]overlay=(W-w)/2:(H-h)/2:shortest=1,setsar=1,format=rgb24`,
    ...pngOut(name),
  ]);
  if (parts.some((p) => p.still === BLACK_STILL)) {
    stills.push([...head, "-f", "lavfi", "-i", black, ...pngOut(BLACK_STILL)]);
  }

  // Paths in the list are relative to the list's folder. The last still is listed again, as
  // the concat demuxer otherwise ignores the last duration.
  const lines = ["ffconcat version 1.0"];
  for (const part of parts) {
    lines.push(`file ${part.still}`, `duration ${(part.frames / VIDEO_FPS).toFixed(6)}`);
  }
  lines.push(`file ${parts.at(-1)?.still ?? BLACK_STILL}`);

  const args = [
    ...head,
    "-i",
    options.audio,
    "-f",
    "concat",
    "-i",
    join(options.stillsDir, CONCAT_LIST),
    "-map",
    "1:v",
    "-map",
    "0:a",
    "-vf",
    `fps=${VIDEO_FPS},format=yuv420p`,
    "-frames:v",
    String(total),
    "-c:v",
    "libx264",
    "-tune",
    "stillimage",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(VIDEO_FPS),
    "-c:a",
    "aac",
    "-b:a",
    AAC_BITRATE,
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    options.output,
  ];
  return { stills, concatList: `${lines.join("\n")}\n`, args };
}

export type RenderVideoOptions = RenderAudioOptions;

export type RenderVideoResult = {
  /** The rendered video, relative to the project folder: "out/drama.mp4". */
  file: string;
  /** The audio rendered first, which the video uses, with its scenario and timeline. */
  audio: RenderAudioResult;
};

/**
 * Renders a project's audio, as `renderAudio` does, then the video `out/drama.mp4` from the
 * timeline's images and that audio. ffmpeg runs in the project folder with relative paths. The
 * stills go in a temporary folder that is always removed. The audio and the video are written to
 * temporary files that replace the outputs only when both succeed, so a failed render keeps the
 * previous pair.
 *
 * Every failure is a `RenderError`, or its subclass `FfmpegError` when ffmpeg fails, under the
 * same rules as `renderAudio`: a fixed message with no absolute path and no original error.
 */
export async function renderVideo(
  projectDir: string,
  options: RenderVideoOptions,
): Promise<RenderVideoResult> {
  try {
    return await renderVideoSteps(projectDir, options);
  } catch (e) {
    // Each step wraps its own errors; this keeps anything unexpected from escaping raw.
    throw stepError("Could not render the video", e);
  }
}

async function renderVideoSteps(
  projectDir: string,
  options: RenderVideoOptions,
): Promise<RenderVideoResult> {
  const format = options.format ?? "mp3";
  const { scenario, timeline } = await loadRenderProject(
    projectDir,
    options.project,
    options.resolvers,
  );
  const audio = audioFile(format);
  const file = `${OUT_DIR}/${OUT_BASENAME}.mp4`;
  const id = randomUUID();
  const audioTemp = `${audio}.${id}.tmp`;
  const temp = `${file}.${id}.tmp`;
  const stillsDir = `${temp}.stills`;
  const orientations = await readImageOrientations(projectDir, timeline);
  const { stills, concatList, args } = buildVideoArgs(timeline, {
    audio: audioTemp,
    output: temp,
    stillsDir,
    orientations,
  });

  // The relative paths these runs pass, which ffmpeg's stderr may name.
  const paths = [
    ...timeline.images.filter(isShown).map((s) => join(ASSETS_DIR, s.file)),
    audioTemp,
    temp,
    stillsDir,
    ...stills.map((s) => s.at(-1) as string),
    join(stillsDir, CONCAT_LIST),
  ];
  await prepareOutDir(projectDir);
  try {
    await mixAudio(projectDir, timeline, format, audioTemp);
    await mkdir(inProject(projectDir, stillsDir)).catch((e: unknown) => {
      throw stepError(`Could not create a folder for the video stills in ${OUT_DIR}/`, e);
    });
    for (const stillArgs of stills) await runFfmpeg(stillArgs, { cwd: projectDir, paths });
    await writeFile(inProject(projectDir, join(stillsDir, CONCAT_LIST)), concatList).catch(
      (e: unknown) => {
        throw stepError(`Could not write the ffmpeg concat list in ${OUT_DIR}/`, e);
      },
    );
    await runFfmpeg(args, { cwd: projectDir, paths });
    for (const [from, to] of [
      [audioTemp, audio],
      [temp, file],
    ] as const) {
      await rename(inProject(projectDir, from), inProject(projectDir, to)).catch((e: unknown) => {
        throw stepError(`Could not write ${to}`, e);
      });
    }
  } catch (e) {
    await removeQuietly(projectDir, audioTemp);
    await removeQuietly(projectDir, temp);
    throw e;
  } finally {
    await removeQuietly(projectDir, stillsDir);
  }
  return { file, audio: { file: audio, format, scenario, timeline } };
}

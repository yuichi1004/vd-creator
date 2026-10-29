// The audio mix: voices, SFX, and BGM placed on the timeline, mixed, and loudness-normalized.
// See "Audio mix" in docs/plans/0006-rendering.md.

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ASSETS_DIR,
  AssetCache,
  type AssetResolver,
  type BgmSpan,
  CACHE_FILE,
  CacheFormatError,
  computeTimeline,
  GenerationError,
  type Timeline,
  type TimelineItem,
} from "@vd-creator/core";
import { IdSchema, loadScenario, SCENARIO_FILE, type Scenario } from "@vd-creator/scenario";
import { RenderError, stepError } from "./errors.js";
import { runFfmpeg } from "./ffmpeg.js";

export { RenderError } from "./errors.js";

export type RenderFormat = "mp3" | "wav";

/** Folder of the rendered files inside a project folder. */
export const OUT_DIR = "out";
/** Base name of the rendered files, such as out/drama.mp3. */
export const OUT_BASENAME = "drama";
export const LOUDNESS_TARGET_LUFS = -16;
export const TRUE_PEAK_DBTP = -1.5;
export const LOUDNESS_RANGE_LU = 11;
export const MIX_SAMPLE_RATE = 48000;
export const MP3_BITRATE = "192k";
/** Length of the BGM fade in and fade out, shortened for a scene under twice this length. */
export const BGM_FADE_SEC = 1;
/** Gain applied to the BGM while a line plays. */
export const BGM_DUCK_GAIN = 0.5;

export type AudioMixOptions = {
  /** The output file, as ffmpeg sees it. */
  output: string;
  /** Default "mp3". The format is given to ffmpeg, so the output name may have any extension. */
  format?: RenderFormat;
  /** The folder that timeline asset files are relative to, as ffmpeg sees it. Default "assets". */
  assetsDir?: string;
};

/** An item that is in the mix: a line or SFX with an asset. */
function isMixed(item: TimelineItem): item is TimelineItem & { assetFile: string } {
  return (
    (item.kind === "line" || item.kind === "sfx") &&
    item.assetFile !== undefined &&
    !item.missing &&
    !item.invalid
  );
}

function isMixedBgm(span: BgmSpan): span is BgmSpan & { assetFile: string } {
  return (
    span.assetFile !== undefined &&
    !span.missing &&
    !span.invalid &&
    // ffmpeg reads atrim=duration=0 as no trim, so a span that rounds to 0 ms is left out.
    Number(num(span.endSec - span.startSec)) > 0
  );
}

/**
 * The ffmpeg arguments, without the program name, that mix a timeline into one file.
 *
 * Input 0 is silence as long as the timeline, so the output always has the timeline's length.
 * Each line and SFX with an asset is delayed to its `startSec`. Each scene's BGM loops over
 * the scene, is set to its volume, fades in and out, and is ducked to `BGM_DUCK_GAIN` while a
 * mixed line plays. Everything is mixed without normalization and then normalized with
 * `loudnorm` to `LOUDNESS_TARGET_LUFS`. Items and BGM that are missing or invalid have no asset
 * and are left out, but the items after them keep their times. Throws a `RenderError` if the
 * timeline has no length.
 */
export function buildAudioMixArgs(timeline: Timeline, options: AudioMixOptions): string[] {
  if (!(timeline.durationSec > 0))
    throw new RenderError("The timeline is empty: nothing to render");
  const format = options.format ?? "mp3";
  const assetsDir = options.assetsDir ?? ASSETS_DIR;
  const stereo = `aresample=${MIX_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  args.push(
    "-f",
    "lavfi",
    "-t",
    num(timeline.durationSec),
    "-i",
    `anullsrc=r=${MIX_SAMPLE_RATE}:cl=stereo`,
  );
  const chains: string[] = [];
  const labels = ["[0:a]"];
  let input = 1;

  const items = timeline.items.filter(isMixed);
  for (const item of items) {
    args.push("-i", join(assetsDir, item.assetFile));
    const label = `[a${input}]`;
    chains.push(`[${input}:a]${stereo},adelay=${ms(item.startSec)}:all=1${label}`);
    labels.push(label);
    input++;
  }

  const lines = items.filter((i) => i.kind === "line");
  for (const span of timeline.bgm.filter(isMixedBgm)) {
    args.push("-stream_loop", "-1", "-i", join(assetsDir, span.assetFile));
    const length = span.endSec - span.startSec;
    const fade = Math.min(BGM_FADE_SEC, length / 2);
    const label = `[a${input}]`;
    chains.push(
      [
        `[${input}:a]atrim=duration=${num(length)}`,
        "asetpts=PTS-STARTPTS",
        stereo,
        bgmVolume(span, lines),
        `afade=t=in:st=0:d=${num(fade)}`,
        `afade=t=out:st=${num(length - fade)}:d=${num(fade)}`,
        `adelay=${ms(span.startSec)}:all=1${label}`,
      ].join(","),
    );
    labels.push(label);
    input++;
  }

  chains.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0,` +
      `loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=${TRUE_PEAK_DBTP}:LRA=${LOUDNESS_RANGE_LU},` +
      // loudnorm works at 192 kHz and loses the channel layout, so both are set again.
      `${stereo}[out]`,
  );
  args.push("-filter_complex", chains.join(";"), "-map", "[out]");
  if (format === "mp3") args.push("-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-f", "mp3");
  else args.push("-c:a", "pcm_s16le", "-f", "wav");
  args.push(options.output);
  return args;
}

/**
 * The `volume` filter of a BGM span: its volume, times `BGM_DUCK_GAIN` while a line plays.
 * Line spans are merged and made relative to the start of the BGM, which is where the
 * filter's `t` starts.
 */
function bgmVolume(span: BgmSpan, lines: readonly TimelineItem[]): string {
  const length = span.endSec - span.startSec;
  const ducks: [number, number][] = [];
  const spans = lines
    .map((l): [number, number] => [
      Math.max(0, l.startSec - span.startSec),
      Math.min(length, l.startSec + l.durationSec - span.startSec),
    ])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  for (const [from, to] of spans) {
    const last = ducks.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else ducks.push([from, to]);
  }
  if (ducks.length === 0) return `volume=${num(span.volume)}`;
  const playing = ducks.map(([from, to]) => `between(t,${num(from)},${num(to)})`).join("+");
  return `volume='${num(span.volume)}*(1-${num(1 - BGM_DUCK_GAIN)}*(${playing}))':eval=frame`;
}

/** A number for ffmpeg, rounded to the millisecond and never in exponent notation. */
function num(value: number): string {
  return String(Number(value.toFixed(3)));
}

function ms(sec: number): string {
  return String(Math.max(0, Math.round(sec * 1000)));
}

export type RenderAudioOptions = {
  /** The resolvers that find each item's asset, as for `computeTimeline`. */
  resolvers: readonly AssetResolver[];
  /** Default "mp3". */
  format?: RenderFormat;
};

export type RenderAudioResult = {
  /** The rendered file, relative to the project folder, such as "out/drama.mp3". */
  file: string;
  format: RenderFormat;
  scenario: Scenario;
  timeline: Timeline;
};

/**
 * Mixes a project's assets into `out/drama.mp3` or `out/drama.wav`. ffmpeg runs in the project
 * folder with relative paths and writes a temporary file that replaces the output only when
 * ffmpeg succeeds. Items without an asset are left out of the mix: callers that need every
 * asset, such as `vd render`, check the timeline first.
 *
 * Every failure is a `RenderError`, or its subclass `FfmpegError` when ffmpeg fails, with a
 * fixed message that holds at most a project-relative path and a Node error code, never an
 * absolute path. The original error is its `cause`.
 */
export async function renderAudio(
  projectDir: string,
  options: RenderAudioOptions,
): Promise<RenderAudioResult> {
  try {
    return await renderAudioSteps(projectDir, options);
  } catch (e) {
    // Each step wraps its own errors; this keeps anything unexpected from escaping raw.
    throw stepError("Could not render the audio", e);
  }
}

async function renderAudioSteps(
  projectDir: string,
  options: RenderAudioOptions,
): Promise<RenderAudioResult> {
  const format = options.format ?? "mp3";
  const { scenario, issues } = await loadScenario(projectDir).catch((e: unknown) => {
    throw stepError(`Could not read ${SCENARIO_FILE}`, e);
  });
  if (!scenario) {
    const count = issues.filter((i) => i.severity === "error").length;
    throw new RenderError(
      `${SCENARIO_FILE} has ${count} ${count === 1 ? "error" : "errors"}; run vd validate to see them`,
    );
  }
  const cache = await AssetCache.load(projectDir).catch((e: unknown) => {
    throw e instanceof CacheFormatError
      ? new RenderError(`${CACHE_FILE} is not a valid cache`, { cause: e })
      : stepError(`Could not read ${CACHE_FILE}`, e);
  });
  const timeline = await computeTimeline(scenario, cache, options.resolvers).catch((e: unknown) => {
    throw stepError(timelineFailure(e), e);
  });

  const file = `${OUT_DIR}/${OUT_BASENAME}.${format}`;
  const temp = `${file}.${randomUUID()}.tmp`;
  const args = buildAudioMixArgs(timeline, { output: temp, format });
  // A long drama's filter graph can pass the OS limit on one argument, so it goes in a file.
  const graph = `${temp}.filter`;
  const at = args.indexOf("-filter_complex");
  const graphText = args[at + 1] as string;
  args.splice(at, 2, "-filter_complex_script", graph);
  const inProject = (path: string) => join(projectDir, path);
  // Cleanup is best effort: its failure must not hide the error that caused it.
  const remove = (path: string) => rm(inProject(path), { force: true }).catch(() => {});

  await mkdir(inProject(OUT_DIR), { recursive: true }).catch((e: unknown) => {
    throw stepError(`Could not create ${OUT_DIR}/`, e);
  });
  try {
    await writeFile(inProject(graph), graphText).catch((e: unknown) => {
      throw stepError(`Could not write the ffmpeg filter graph in ${OUT_DIR}/`, e);
    });
    // The relative paths this run passes, which ffmpeg's stderr may name.
    const paths = [
      ...timeline.items.filter(isMixed).map((i) => join(ASSETS_DIR, i.assetFile)),
      ...timeline.bgm.filter(isMixedBgm).map((s) => join(ASSETS_DIR, s.assetFile)),
      temp,
      graph,
    ];
    await runFfmpeg(args, { cwd: projectDir, paths });
    await rename(inProject(temp), inProject(file)).catch((e: unknown) => {
      throw stepError(`Could not write ${file}`, e);
    });
  } catch (e) {
    await remove(temp);
    throw e;
  } finally {
    await remove(graph);
  }
  return { file, format, scenario, timeline };
}

/** The message for a failed timeline, naming the item when it is known. */
function timelineFailure(error: unknown): string {
  // IDs are validated, but the check keeps any other text out of the message.
  if (error instanceof GenerationError && IdSchema.safeParse(error.itemId).success) {
    return `Could not plan ${error.kind} "${error.itemId}" for the timeline`;
  }
  return "Could not plan the timeline";
}

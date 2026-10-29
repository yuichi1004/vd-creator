// The audio mix: voices, SFX, and BGM placed on the timeline, mixed, and loudness-normalized.
// See "Audio mix" in docs/plans/0006-rendering.md.

import { join } from "node:path";
import { ASSETS_DIR, type BgmSpan, type Timeline, type TimelineItem } from "@vd-creator/core";
import { RenderError } from "./errors.js";

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

/** A BGM span that is in the mix: one with an asset and a length. */
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

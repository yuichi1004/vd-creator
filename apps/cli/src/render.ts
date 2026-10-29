// Helpers of vd render. See "vd render" in docs/plans/0006-rendering.md.

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { ASSETS_DIR, itemLabel, type Timeline } from "@vd-creator/core";
import {
  buildAudioMixArgs,
  buildVideoArgs,
  CONCAT_LIST,
  OUT_BASENAME,
  OUT_DIR,
  type RenderFormat,
} from "@vd-creator/render";
import type { Env } from "./config/index.js";

export const RENDER_USAGE =
  "Usage: vd render [dir] [--video] [--srt] [--format mp3|wav] [--print-command]";

export const RENDER_FORMATS: readonly RenderFormat[] = ["mp3", "wav"];

/** The credits template in a project folder, which comes before render.creditsTemplate. */
export const PROJECT_CREDITS_TEMPLATE = "credits.template.txt";
/** The credits file that vd render writes, relative to the project folder. */
export const CREDITS_TEXT_FILE = `${OUT_DIR}/credits.txt`;
/** The subtitles that vd render --srt writes, relative to the project folder. */
export const SRT_FILE = `${OUT_DIR}/${OUT_BASENAME}.srt`;
/** The video that vd render --video writes, relative to the project folder. */
export const VIDEO_FILE = `${OUT_DIR}/${OUT_BASENAME}.mp4`;

/** The flags of vd render that choose its outputs. */
export type RenderOutputOptions = { format: RenderFormat; video: boolean; srt: boolean };

/**
 * Whether `out/` in the project folder is a symbolic link. A render refuses one, so that a
 * project cannot make it write outside the project folder. A missing `out/` is not one.
 */
export async function outIsSymlink(projectDir: string): Promise<boolean> {
  try {
    return (await lstat(join(projectDir, OUT_DIR))).isSymbolicLink();
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "ENOENT") return false;
    throw e;
  }
}

/**
 * The outputs, relative to the project folder, that a render with `options` does not write but
 * another render may have: the audio of the other format, the video without --video, and the
 * subtitles without --srt. The credits are always written.
 */
export function staleOutputs(options: RenderOutputOptions): string[] {
  return [
    ...RENDER_FORMATS.filter((f) => f !== options.format).map(
      (f) => `${OUT_DIR}/${OUT_BASENAME}.${f}`,
    ),
    ...(options.video ? [] : [VIDEO_FILE]),
    ...(options.srt ? [] : [SRT_FILE]),
  ];
}

/**
 * Removes the `staleOutputs` of a render from the project folder, so that `out/` holds only what
 * this render writes, and returns the ones it removed. A folder at such a name is left alone, and
 * a symbolic link is removed, never followed.
 */
export async function removeStaleOutputs(
  projectDir: string,
  options: RenderOutputOptions,
): Promise<string[]> {
  const removed: string[] = [];
  for (const file of staleOutputs(options)) {
    const path = join(projectDir, file);
    const found = await lstat(path).catch((e: unknown) => {
      if ((e as { code?: unknown } | null)?.code === "ENOENT") return undefined;
      throw e;
    });
    if (found === undefined || found.isDirectory()) continue;
    await rm(path);
    removed.push(file);
  }
  return removed;
}

/**
 * Whether `program` is an executable file in a folder of `env.PATH`. On Windows the
 * extensions of `env.PATHEXT` are tried too.
 */
export async function onPath(program: string, env: Env): Promise<boolean> {
  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d !== "");
  const extensions =
    process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const file = join(dir, `${program}${extension}`);
      try {
        if (!(await stat(file)).isFile()) continue;
        await access(file, constants.X_OK);
        return true;
      } catch {
        // Not here; try the next one.
      }
    }
  }
  return false;
}

/**
 * The labels of the lines, SFX, and BGM of a timeline that have no asset, such as
 * `line "s1-l2"`, in timeline order. A BGM is labeled with its scene's ID. An item that vd
 * generate cannot make, because no resolver supplies it or its request is invalid, says so.
 */
export function missingAudio(timeline: Timeline): string[] {
  const label = (
    kind: "line" | "sfx" | "bgm",
    id: string,
    flags: { unresolved?: true; invalid?: true },
  ) =>
    itemLabel({ kind, id }) +
    (flags.invalid
      ? " (invalid request)"
      : flags.unresolved
        ? " (unresolved; vd generate --dry-run shows why)"
        : "");
  const labels: string[] = [];
  for (const item of timeline.items) {
    if ((item.kind === "line" || item.kind === "sfx") && item.missing && item.id !== undefined) {
      labels.push(label(item.kind, item.id, item));
    }
  }
  for (const span of timeline.bgm) {
    if (span.missing) labels.push(label("bgm", span.sceneId, span));
  }
  return labels;
}

/**
 * The labels of the images shown in a timeline whose file is not in `<projectDir>/assets/`,
 * such as `image "shore" (images/shore.png)`. Each image is listed once.
 */
export async function missingImages(projectDir: string, timeline: Timeline): Promise<string[]> {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const span of timeline.images) {
    if (span.file === undefined || seen.has(span.imageId)) continue;
    seen.add(span.imageId);
    const found = await stat(join(projectDir, ASSETS_DIR, span.file)).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!found) labels.push(`image "${span.imageId}" (${span.file})`);
  }
  return labels;
}

/**
 * Writes `text` to `file`, relative to `projectDir`, through a temporary file in the same
 * folder that is then renamed over it. A symbolic link at `file` is replaced, never followed,
 * so a project cannot make the render write outside it.
 */
export async function writeOutFile(projectDir: string, file: string, text: string): Promise<void> {
  const target = join(projectDir, file);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    // "wx" creates the file and fails if anything, a symbolic link too, is at that name.
    await writeFile(temp, text, { flag: "wx" });
    await rename(temp, target);
  } catch (e) {
    // Cleanup is best effort: its failure must not hide the error that caused it.
    await rm(temp, { force: true }).catch(() => {});
    throw e;
  }
}

/** An argument quoted for a POSIX shell, unless it needs no quotes. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=,+@%-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The end marker of the here-documents that --print-command prints. */
const HEREDOC_END = "VD_EOF";

/**
 * The lines that vd render --print-command prints: a POSIX shell script to run in the project
 * folder. Files that the render writes for ffmpeg, the audio filter graph and the concat list of
 * a video, are written with here-documents. The render itself also writes to temporary names
 * and replaces the outputs at the end; the script writes the final names directly.
 */
export function renderCommands(
  timeline: Timeline,
  options: { format: RenderFormat; video: boolean; orientations?: ReadonlyMap<string, number> },
): string[] {
  const command = (args: readonly string[]) => ["ffmpeg", ...args].map(shellQuote).join(" ");
  const hereDoc = (file: string, text: string) => [
    `cat > ${shellQuote(file)} <<'${HEREDOC_END}'`,
    ...text.trimEnd().split("\n"),
    HEREDOC_END,
  ];
  const audio = `${OUT_DIR}/${OUT_BASENAME}.${options.format}`;
  const graph = `${audio}.filter`;
  const mix = buildAudioMixArgs(timeline, { output: audio, format: options.format });
  // As in renderAudio, the graph goes in a file, since a long one can pass the OS limit on one
  // argument. The graph holds only numbers and labels, never the end marker.
  const at = mix.indexOf("-filter_complex");
  const graphText = mix[at + 1] as string;
  mix.splice(at, 2, "-filter_complex_script", graph);
  const lines = [
    `mkdir -p ${OUT_DIR}`,
    ...hereDoc(graph, graphText),
    command(mix),
    `rm ${shellQuote(graph)}`,
  ];
  if (!options.video) return lines;
  const output = VIDEO_FILE;
  const stillsDir = `${output}.stills`;
  const { stills, concatList, args } = buildVideoArgs(timeline, {
    audio,
    output,
    stillsDir,
    ...(options.orientations === undefined ? {} : { orientations: options.orientations }),
  });
  lines.push(`mkdir -p ${shellQuote(stillsDir)}`);
  for (const still of stills) lines.push(command(still));
  lines.push(...hereDoc(`${stillsDir}/${CONCAT_LIST}`, concatList));
  lines.push(command(args), `rm -r ${shellQuote(stillsDir)}`);
  return lines;
}

/**
 * Thrown when a credits template cannot be read. `source` says which one: the project's
 * `credits.template.txt` or the file of render.creditsTemplate. The file system error is the
 * cause, and its code is copied to `code`.
 */
export class CreditsTemplateError extends Error {
  override name = "CreditsTemplateError";
  readonly code: string | undefined;

  constructor(
    readonly source: "project" | "config",
    cause: unknown,
  ) {
    super(`cannot read the credits template of the ${source}`, { cause });
    const code = (cause as { code?: unknown } | null)?.code;
    this.code = typeof code === "string" ? code : undefined;
  }
}

/**
 * The credits template of a render: `credits.template.txt` in the project folder if it exists,
 * else the `configured` file (render.creditsTemplate), else undefined for the built-in one.
 * Throws a `CreditsTemplateError` if a template cannot be read.
 */
export async function readCreditsTemplate(
  projectDir: string,
  configured: string | undefined,
): Promise<string | undefined> {
  try {
    return await readFile(join(projectDir, PROJECT_CREDITS_TEMPLATE), "utf8");
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code !== "ENOENT") {
      throw new CreditsTemplateError("project", e);
    }
  }
  if (configured === undefined) return undefined;
  try {
    return await readFile(configured, "utf8");
  } catch (e) {
    throw new CreditsTemplateError("config", e);
  }
}

// Rendering a project's audio mix to out/. See "Audio mix" in docs/plans/0006-rendering.md.

import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import type { AssetResolver, Timeline } from "@vd-creator/core";
import type { Scenario } from "@vd-creator/scenario";
import type { RenderFormat } from "./audio.js";
import { stepError } from "./errors.js";
import {
  audioFile,
  inProject,
  loadRenderProject,
  mixAudio,
  prepareOutDir,
  type RenderProject,
  removeQuietly,
} from "./steps.js";

export type { RenderProject } from "./steps.js";

export type RenderAudioOptions = {
  /** Default "mp3". */
  format?: RenderFormat;
} & (
  | {
      /**
       * The scenario and timeline to render, as the caller checked them. `scenario.yaml` and
       * `cache.json` are then not read again, so the render plays what was checked.
       */
      project: RenderProject;
      resolvers?: undefined;
    }
  | {
      /** The resolvers that find each item's asset, as for `computeTimeline`. */
      resolvers: readonly AssetResolver[];
      project?: undefined;
    }
);

export type RenderAudioResult = {
  /** The rendered file, relative to the project folder, such as "out/drama.mp3". */
  file: string;
  format: RenderFormat;
  scenario: Scenario;
  timeline: Timeline;
};

/**
 * Mixes a project's assets into `out/drama.mp3` or `out/drama.wav`. The project is
 * `options.project` if given, or else read from the project folder. ffmpeg runs in the project
 * folder with relative paths and writes a temporary file that replaces the output only when
 * ffmpeg succeeds. Items without an asset are left out of the mix: callers that need every
 * asset, such as `vd render`, check the timeline first. An `out/` that is a symbolic link is
 * refused.
 *
 * Every failure is a `RenderError`, or its subclass `FfmpegError` when ffmpeg fails, with a
 * fixed message that holds at most a project-relative path and an error code from
 * `REPORTED_ERROR_CODES`, never an absolute path. No original error leaves, not even as `cause`.
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
  const { scenario, timeline } = await loadRenderProject(
    projectDir,
    options.project,
    options.resolvers,
  );
  const file = audioFile(format);
  const temp = `${file}.${randomUUID()}.tmp`;
  await prepareOutDir(projectDir);
  await mixAudio(projectDir, timeline, format, temp);
  await rename(inProject(projectDir, temp), inProject(projectDir, file)).catch(
    async (e: unknown) => {
      await removeQuietly(projectDir, temp);
      throw stepError(`Could not write ${file}`, e);
    },
  );
  return { file, format, scenario, timeline };
}

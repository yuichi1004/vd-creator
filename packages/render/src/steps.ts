// Steps shared by renderAudio and renderVideo. Not exported from the package.

import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AssetCache,
  type AssetResolver,
  CACHE_FILE,
  CacheFormatError,
  computeTimeline,
  GenerationError,
  type Timeline,
} from "@vd-creator/core";
import { IdSchema, loadScenario, SCENARIO_FILE, type Scenario } from "@vd-creator/scenario";
import { buildAudioMixArgs, OUT_BASENAME, OUT_DIR, type RenderFormat } from "./audio.js";
import { RenderError, stepError } from "./errors.js";
import { runFfmpeg } from "./ffmpeg.js";

/** A scenario and its timeline, as a render plays them. */
export type RenderProject = {
  scenario: Scenario;
  timeline: Timeline;
};

/** The audio file of a render, relative to the project folder, such as "out/drama.mp3". */
export function audioFile(format: RenderFormat): string {
  return `${OUT_DIR}/${OUT_BASENAME}.${format}`;
}

/** A path in the project folder. */
export function inProject(projectDir: string, path: string): string {
  return join(projectDir, path);
}

/** Removes a file or folder in the project folder. Its failure must not hide the error that caused it. */
export async function removeQuietly(projectDir: string, path: string): Promise<void> {
  await rm(inProject(projectDir, path), { recursive: true, force: true }).catch(() => {});
}

/**
 * The project to render: `given`, as the caller checked it, or else the scenario and cache read
 * from the project folder and planned with `resolvers`.
 */
export async function loadRenderProject(
  projectDir: string,
  given: RenderProject | undefined,
  resolvers: readonly AssetResolver[] | undefined,
): Promise<RenderProject> {
  if (given !== undefined) return given;
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
      ? new RenderError(`${CACHE_FILE} is not a valid cache`)
      : stepError(`Could not read ${CACHE_FILE}`, e);
  });
  const timeline = await computeTimeline(scenario, cache, resolvers ?? []).catch((e: unknown) => {
    throw stepError(timelineFailure(e), e);
  });
  return { scenario, timeline };
}

/** The message for a failed timeline, naming the item when it is known. */
function timelineFailure(error: unknown): string {
  // IDs are validated, but the check keeps any other text out of the message.
  if (error instanceof GenerationError && IdSchema.safeParse(error.itemId).success) {
    return `Could not plan ${error.kind} "${error.itemId}" for the timeline`;
  }
  return "Could not plan the timeline";
}

/**
 * Creates `out/` in the project folder if it is missing. An `out/` that is a symbolic link is
 * refused, so that a project cannot make the render write outside it.
 */
export async function prepareOutDir(projectDir: string): Promise<void> {
  const found = await lstat(inProject(projectDir, OUT_DIR)).catch((e: unknown) => {
    if ((e as { code?: unknown } | null)?.code === "ENOENT") return undefined;
    throw stepError(`Could not read ${OUT_DIR}/`, e);
  });
  if (found?.isSymbolicLink()) {
    throw new RenderError(`${OUT_DIR}/ is a symbolic link; replace it with a folder`);
  }
  await mkdir(inProject(projectDir, OUT_DIR), { recursive: true }).catch((e: unknown) => {
    throw stepError(`Could not create ${OUT_DIR}/`, e);
  });
}

/**
 * Mixes a timeline into `output`, relative to the project folder, with ffmpeg running in the
 * project folder. The output is removed if ffmpeg fails.
 */
export async function mixAudio(
  projectDir: string,
  timeline: Timeline,
  format: RenderFormat,
  output: string,
): Promise<void> {
  const args = buildAudioMixArgs(timeline, { output, format });
  // The relative paths this run passes, which ffmpeg's stderr may name: the inputs after the
  // silence of input 0, the output, and the graph.
  const inputs = args.filter((_, i) => args[i - 1] === "-i").slice(1);
  // A long drama's filter graph can pass the OS limit on one argument, so it goes in a file.
  const graph = `${output}.filter`;
  const at = args.indexOf("-filter_complex");
  const graphText = args[at + 1] as string;
  args.splice(at, 2, "-filter_complex_script", graph);
  try {
    await writeFile(inProject(projectDir, graph), graphText).catch((e: unknown) => {
      throw stepError(`Could not write the ffmpeg filter graph in ${OUT_DIR}/`, e);
    });
    await runFfmpeg(args, { cwd: projectDir, paths: [...inputs, output, graph] });
  } catch (e) {
    await removeQuietly(projectDir, output);
    throw e;
  } finally {
    await removeQuietly(projectDir, graph);
  }
}

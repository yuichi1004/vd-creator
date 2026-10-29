// Integration test: renders a mock-generated project with the real ffmpeg.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AssetCache, defaultResolvers, runGeneration } from "@vd-creator/core";
import { createMockProviders } from "@vd-creator/providers";
import { loadScenario } from "@vd-creator/scenario";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LOUDNESS_TARGET_LUFS, RenderError, renderAudio } from "./audio.js";
import { FfmpegError } from "./ffmpeg.js";

const run = promisify(execFile);

// The pause makes scene s1 longer than the 30 s mock BGM, so the BGM has to loop.
const YAML = `
version: 1
title: Render
speakers:
  - id: a
    name: Ann
    voice: { provider: mock, voiceId: v1 }
  - id: b
    name: Ben
    voice: { provider: mock, voiceId: v2 }
scenes:
  - id: s1
    bgm: { prompt: calm, volume: 0.3 }
    items:
      - line: Hello there, is anyone home?
        id: l1
        speaker: a
      - sfx: knock
        id: fx1
        overlap: true
      - pause: 32
      - line: Coming!
        id: l2
        speaker: b
  - id: s2
    items:
      - sfx: { library: door-creak }
        id: fx2
      - line: Finally.
        id: l3
        speaker: a
        gapBeforeSec: -0.2
`;

const resolvers = defaultResolvers(createMockProviders());
let dir: string;

async function durationOf(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number(stdout.trim());
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-render-audio-"));
  await writeFile(join(dir, "scenario.yaml"), YAML);
  const { scenario } = await loadScenario(dir);
  if (!scenario) throw new Error("invalid test scenario");
  const result = await runGeneration(scenario, await AssetCache.load(dir), resolvers);
  // Everything but the library SFX, which no resolver handles.
  expect(result.failed).toBe(0);
  expect(result.items.filter((i) => i.status === "generated")).toHaveLength(5);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("renderAudio", { timeout: 60_000 }, () => {
  test("renders an MP3 as long as the timeline", async () => {
    const result = await renderAudio(dir, { resolvers });
    expect(result.file).toBe("out/drama.mp3");
    expect(result.format).toBe("mp3");
    // The library SFX has no asset but keeps its place in time.
    expect(result.timeline.items.find((i) => i.id === "fx2")?.missing).toBe(true);
    expect(result.timeline.durationSec).toBeGreaterThan(35);
    const duration = await durationOf(join(dir, result.file));
    // MP3 frames add a little padding.
    expect(Math.abs(duration - result.timeline.durationSec)).toBeLessThan(0.1);
    expect(await readdir(join(dir, "out"))).toEqual(["drama.mp3"]);
  });

  test("renders a WAV with --format wav", async () => {
    const result = await renderAudio(dir, { resolvers, format: "wav" });
    expect(result.file).toBe("out/drama.wav");
    const duration = await durationOf(join(dir, result.file));
    expect(Math.abs(duration - result.timeline.durationSec)).toBeLessThan(0.02);
    // Not silent, and near the loudness target. Single-pass loudnorm is not exact.
    const { stderr } = await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-i",
      join(dir, result.file),
      "-af",
      "ebur128",
      "-f",
      "null",
      "-",
    ]);
    const integrated = Number(
      /I:\s+(-?[\d.]+) LUFS\s*$/m.exec(stderr.split("Summary:").at(-1) ?? "")?.[1],
    );
    expect(Math.abs(integrated - LOUDNESS_TARGET_LUFS)).toBeLessThan(2);
  });

  test("reports an unreadable asset without absolute paths and keeps no partial output", async () => {
    const broken = await mkdtemp(join(tmpdir(), "vd-render-broken-"));
    try {
      await writeFile(join(broken, "scenario.yaml"), YAML);
      const { scenario } = await loadScenario(broken);
      if (!scenario) throw new Error("invalid test scenario");
      const cache = await AssetCache.load(broken);
      await runGeneration(scenario, cache, resolvers, { only: ["l1"] });
      const file = cache.keys().map((k) => cache.get(k)?.file)[0] as string;
      await writeFile(cache.assetPath(file), "not audio");

      const error = await renderAudio(broken, { resolvers }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FfmpegError);
      expect((error as Error).message).toContain(`assets/${file}`);
      expect((error as Error).message).not.toContain(broken);
      expect(await readdir(join(broken, "out"))).toEqual([]);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  test("refuses a scenario with errors", async () => {
    const invalid = await mkdtemp(join(tmpdir(), "vd-render-invalid-"));
    try {
      await writeFile(join(invalid, "scenario.yaml"), "version: 1\ntitle: Bad\nscenes: 5\n");
      await expect(renderAudio(invalid, { resolvers })).rejects.toThrow(RenderError);
    } finally {
      await rm(invalid, { recursive: true, force: true });
    }
  });
});

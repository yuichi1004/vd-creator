// No error that leaves this package may show an absolute path, in any form it can be shown in.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import type { Timeline } from "@vd-creator/core";
import type { Scenario } from "@vd-creator/scenario";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { causeOptions, errorCode, RenderError, stepError } from "./errors.js";
import { FfmpegError, runFfmpeg } from "./ffmpeg.js";
import { renderAudio } from "./render-audio.js";
import { buildSrt } from "./srt.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-render-errors-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The error a call throws or rejects with. */
async function errorOf(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

/** Every form an error is shown in: inspected, its stack, as a string, and as JSON. */
function shownForms(error: unknown): string[] {
  return [
    inspect(error, { showHidden: true, depth: Number.POSITIVE_INFINITY }),
    String((error as Error).stack),
    String(error),
    JSON.stringify(error),
  ];
}

describe("errors that leave the package", () => {
  const cases: [string, () => unknown][] = [
    ["runFfmpeg with a missing program", () => runFfmpeg([], { command: "vd-no-such-ffmpeg" })],
    [
      "runFfmpeg with a missing program by absolute path",
      () => runFfmpeg([], { command: join(dir, "vd-no-such-ffmpeg") }),
    ],
    [
      "runFfmpeg with a missing program and a working folder",
      () => runFfmpeg([], { command: join(dir, "vd-no-such-ffmpeg"), cwd: dir }),
    ],
    ["runFfmpeg with a failing ffmpeg", () => runFfmpeg(["-i", join(dir, "x.wav")], { cwd: dir })],
    ["runFfmpeg with a missing folder", () => runFfmpeg([], { cwd: join(dir, "gone") })],
    ["runFfmpeg with null options", () => runFfmpeg([], null as never)],
    ["renderAudio with a missing project", () => renderAudio(join(dir, "gone"), { resolvers: [] })],
    ["buildSrt with no timeline", () => buildSrt(null as never, null as never)],
  ];

  test.each(cases)("show no absolute path: %s", async (_, call) => {
    const error = await errorOf(call);
    expect(error).toBeInstanceOf(RenderError);
    for (const shown of shownForms(error)) {
      expect(shown).not.toContain(homedir());
      expect(shown).not.toContain(packageDir);
      expect(shown).not.toContain(dir);
      // No stack frame is kept.
      expect(shown).not.toMatch(/\n\s+at /);
    }
  });

  test("have a stack of only their name and message", async () => {
    const error = (await errorOf(() =>
      runFfmpeg([], { command: "vd-no-such-ffmpeg" }),
    )) as FfmpegError;
    expect(error.stack).toBe(`FfmpegError: ${error.message}`);
    expect(new RenderError("failed").stack).toBe("RenderError: failed");
  });
});

describe("runFfmpeg options", () => {
  test.each([
    ["null options", [], null],
    ["a command that is not a string", [], { command: 5 }],
    ["an empty command", [], { command: "" }],
    ["a cwd that is not a string", [], { cwd: {} }],
    ["paths that are not strings", [], { paths: [1] }],
    ["arguments that are not an array", "-version", {}],
    ["arguments that are not strings", [1], {}],
    [
      "options with a throwing getter",
      [],
      {
        get command(): string {
          throw new Error(`at ${homedir()}`);
        },
      },
    ],
  ])("are refused with a fixed message: %s", async (_, args, options) => {
    const error = await errorOf(() => runFfmpeg(args as never, options as never));
    expect(error).toBeInstanceOf(RenderError);
    expect(error).not.toBeInstanceOf(FfmpegError);
    expect((error as Error).message).toBe(
      "runFfmpeg was given arguments or options of the wrong type",
    );
    expect((error as RenderError).cause).toBeUndefined();
  });

  test("a missing working folder is not reported as a missing program", async () => {
    const error = (await errorOf(() =>
      runFfmpeg(["-version"], { cwd: join(dir, "gone") }),
    )) as FfmpegError;
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error.message).toBe(
      "ffmpeg could not be started: the project folder was not found (ENOENT)",
    );
    expect(error.code).toBe("ENOENT");
    expect(error.cause).toEqual({ message: "system error ENOENT", code: "ENOENT" });
  });

  test("a missing program with a working folder is reported as missing from PATH", async () => {
    const error = (await errorOf(() =>
      runFfmpeg([], { command: "vd-no-such-ffmpeg", cwd: dir }),
    )) as FfmpegError;
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error.message).toBe(
      "vd-no-such-ffmpeg could not be started (ENOENT); check that vd-no-such-ffmpeg is on PATH",
    );
    expect(error.exitCode).toBeUndefined();
    expect(error.cause).toEqual({ message: "system error ENOENT", code: "ENOENT" });
  });

  test("a working folder that is a file is not reported as a missing program", async () => {
    const file = join(dir, "file");
    await writeFile(file, "");
    const error = (await errorOf(() => runFfmpeg(["-version"], { cwd: file }))) as FfmpegError;
    expect(error.message).toBe(
      "ffmpeg could not be started: the project folder was not found (ENOTDIR)",
    );
  });
});

describe("errorCode", () => {
  const throwing = {
    get code(): string {
      throw new Error(`at ${homedir()}`);
    },
  };
  const proxy = new Proxy(
    {},
    {
      get() {
        throw new Error(`at ${homedir()}`);
      },
      getPrototypeOf() {
        throw new Error(`at ${homedir()}`);
      },
    },
  );

  test.each([
    ["a throwing getter", throwing],
    ["a throwing Proxy", proxy],
  ])("treats a code that cannot be read as none: %s", (_, error) => {
    expect(errorCode(error)).toBeUndefined();
    expect(causeOptions(error)).toEqual({});
    const step = stepError("Could not read x", error);
    expect(step).toBeInstanceOf(RenderError);
    expect(step.message).toBe("Could not read x");
    expect(step.cause).toBeUndefined();
  });

  test("RenderError drops a cause whose fields cannot be read", () => {
    const error = new RenderError("failed", { cause: proxy as never });
    expect(error.cause).toEqual({ message: "error" });
    expect(new RenderError("failed", proxy as never).cause).toBeUndefined();
  });

  test("buildSrt reports a timeline whose items throw with a fixed message", () => {
    const timeline = { items: proxy } as unknown as Timeline;
    const scenario = { speakers: [], scenes: [] } as unknown as Scenario;
    expect(() => buildSrt(timeline, scenario)).toThrow(
      new RenderError("Could not build the subtitles"),
    );
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FfmpegError, reportableStderr, runFfmpeg } from "./ffmpeg.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-render-ffmpeg-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runFfmpeg", () => {
  test("resolves when ffmpeg succeeds", async () => {
    await expect(
      runFfmpeg([
        "-hide_banner",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "anullsrc",
        "-t",
        "0.1",
        "-f",
        "null",
        "-",
      ]),
    ).resolves.toBeUndefined();
  });

  test("reports ffmpeg's stderr with a relative path when it fails", async () => {
    const error = await runFfmpeg(["-hide_banner", "-nostdin", "-i", "no-such-file.wav"], {
      cwd: dir,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegError);
    const ffmpegError = error as FfmpegError;
    expect(ffmpegError.exitCode).not.toBe(0);
    expect(ffmpegError.message).toMatch(/^ffmpeg exited with code \d+:\n/);
    expect(ffmpegError.message).toContain("no-such-file.wav");
    expect(ffmpegError.message).not.toContain(dir);
  });

  test("leaves out stderr lines that hold an absolute path", async () => {
    const missing = join(dir, "no-such-file.wav");
    const error = (await runFfmpeg(["-hide_banner", "-nostdin", "-i", missing]).catch(
      (e: unknown) => e,
    )) as FfmpegError;
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error.message).not.toContain(dir);
    expect(error.message).toMatch(/absolute path left out/);
  });

  test("says when the program cannot be started, without its path", async () => {
    const error = (await runFfmpeg([], { command: "vd-no-such-ffmpeg" }).catch(
      (e: unknown) => e,
    )) as FfmpegError;
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error.message).toBe(
      "vd-no-such-ffmpeg could not be started (ENOENT); check that vd-no-such-ffmpeg is on PATH",
    );
  });

  test("never runs its arguments through a shell", async () => {
    const error = (await runFfmpeg(["-hide_banner", "-nostdin", "-i", "$(echo x);ls"], {
      cwd: dir,
    }).catch((e: unknown) => e)) as FfmpegError;
    expect(error.message).toContain("$(echo x);ls");
  });
});

describe("reportableStderr", () => {
  test("keeps the last lines and drops absolute paths of every style", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    expect(reportableStderr(lines.join("\n"))).toEqual(lines.slice(2));
    expect(
      reportableStderr(
        [
          "/home/u/x.wav: No such file or directory",
          "Error opening input file '/tmp/x.wav'.",
          "C:\\Users\\u\\x.wav: Invalid data",
          "file:/srv/x.wav: Invalid data",
          "~/x.wav: denied",
          "\\\\host\\share\\x.wav: denied",
          "assets/voice/x.wav: No such file or directory",
          "size=  10kB bitrate= 128kb/s speed=N/A",
          "see http://ffmpeg.org",
          "",
        ].join("\r\n"),
      ),
    ).toEqual([
      "assets/voice/x.wav: No such file or directory",
      "size=  10kB bitrate= 128kb/s speed=N/A",
      "see http://ffmpeg.org",
      "(6 lines with an absolute path left out)",
    ]);
  });
});

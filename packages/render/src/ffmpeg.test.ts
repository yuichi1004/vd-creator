import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RenderError } from "./audio.js";
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

  /** The error of an ffmpeg run that opens one missing input. */
  async function failWith(input: string, cwd?: string): Promise<FfmpegError> {
    const error = await runFfmpeg(
      ["-hide_banner", "-nostdin", "-i", input],
      cwd === undefined ? {} : { cwd },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error).toBeInstanceOf(RenderError);
    return error as FfmpegError;
  }

  // Every form ffmpeg may print an absolute path in, outside the working folder.
  test.each([
    ["a plain path", (d: string) => join(d, "no-such-file.wav")],
    ["a file: URL", (d: string) => `file://${join(d, "no-such-file.wav")}`],
    ["a double-slash path", (d: string) => `/${join(d, "no-such-file.wav")}`],
  ])("leaves out stderr lines that hold %s", async (_, input) => {
    const error = await failWith(input(dir));
    expect(error.message).not.toContain(dir);
    expect(error.message).not.toMatch(/tmp/);
    expect(error.message).toMatch(/absolute path left out/);
  });

  test("shows the working folder, as given, as '.'", async () => {
    const error = await failWith(join(dir, "no-such-file.wav"), dir);
    expect(error.message).not.toContain(dir);
    expect(error.message).toContain("./no-such-file.wav");
  });

  test("shows the working folder, by its real path, as '.'", async () => {
    const link = `${dir}-link`;
    await symlink(dir, link);
    try {
      const real = await realpath(dir);
      const error = await failWith(join(real, "no-such-file.wav"), link);
      expect(error.message).not.toContain(real);
      expect(error.message).toContain("./no-such-file.wav");
    } finally {
      await rm(link, { force: true });
    }
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

  test("reports arguments that Node refuses without quoting them", async () => {
    const error = (await runFfmpeg(["-i", `${dir}/x\0.wav`]).catch(
      (e: unknown) => e,
    )) as FfmpegError;
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error.message).toBe("ffmpeg could not be started (ERR_INVALID_ARG_VALUE)");
    expect(error.cause).toBeInstanceOf(Error);
  });

  test("names a command given by an absolute path by its file name only", async () => {
    const command = join(dir, "vd-no-such-ffmpeg");
    const error = (await runFfmpeg(["-i", join(dir, "x.wav")], { command }).catch(
      (e: unknown) => e,
    )) as FfmpegError;
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error.message).not.toContain(dir);
    expect(error.message).toMatch(/^vd-no-such-ffmpeg could not be started \(ENOENT\)/);
  });

  test("leaves out the stderr line that the size limit cut, which may hold a path's end", async () => {
    // A path line, then one long line: the 64 KiB limit cuts the path line after its slash.
    const script =
      'process.stderr.write("/" + "s".repeat(1000) + "/secret.wav: bad\\n" + "o".repeat(64800) + "\\n"); process.exit(1);';
    const error = (await runFfmpeg(["-e", script], { command: process.execPath }).catch(
      (e: unknown) => e,
    )) as FfmpegError;
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error.message).toContain("o".repeat(100));
    expect(error.message).not.toContain("secret.wav");
  });

  test("never runs its arguments through a shell", async () => {
    const error = (await runFfmpeg(["-hide_banner", "-nostdin", "-i", "$(echo x);ls"], {
      cwd: dir,
    }).catch((e: unknown) => e)) as FfmpegError;
    expect(error.message).toContain("$(echo x);ls");
  });
});

describe("reportableStderr", () => {
  test("keeps the last lines", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    expect(reportableStderr(lines.join("\n"))).toEqual(lines.slice(2));
  });

  test.each([
    ["a leading slash", "/home/u/x.wav: No such file or directory"],
    ["a quoted slash", "Error opening input file '/tmp/x.wav'."],
    ["a slash after a separator", "input=/tmp/x.wav"],
    ["a file: URL", "file:///tmp/x.wav: No such file or directory"],
    ["a short file: URL", "file:/srv/x.wav: Invalid data"],
    ["an upper-case file: URL", "FILE:///tmp/x.wav: Invalid data"],
    ["a double slash", "//tmp/x.wav: No such file or directory"],
    ["a URL", "see http://host/tmp/x"],
    ["a tilde", "~/x.wav: denied"],
    ["a named home", "~u/x.wav: denied"],
    ["a Windows drive", "C:\\Users\\u\\x.wav: Invalid data"],
    ["a Windows drive with slashes", "Error opening 'c:/Users/u/x.wav'"],
    ["a UNC path", "\\\\host\\share\\x.wav: denied"],
    ["a path on the current Windows drive", "\\Users\\u\\x.wav: Invalid data"],
    ["a quoted path on the current Windows drive", "Error opening '\\Users\\u\\x.wav'"],
  ])("leaves out a line with %s", (_, line) => {
    expect(reportableStderr(`ok\n${line}\n`)).toEqual([
      "ok",
      "(1 line with an absolute path left out)",
    ]);
  });

  test("keeps relative paths and ratios", () => {
    const lines = [
      "assets/voice/x.wav: No such file or directory",
      "./out/drama.mp3: Is a directory",
      "size=  10kB bitrate= 128kb/s speed=N/A",
      "[Parsed_aresample_22 @ 0x564625afae00] Cannot select channel layout",
    ];
    expect(reportableStderr(lines.join("\r\n"))).toEqual(lines);
  });

  test("replaces the given folders with '.', longest first, before checking", () => {
    expect(
      reportableStderr(
        [
          "/p/proj/assets/x.wav: No such file or directory",
          "Error opening 'file:///p/proj/x.wav'",
          "/p/proj2/x.wav: denied",
          "/p/proj: Is a directory",
        ].join("\n"),
        ["/p", "/p/proj"],
      ),
    ).toEqual([
      "./assets/x.wav: No such file or directory",
      "./proj2/x.wav: denied",
      ".: Is a directory",
      "(1 line with an absolute path left out)",
    ]);
  });

  test("replaces a folder only as a whole path, and handles regex characters in it", () => {
    expect(
      reportableStderr(["/mnt/srv/proj/x.wav: denied", "/srv/(a+b)[1]/x.wav: denied"].join("\n"), [
        "/srv/proj",
        "/srv/(a+b)[1]",
      ]),
    ).toEqual(["./x.wav: denied", "(1 line with an absolute path left out)"]);
  });
});

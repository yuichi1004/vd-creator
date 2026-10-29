import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
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
    expect(error.message).toMatch(/left out that may hold a path/);
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
    // ERR_INVALID_ARG_VALUE is not on the list of codes that are shown.
    expect(error.message).toBe("ffmpeg could not be started");
    expect(error.cause).toBeUndefined();
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

  test("keeps every part of a missing absolute command's path out of the whole error", async () => {
    const home = await mkdtemp(join(dir, "home-alice-secret-"));
    const command = join(home, "vd-no-such-ffmpeg");
    const error = await runFfmpeg([], { command }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegError);
    // The cause, stack, and every other property are inspected too.
    const shown = inspect(error, { depth: Number.POSITIVE_INFINITY, showHidden: true });
    expect(shown).toContain("vd-no-such-ffmpeg could not be started (ENOENT)");
    for (const part of [home, "alice-secret", "home-alice"]) {
      expect(shown).not.toContain(part);
    }
    expect((error as FfmpegError).cause).toEqual({
      message: "system error ENOENT",
      code: "ENOENT",
    });
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

  test("reports a deleted working folder without its path", async () => {
    const gone = await mkdtemp(join(tmpdir(), "vd-render-gone-"));
    const before = process.cwd();
    process.chdir(gone);
    try {
      await rm(gone, { recursive: true });
      // Resolving a relative cwd needs the process's own working folder, which is gone.
      const error = (await runFfmpeg(["-version"], { cwd: "." }).catch(
        (e: unknown) => e,
      )) as FfmpegError;
      expect(error).toBeInstanceOf(FfmpegError);
      expect(error.message).toBe("ffmpeg could not be started (ENOENT)");
      expect(error.code).toBe("ENOENT");
      expect(error.cause).toEqual({ message: "system error ENOENT", code: "ENOENT" });
    } finally {
      process.chdir(before);
    }
  });

  test("shows a relative path that it was given, and no other", async () => {
    await mkdir(join(dir, "in"), { recursive: true });
    await writeFile(join(dir, "in", "bad.wav"), "not audio");
    const args = ["-hide_banner", "-nostdin", "-i", "in/bad.wav"];
    const hidden = await runFfmpeg(args, { cwd: dir, paths: ["in/other.wav"] }).catch(
      (e: unknown) => e,
    );
    expect(hidden).toBeInstanceOf(FfmpegError);
    expect((hidden as Error).message).not.toContain("bad.wav");
    const shown = await runFfmpeg(args, { cwd: dir, paths: ["in/bad.wav"] }).catch(
      (e: unknown) => e,
    );
    expect((shown as Error).message).toContain("in/bad.wav: Invalid data");
  });

  test("never runs its arguments through a shell", async () => {
    // The script says whether it got the argument as written; a shell would have expanded it.
    const script =
      'process.stderr.write(process.argv[1] === "$(echo x);ls" ? "as written" : "expanded"); process.exit(1);';
    const error = (await runFfmpeg(["-e", script, "$(echo x);ls"], {
      command: process.execPath,
    }).catch((e: unknown) => e)) as FfmpegError;
    expect(error.message).toContain("as written");
  });
});

describe("RenderError", () => {
  test("rebuilds a cause from its allowed fields, dropping any error object", () => {
    const original = Object.assign(new Error("open /home/alice-secret/x.wav"), {
      code: "ENOENT",
      path: "/home/alice-secret/x.wav",
    });
    const error = new RenderError("failed", { cause: original as never, code: "BAD" as never });
    expect(error.cause).toEqual({ message: "system error ENOENT", code: "ENOENT" });
    expect(error.code).toBeUndefined();
    expect(inspect(error, { showHidden: true })).not.toContain("alice-secret");
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
    ["an ANSI-colored path", "\x1b[0;31m/home/alice/private.wav: denied\x1b[0m"],
    ["an ANSI-colored path after text", "Error\x1b[1m/home/alice/private.wav"],
    ["a path behind an OSC sequence", "\x1b]8;;x\x07/home/alice/private.wav"],
    ["a path behind a control character", "x\x08/home/alice/private.wav"],
    ["a percent-encoded path", "Error opening %2Fhome%2Falice%2Fprivate.wav"],
    ["a plain ../ path", "../../home/alice/private.wav: denied"],
    ["a bare ..", "Error opening ..: denied"],
    ["a relative path that was not given", "other/x.wav: Invalid data"],
    ["a ratio", "size=  10kB bitrate= 128kb/s speed=N/A"],
  ])("leaves out a line with %s", (_, line) => {
    expect(reportableStderr(`ok\n${line}\n`)).toEqual([
      "ok",
      "(1 line left out that may hold a path)",
    ]);
  });

  test("removes escape sequences and control characters before checking", () => {
    expect(
      reportableStderr("\x1b[0;31m[aresample @ 0x5646] Cannot select\x1b[0m layout\x07", {}),
    ).toEqual(["[aresample @ 0x5646] Cannot select layout"]);
  });

  test("shows the relative paths it was given, as whole tokens only", () => {
    const paths = ["assets/voice/x.wav", "out/drama.mp3.tmp"];
    expect(
      reportableStderr(
        [
          "assets/voice/x.wav: Invalid data found when processing input",
          "Error opening input file assets/voice/x.wav.",
          "'out/drama.mp3.tmp': Is a directory",
          "assets/voice/x.wav/../../etc/passwd: denied",
          "assets/../../etc/passwd: denied",
          "other/assets/voice/x.wav: denied",
          "%2Fassets/voice/x.wav: denied",
          "assets/voice/x.wav.bak: denied",
        ].join("\n"),
        { paths },
      ),
    ).toEqual([
      "assets/voice/x.wav: Invalid data found when processing input",
      "Error opening input file assets/voice/x.wav.",
      "'out/drama.mp3.tmp': Is a directory",
      "(5 lines left out that may hold a path)",
    ]);
  });

  test("ignores given paths that are not plain relative paths", () => {
    const paths = ["/etc/passwd", "../x.wav", "a/../b.wav", "~/x.wav", "a\\b.wav", "a//b.wav"];
    for (const path of paths) {
      expect(reportableStderr(`${path}: denied`, { paths })).toEqual([
        "(1 line left out that may hold a path)",
      ]);
    }
  });

  test("replaces the given folders with '.', longest first, before checking", () => {
    expect(
      reportableStderr(
        [
          "/p/proj/assets/x.wav: No such file or directory",
          "Error opening 'file:///p/proj/x.wav'",
          "/p/proj2/x.wav: denied",
          "/p/proj: Is a directory",
          "'/p/proj/out/./drama.mp3'",
        ].join("\n"),
        { folders: ["/p", "/p/proj"] },
      ),
    ).toEqual([
      "./assets/x.wav: No such file or directory",
      "./proj2/x.wav: denied",
      ".: Is a directory",
      "'./out/drama.mp3'",
      "(1 line left out that may hold a path)",
    ]);
  });

  test.each([
    ["a .. segment", "/srv/proj/../../home/alice/private.wav: denied"],
    ["a .. segment at the end", "/srv/proj/assets/..: denied"],
    ["a name with ..", "/srv/proj/a..b/x.wav: denied"],
    ["a percent sign", "/srv/proj/%2E%2E/%2E%2E/home/alice/private.wav"],
    ["a tilde", "/srv/proj/~alice/x.wav"],
    ["a folder inside a longer path", "/mnt/srv/proj/x.wav: denied"],
    // On POSIX this names "proj\x.wav" next to the project, not a file in it.
    ...(process.platform === "win32" ? [] : [["a backslash", "/srv/proj\\x.wav: denied"]]),
    ["a file: URL", "file:///srv/proj/x.wav: denied"],
  ])("does not replace a folder followed by %s", (_, line) => {
    expect(reportableStderr(line, { folders: ["/srv/proj"] })).toEqual([
      "(1 line left out that may hold a path)",
    ]);
  });

  test.each([
    ["a fullwidth slash", "\uff0fhome\uff0falice\uff0fprivate.wav: No such file or directory"],
    [
      "a fullwidth backslash",
      "C:\uff3cUsers\uff3calice\uff3cprivate.wav: No such file or directory",
    ],
    ["U+FFFD from overlong slash bytes", "\ufffdhome\ufffdalice\ufffdprivate.wav: Invalid data"],
    ["a tab", "Input #0,\twav, from alice: denied"],
    ["a non-ASCII letter", "Error opening ålice: denied"],
    ["a dollar sign", "Error opening $HOME: denied"],
  ])("leaves out a line with %s", (_, line) => {
    expect(reportableStderr(`${line}\nok`, { folders: ["/srv/proj"] })).toEqual([
      "ok",
      "(1 line left out that may hold a path)",
    ]);
  });

  test("keeps a line of ASCII letters, digits, and the allowed punctuation", () => {
    const line = `[mp3 @ 0x1f] Error (code=-22): 'a.b', 'c' "b" #1 *x* <y> | z; done! why? +1 _`;
    expect(reportableStderr(line)).toEqual([line]);
  });

  test("shows names with combining marks", () => {
    // "ガ" in NFD, as macOS file names are: カ followed by a combining dakuten.
    const path = "assets/voice/ガ.wav";
    expect(reportableStderr(`${path}: Invalid data`, { paths: [path] })).toEqual([
      `${path}: Invalid data`,
    ]);
  });

  test("handles regex characters in a folder", () => {
    expect(reportableStderr("/srv/(a+b)[1]/x.wav: denied", { folders: ["/srv/(a+b)[1]"] })).toEqual(
      ["./x.wav: denied"],
    );
  });
});

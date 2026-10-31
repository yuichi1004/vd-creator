// Integration tests of vd render: they generate with the mock and render with the real ffmpeg.

import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { importEntry, verifyEntry } from "@vd-creator/library";
import { encodeWav } from "@vd-creator/providers";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from "./index.js";
import { shellQuote } from "./render.js";

const exec = promisify(execFile);

let tmp: string;
let lib: string;
let dir: string;

const ATTRIBUTION = '"Old door" by Jane Doe, CC BY 4.0';

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vd-cli-render-"));
  lib = join(tmp, "vd-library");
  dir = join(tmp, "drama");
  expect((await vd("init", dir)).code).toBe(EXIT_OK);
  // The template has one line. Add a second speaker, a BGM, an SFX, and two images.
  await editScenario((text) =>
    text
      .replace(
        "scenes:\n",
        "  - id: keeper\n    name: Keeper\n    voice: { provider: mock, voiceId: keeper }\n" +
          "images:\n  - id: shore\n    file: images/shore.png\n  - id: lamp\n    file: images/lamp.png\n" +
          "scenes:\n",
      )
      .replace(
        "    title: Opening\n    items:\n",
        "    title: Opening\n    bgm:\n      prompt: Calm piano\n    items:\n      - image: shore\n",
      )
      .concat(
        "      - sfx: Door creaks\n        id: s1-sfx1\n" +
          "      - image: lamp\n" +
          '      - line: "Who goes there?"\n        id: s1-l2\n        speaker: keeper\n',
      ),
  );
  await mkdir(join(dir, "assets", "images"));
  await image("shore.png", "navy", "640x480");
  await image("lamp.png", "orange", "300x600");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * Runs vd with the real PATH and `env`, and no real user directory. These tests render the mock's
 * draft audio, so a render gets `--allow-draft`; the draft audio tests use `vdRaw`.
 */
async function vdEnv(env: Record<string, string>, ...args: string[]) {
  return vdRaw(env, args[0] === "render" ? [...args, "--allow-draft"] : args);
}

async function vdRaw(
  env: Record<string, string>,
  args: string[],
  options: { confirm?: (question: string) => Promise<boolean> } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    { HOME: join(tmp, "home"), PATH: process.env.PATH ?? "", ...env },
    { repoRoot: tmp, ...options },
  );
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function vd(...args: string[]) {
  return vdEnv({}, ...args);
}

/** Runs vd in the project folder, and checks that no output names a temporary path. */
async function vdIn(env: Record<string, string>, ...args: string[]) {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await vdEnv(env, ...args);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(tmp);
    return result;
  } finally {
    process.chdir(cwd);
  }
}

async function editScenario(edit: (text: string) => string) {
  const file = join(dir, "scenario.yaml");
  await writeFile(file, edit(await readFile(file, "utf8")));
}

/** Makes a solid-color PNG in assets/images/ with ffmpeg. */
async function image(name: string, color: string, size: string) {
  await exec("ffmpeg", [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
    ...["-i", `color=c=${color}:s=${size}`, "-frames:v", "1"],
    join(dir, "assets", "images", name),
  ]);
}

async function probe(file: string): Promise<{ streams: Record<string, unknown>[] }> {
  const { stdout } = await exec("ffprobe", [
    ...["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json"],
    file,
  ]);
  return JSON.parse(stdout);
}

async function outFiles(): Promise<string[]> {
  return (await readdir(join(dir, "out"))).sort();
}

/** Makes the scenario use library sound door-01, imported and verified as `verify` says. */
async function useDoor(
  use: "private" | "commercial",
  options: { verify: boolean; license?: string },
) {
  expect((await vd("library", "init", lib)).code).toBe(EXIT_OK);
  const sound = join(tmp, "door.wav");
  const evidence = join(tmp, "terms.html");
  await writeFile(sound, encodeWav(new Array(8000).fill(0.1), 8000));
  await writeFile(evidence, "<html>CC BY 4.0</html>");
  await importEntry(lib, sound, {
    kind: "sfx",
    id: "door-01",
    license: options.license ?? "CC-BY-4.0",
    title: "Old door",
    url: "https://example.com/sounds/1",
    author: "Jane Doe",
    attribution: ATTRIBUTION,
    evidence,
  });
  if (options.verify) await verifyEntry(lib, "door-01", { kind: "sfx" });
  await editScenario((text) =>
    text
      .replace(/use: \S+/, `use: ${use}`)
      .concat("      - sfx: { library: door-01 }\n        id: door\n"),
  );
}

describe("vd render", { timeout: 120_000 }, () => {
  test("renders the audio, video, subtitles, and credits of a mock-generated project", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const result = await vdIn({}, "render", "--video", "--srt");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.split("\n")).toEqual([
      "Rendered out/drama.mp3",
      "Rendered out/drama.mp4",
      "Wrote out/drama.srt",
      "Wrote out/credits.txt",
    ]);
    // No temporary file or stills folder is left.
    expect(await outFiles()).toEqual(["credits.txt", "drama.mp3", "drama.mp4", "drama.srt"]);

    const { streams } = await probe(join(dir, "out", "drama.mp4"));
    expect(streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codec_type: "video", width: 1920, height: 1080 }),
        expect.objectContaining({ codec_type: "audio" }),
      ]),
    );
    const srt = await readFile(join(dir, "out", "drama.srt"), "utf8");
    expect(srt).toMatch(
      /^1\n00:00:\d\d,\d{3} --> 00:00:\d\d,\d{3}\nNarrator: Once upon a time\.\.\.\n/,
    );
    expect(srt).toContain("Keeper: Who goes there?");
  });

  test("renders only the audio by default, and WAV with --format wav", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const mp3 = await vd("render", dir);
    expect(mp3).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(await outFiles()).toEqual(["credits.txt", "drama.mp3"]);

    const wav = await vd("render", dir, "--format", "wav");
    expect(wav).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(wav.stdout).toContain("Rendered out/drama.wav");
    const data = await readFile(join(dir, "out", "drama.wav"));
    expect(data.subarray(0, 4).toString("latin1")).toBe("RIFF");
  });

  test("a missing asset fails with the item IDs listed, and renders nothing", async () => {
    expect((await vd("generate", dir, "--only", "s1-l1")).code).toBe(EXIT_OK);
    await rm(join(dir, "assets", "images", "lamp.png"));
    const audio = await vd("render", dir);
    expect(audio.code).toBe(EXIT_FAILURE);
    expect(audio.stderr).toBe(
      [
        "vd render: 3 items without an asset; run vd generate first:",
        '  sfx "s1-sfx1"',
        '  line "s1-l2"',
        '  bgm "s1"',
      ].join("\n"),
    );
    // The video needs the images too.
    const video = await vd("render", dir, "--video");
    expect(video.code).toBe(EXIT_FAILURE);
    expect(video.stderr).toContain("4 items without an asset");
    expect(video.stderr).toContain('  image "lamp" (images/lamp.png)');
    expect(await outFiles()).toEqual([]);
  });

  test("a license error stops the render", async () => {
    await useDoor("commercial", { verify: false });
    expect((await vdEnv({ VD_LIBRARY: lib }, "generate", dir)).code).toBe(EXIT_OK);
    const result = await vd("render", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain(
      'licenses: Library entry "door-01" has an unverified license record',
    );
    expect(result.stderr).toContain(
      "vd render: the license check has errors; fix them before rendering",
    );
    expect(await outFiles()).toEqual([]);
  });

  test("a non-commercial license stops a commercial render", async () => {
    await useDoor("commercial", { verify: true, license: "CC-BY-NC-4.0" });
    expect((await vdEnv({ VD_LIBRARY: lib }, "generate", dir)).code).toBe(EXIT_OK);
    const result = await vd("render", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('Library entry "door-01"');
    expect(result.stderr).toContain(
      "vd render: the license check has errors; fix them before rendering",
    );
    expect(await outFiles()).toEqual([]);
  });

  test("replaces a symbolic link at out/credits.txt or out/drama.srt, never writing through it", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    await mkdir(join(dir, "out"), { recursive: true });
    const outside = { credits: join(tmp, "notes.txt"), srt: join(tmp, "notes.srt") };
    await writeFile(outside.credits, "keep\n");
    await writeFile(outside.srt, "keep\n");
    await symlink(outside.credits, join(dir, "out", "credits.txt"));
    await symlink(outside.srt, join(dir, "out", "drama.srt"));

    const result = await vd("render", dir, "--srt");
    expect(result).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(await readFile(outside.credits, "utf8")).toBe("keep\n");
    expect(await readFile(outside.srt, "utf8")).toBe("keep\n");
    for (const file of ["credits.txt", "drama.srt"]) {
      expect((await lstat(join(dir, "out", file))).isFile()).toBe(true);
    }
    expect(await readFile(join(dir, "out", "drama.srt"), "utf8")).toContain("Who goes there?");
    // No temporary file is left.
    expect(await outFiles()).toEqual(["credits.txt", "drama.mp3", "drama.srt"]);
  });

  test("refuses an out/ that is a symbolic link, before rendering anything", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const elsewhere = join(tmp, "elsewhere");
    await mkdir(elsewhere);
    await rm(join(dir, "out"), { recursive: true, force: true });
    await symlink(elsewhere, join(dir, "out"));
    const result = await vd("render", dir, "--video", "--srt");
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd render: out/ in ${dir} is a symbolic link; replace it with a folder`,
    );
    expect(result.stdout).toBe("");
    expect(await readdir(elsewhere)).toEqual([]);
  });

  test("removes the outputs of an earlier render that the current options do not write", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const all = await vd("render", dir, "--video", "--srt", "--format", "wav");
    expect(all).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(all.stdout).not.toContain("Removed");

    const audio = await vd("render", dir);
    expect(audio).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(audio.stdout.split("\n")).toEqual([
      "Removed out/drama.wav, which this render does not write",
      "Removed out/drama.mp4, which this render does not write",
      "Removed out/drama.srt, which this render does not write",
      "Rendered out/drama.mp3",
      "Wrote out/credits.txt",
    ]);
    expect(await outFiles()).toEqual(["credits.txt", "drama.mp3"]);

    // A folder at an output's name is not an output, and is left alone.
    await mkdir(join(dir, "out", "drama.srt"));
    const again = await vd("render", dir);
    expect(again).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(again.stdout).not.toContain("Removed");
    expect(await outFiles()).toEqual(["credits.txt", "drama.mp3", "drama.srt"]);
  });

  test("a verified CC-BY entry renders, with its attribution in credits.txt", async () => {
    await useDoor("commercial", { verify: true });
    expect((await vdEnv({ VD_LIBRARY: lib }, "generate", dir)).code).toBe(EXIT_OK);
    // The project renders from its copy, without the library.
    const result = await vd("render", dir);
    expect(result).toMatchObject({ code: EXIT_OK, stderr: "" });
    const credits = await readFile(join(dir, "out", "credits.txt"), "utf8");
    expect(credits).toContain(`Sounds:\n${ATTRIBUTION}\n`);
  });

  test("uses credits.template.txt from the project folder", async () => {
    await useDoor("private", { verify: true });
    expect((await vdEnv({ VD_LIBRARY: lib }, "generate", dir)).code).toBe(EXIT_OK);
    await writeFile(join(dir, "credits.template.txt"), "Thanks to:\n{{attributions}}\n");
    expect((await vd("render", dir)).code).toBe(EXIT_OK);
    const credits = await readFile(join(dir, "out", "credits.txt"), "utf8");
    expect(credits).toBe(`Thanks to:\n${ATTRIBUTION}\n`);
  });

  test("fails when ffmpeg is not on PATH, before rendering", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const empty = join(tmp, "empty-bin");
    await mkdir(empty);
    const result = await vdEnv({ PATH: empty }, "render", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      "vd render: ffmpeg is not on PATH; install it, or add its folder to PATH",
    );
    expect(await outFiles()).toEqual([]);
  });

  test("--print-command prints a shell script that renders the video, and renders nothing", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    // ffmpeg is not needed to print the commands.
    const empty = join(tmp, "empty-bin");
    await mkdir(empty);
    const result = await vdIn({ PATH: empty }, "render", "--video", "--print-command");
    expect(result).toMatchObject({ code: EXIT_OK, stderr: "" });
    const lines = result.stdout.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "cd -- . || exit 1",
      "mkdir -p out",
      "cat > out/drama.mp3.filter <<'VD_EOF'",
    ]);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^ffmpeg .*-filter_complex_script out\/drama\.mp3\.filter .* out\/drama\.mp3$/,
      ),
    );
    // One still per image. The first image starts at 0, so no black still is needed.
    expect(
      lines.filter((l) => /^ffmpeg .* out\/drama\.mp4\.stills\/\d\.png$/.test(l)),
    ).toHaveLength(2);
    expect(lines).toContain("cat > out/drama.mp4.stills/list.txt <<'VD_EOF'");
    expect(lines.at(-1)).toBe("rm -r out/drama.mp4.stills");
    expect(await outFiles()).toEqual([]);

    // The script runs as printed, even without out/.
    await rm(join(dir, "out"), { recursive: true });
    await exec("sh", ["-e", "-c", result.stdout], { cwd: dir });
    expect(await outFiles()).toEqual(["drama.mp3", "drama.mp4"]);
    const { streams } = await probe(join(dir, "out", "drama.mp4"));
    expect(streams).toContainEqual(
      expect.objectContaining({ codec_type: "video", width: 1920, height: 1080 }),
    );
  });

  test("--print-command quotes the project folder and file names for the shell", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    // A project folder with a space, and an image name with a quote and a command substitution.
    const moved = join(tmp, "my drama");
    await rename(dir, moved);
    dir = moved;
    const name = "it's $(x) a.png";
    await rename(join(dir, "assets", "images", "shore.png"), join(dir, "assets", "images", name));
    await editScenario((text) => text.replace("file: images/shore.png", `file: "images/${name}"`));
    const result = await vd("render", dir, "--video", "--print-command");
    expect(result).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(result.stdout.split("\n")[0]).toBe(`cd -- ${shellQuote(dir)} || exit 1`);
    await exec("sh", ["-n", "-c", result.stdout]);

    // A fake ffmpeg logs its arguments, and a command named x would leave a mark.
    const bin = join(tmp, "fake-bin");
    const log = join(tmp, "ffmpeg.log");
    const mark = join(tmp, "x-ran");
    await mkdir(bin);
    await writeFile(join(bin, "ffmpeg"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${shellQuote(log)}\n`);
    await writeFile(join(bin, "x"), `#!/bin/sh\ntouch ${shellQuote(mark)}\n`);
    await chmod(join(bin, "ffmpeg"), 0o755);
    await chmod(join(bin, "x"), 0o755);
    // The script runs from another folder.
    await exec("sh", ["-e", "-c", result.stdout], {
      cwd: tmp,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    const args = (await readFile(log, "utf8")).split("\n");
    expect(args).toContain(`assets/images/${name}`);
    await expect(lstat(mark)).rejects.toThrow();
  });

  test("uses render.creditsTemplate from config.yaml, after the project's template", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const user = join(tmp, "user");
    await mkdir(user);
    await writeFile(join(user, "config.yaml"), "version: 1\nrender:\n  creditsTemplate: t.txt\n");
    const env = { VD_USER_DIR: user };

    // A missing template fails before anything is rendered, without its path.
    const broken = await vdIn(env, "render");
    expect(broken.code).toBe(EXIT_FAILURE);
    expect(broken.stderr).toBe("vd render: cannot read render.creditsTemplate: ENOENT");
    expect(await outFiles()).toEqual([]);

    await writeFile(join(user, "t.txt"), "Made with vd-creator\n");
    expect((await vdIn(env, "render")).code).toBe(EXIT_OK);
    expect(await readFile(join(dir, "out", "credits.txt"), "utf8")).toBe("Made with vd-creator\n");

    await writeFile(join(dir, "credits.template.txt"), "From the project\n");
    expect((await vdIn(env, "render")).code).toBe(EXIT_OK);
    expect(await readFile(join(dir, "out", "credits.txt"), "utf8")).toBe("From the project\n");
  });

  test("labels a library sound that cannot be resolved apart from one to generate", async () => {
    await editScenario((text) =>
      text.concat("      - sfx: { library: door-01 }\n        id: door\n"),
    );
    expect((await vd("generate", dir)).code).toBe(EXIT_FAILURE);
    const result = await vd("render", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('  sfx "door" (unresolved; vd generate --dry-run shows why)');
    // Under private use the license issue is only a warning, so the missing asset is what fails.
    expect(result.stderr).toContain("(warning)");
    expect(result.stderr).not.toContain("the license check has errors");
  });

  describe("draft audio", () => {
    test("stops and names the draft items without --allow-draft, and renders with it", async () => {
      expect((await vd("generate", dir)).code).toBe(EXIT_OK);
      const stopped = await vdRaw({}, ["render", dir]);
      expect(stopped.code).toBe(EXIT_FAILURE);
      expect(stopped.stderr.split("\n")).toEqual([
        "vd render: 4 items with draft audio (mock tones), not final audio:",
        '  bgm "s1"',
        '  line "s1-l1"',
        '  sfx "s1-sfx1"',
        '  line "s1-l2"',
        "Generate them with a paid provider, or run again with --allow-draft to render the draft anyway.",
      ]);
      expect(await outFiles()).toEqual([]);

      const allowed = await vdRaw({}, ["render", dir, "--allow-draft"]);
      expect(allowed).toMatchObject({ code: EXIT_OK, stderr: "" });
      expect(await outFiles()).toEqual(["credits.txt", "drama.mp3"]);
    });

    test("on a terminal, asks and follows the answer", async () => {
      expect((await vd("generate", dir)).code).toBe(EXIT_OK);
      const questions: string[] = [];
      const answer = (yes: boolean) => async (question: string) => {
        questions.push(question);
        return yes;
      };

      const no = await vdRaw({}, ["render", dir], { confirm: answer(false) });
      expect(no.code).toBe(EXIT_FAILURE);
      expect(no.stdout).toContain('  bgm "s1"');
      expect(no.stderr).toBe("vd render: stopped; nothing was rendered");
      expect(await outFiles()).toEqual([]);

      const yes = await vdRaw({}, ["render", dir], { confirm: answer(true) });
      expect(yes.code).toBe(EXIT_OK);
      expect(await outFiles()).toEqual(["credits.txt", "drama.mp3"]);
      expect(questions).toHaveLength(2);

      // --allow-draft needs no question.
      questions.length = 0;
      expect(
        (await vdRaw({}, ["render", dir, "--allow-draft"], { confirm: answer(false) })).code,
      ).toBe(EXIT_OK);
      expect(questions).toEqual([]);
    });

    test("library sounds and paid assets are final, and a mock BGM is draft", async () => {
      await useDoor("private", { verify: true });
      expect((await vdEnv({ VD_LIBRARY: lib }, "generate", dir)).code).toBe(EXIT_OK);
      // Make the voices and the SFX look paid; the BGM stays a mock tone.
      const file = join(dir, "cache.json");
      const cache = JSON.parse(await readFile(file, "utf8"));
      for (const entry of Object.values<{ kind: string; providerId: string }>(cache.entries)) {
        if (entry.kind !== "music") entry.providerId = "elevenlabs";
      }
      await writeFile(file, JSON.stringify(cache));

      const result = await vdRaw({ VD_LIBRARY: lib }, ["render", dir]);
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toContain("1 item with draft audio");
      expect(result.stderr).toContain('  bgm "s1"');
      expect(result.stderr).not.toContain('"door"');
      expect(result.stderr).not.toContain("line ");
    });
  });

  test("rejects bad usage", async () => {
    expect((await vd("render", dir, "--format", "ogg")).code).toBe(EXIT_USAGE);
    expect((await vd("render", dir, "extra")).code).toBe(EXIT_USAGE);
    expect((await vd("render", dir, "--dry-run")).code).toBe(EXIT_USAGE);
  });
});

describe("shellQuote", () => {
  test("leaves plain arguments and quotes the rest", () => {
    expect(shellQuote("out/drama.mp3")).toBe("out/drama.mp3");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
  });
});

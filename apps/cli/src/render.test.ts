// Integration tests of vd render: they generate with the mock and render with the real ffmpeg.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** Runs vd with the real PATH and `env`, and no real user directory. */
async function vdEnv(env: Record<string, string>, ...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    { HOME: join(tmp, "home"), PATH: process.env.PATH ?? "", ...env },
    { repoRoot: tmp },
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
async function useDoor(use: "private" | "commercial", options: { verify: boolean }) {
  expect((await vd("library", "init", lib)).code).toBe(EXIT_OK);
  const sound = join(tmp, "door.wav");
  const evidence = join(tmp, "terms.html");
  await writeFile(sound, encodeWav(new Array(8000).fill(0.1), 8000));
  await writeFile(evidence, "<html>CC BY 4.0</html>");
  await importEntry(lib, sound, {
    kind: "sfx",
    id: "door-01",
    license: "CC-BY-4.0",
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
      "# Run in .:",
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

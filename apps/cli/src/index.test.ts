import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScenario } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type CliOutput,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  run,
  scenarioSchemaPath,
  scenarioTemplate,
} from "./index.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vd-cli-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function vd(...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output: CliOutput = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  const code = await run(args, output);
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("vd init", () => {
  test("creates scenario.yaml, assets/, and out/", async () => {
    const dir = join(tmp, "my-drama");
    const result = await vd("init", dir);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain(dir);
    expect((await readdir(dir)).sort()).toEqual(["assets", "out", "scenario.yaml"]);
    expect(await readdir(join(dir, "assets"))).toEqual([]);
    expect(await readdir(join(dir, "out"))).toEqual([]);

    const text = await readFile(join(dir, "scenario.yaml"), "utf8");
    const { scenario, issues } = parseScenario(text);
    expect(issues).toEqual([]);
    expect(scenario?.title).toBe("my-drama");
  });

  test("points the yaml-language-server comment at the shipped schema", async () => {
    const dir = join(tmp, "nested", "drama");
    expect((await vd("init", dir)).code).toBe(EXIT_OK);
    const text = await readFile(join(dir, "scenario.yaml"), "utf8");
    const ref = /^# yaml-language-server: \$schema=(.+)$/m.exec(text)?.[1];
    expect(ref).toBeDefined();
    expect(resolve(dir, ref as string)).toBe(scenarioSchemaPath());
    expect((await stat(scenarioSchemaPath())).isFile()).toBe(true);
  });

  test("accepts an existing empty folder", async () => {
    expect((await vd("init", tmp)).code).toBe(EXIT_OK);
    expect((await vd("validate", tmp)).code).toBe(EXIT_OK);
  });

  test("refuses a folder that is not empty and leaves it untouched", async () => {
    await writeFile(join(tmp, "notes.txt"), "keep me");
    const result = await vd("init", tmp);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain("is not empty");
    expect(await readdir(tmp)).toEqual(["notes.txt"]);
  });

  test("accepts a folder with only dotfiles, such as a fresh git repository", async () => {
    await mkdir(join(tmp, ".git"));
    expect((await vd("init", tmp)).code).toBe(EXIT_OK);
    expect((await readdir(tmp)).sort()).toEqual([".git", "assets", "out", "scenario.yaml"]);
  });

  test("names the project after the folder when given a relative path", async () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      expect((await vd("init", "relative-drama")).code).toBe(EXIT_OK);
    } finally {
      process.chdir(cwd);
    }
    const text = await readFile(join(tmp, "relative-drama", "scenario.yaml"), "utf8");
    expect(parseScenario(text).scenario?.title).toBe("relative-drama");
  });

  test("refuses a path that is a file or inside a file", async () => {
    const file = join(tmp, "file");
    await writeFile(file, "");
    for (const dir of [file, join(file, "sub")]) {
      const result = await vd("init", dir);
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toContain("is a file or is inside a file");
    }
  });

  test("requires exactly one folder", async () => {
    expect((await vd("init")).code).toBe(EXIT_USAGE);
    expect((await vd("init", "a", "b")).code).toBe(EXIT_USAGE);
  });
});

describe("scenarioTemplate", () => {
  test.each([
    "The Lighthouse Keeper",
    'quotes " and \\ backslash',
    "colon: hash # yes",
    "日本語のタイトル",
  ])("is valid with the title %j", (title) => {
    const { scenario, issues } = parseScenario(scenarioTemplate(title, "schema.json"));
    expect(issues).toEqual([]);
    expect(scenario?.title).toBe(title);
  });
});

describe("vd validate", () => {
  test("accepts a fresh project", async () => {
    const dir = join(tmp, "ok");
    await vd("init", dir);
    const result = await vd("validate", dir);
    expect(result).toEqual({ code: EXIT_OK, stdout: "scenario.yaml is valid", stderr: "" });
  });

  test("defaults to the current folder", async () => {
    const dir = join(tmp, "cwd");
    await vd("init", dir);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect((await vd("validate")).code).toBe(EXIT_OK);
    } finally {
      process.chdir(cwd);
    }
  });

  test("reports an issue with its path in a broken copy", async () => {
    const dir = join(tmp, "ok");
    const broken = join(tmp, "broken");
    await vd("init", dir);
    await cp(dir, broken, { recursive: true });
    const file = join(broken, "scenario.yaml");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("speaker: narrator", "speaker: nobody"));

    const result = await vd("validate", broken);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe('scenes.0.items.0.speaker: Unknown speaker "nobody"');
    // The original is still valid.
    expect((await vd("validate", dir)).code).toBe(EXIT_OK);
  });

  test("reports every issue, one per line", async () => {
    const dir = join(tmp, "many");
    await vd("init", dir);
    const file = join(dir, "scenario.yaml");
    const text = await readFile(file, "utf8");
    await writeFile(
      file,
      text.replace("version: 1", "version: 2").replace("id: s1-l1", "id: s1\n        colour: red"),
    );
    const result = await vd("validate", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    const lines = result.stderr.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.startsWith("version: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("scenes.0.items.0.colour: "))).toBe(true);
  });

  test("reports YAML syntax errors", async () => {
    await writeFile(join(tmp, "scenario.yaml"), "version: 1\ntitle: [unclosed\n");
    const result = await vd("validate", tmp);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toMatch(/^\(root\): /);
  });

  test("fails when there is no scenario.yaml", async () => {
    const result = await vd("validate", join(tmp, "missing"));
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain("cannot read scenario.yaml");
  });

  test("passes the package sample", async () => {
    const sample = join(dirname(scenarioSchemaPath()), "..", "fixtures", "sample.yaml");
    const dir = join(tmp, "sample");
    await mkdir(dir);
    await cp(sample, join(dir, "scenario.yaml"));
    expect((await vd("validate", dir)).code).toBe(EXIT_OK);
  });
});

// The built bin, run as a real process. Skipped when the workspace has not been built.
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

describe.skipIf(!existsSync(bin))("dist/bin.js", () => {
  test("is executable and passes exit codes through", async () => {
    expect((await stat(bin)).mode & 0o111).not.toBe(0);
    const dir = join(tmp, "proc");
    expect(spawnSync(bin, ["init", dir], { encoding: "utf8" }).status).toBe(EXIT_OK);
    expect(spawnSync(bin, ["validate", dir], { encoding: "utf8" }).status).toBe(EXIT_OK);
    const file = join(dir, "scenario.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("version: 1", "version: 9"));
    const broken = spawnSync(bin, ["validate", dir], { encoding: "utf8" });
    expect(broken.status).toBe(EXIT_FAILURE);
    expect(broken.stderr).toMatch(/^version: /);
  });
});

describe("vd", () => {
  test("prints help", async () => {
    const result = await vd("--help");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("Usage: vd");
  });

  test("rejects an unknown command, a missing command, and an unknown option", async () => {
    expect((await vd("frobnicate")).stderr).toContain('unknown command "frobnicate"');
    expect((await vd("frobnicate")).code).toBe(EXIT_USAGE);
    expect((await vd()).code).toBe(EXIT_USAGE);
    expect((await vd("validate", "--bogus")).code).toBe(EXIT_USAGE);
  });
});

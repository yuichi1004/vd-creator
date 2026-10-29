import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

// Permission tests do not work as root, who can write anywhere.
const isRoot = process.getuid?.() === 0;

async function vdWith(env: Record<string, string>, output: Partial<CliOutput>, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    {
      stdout: output.stdout ?? ((line) => stdout.push(line)),
      stderr: output.stderr ?? ((line) => stderr.push(line)),
    },
    env,
  );
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function vd(...args: string[]) {
  return vdWith({}, {}, args);
}

/** Runs `fn` with `dir` as the current folder, so tests can pass relative paths. */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
  }
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

  test("points the yaml-language-server comment at the schema's absolute file URL", async () => {
    const dir = join(tmp, "nested", "drama");
    expect((await vd("init", dir)).code).toBe(EXIT_OK);
    const text = await readFile(join(dir, "scenario.yaml"), "utf8");
    const ref = /^# yaml-language-server: \$schema=(.+)$/m.exec(text)?.[1] as string;
    expect(ref).toBe(pathToFileURL(scenarioSchemaPath()).href);
    expect(fileURLToPath(ref)).toBe(scenarioSchemaPath());
    expect((await stat(scenarioSchemaPath())).isFile()).toBe(true);

    // The comment keeps working after the project folder moves.
    const moved = join(tmp, "elsewhere", "deeper", "drama");
    await mkdir(dirname(moved), { recursive: true });
    await rename(dir, moved);
    const movedRef = /\$schema=(.+)$/m.exec(await readFile(join(moved, "scenario.yaml"), "utf8"));
    expect((await stat(fileURLToPath(movedRef?.[1] as string))).isFile()).toBe(true);
  });

  test("accepts an existing empty folder", async () => {
    expect((await vd("init", tmp)).code).toBe(EXIT_OK);
    expect((await vd("validate", tmp)).code).toBe(EXIT_OK);
  });

  test("accepts .git, .gitignore, .gitattributes, and .DS_Store", async () => {
    await mkdir(join(tmp, ".git"));
    await writeFile(join(tmp, ".gitignore"), "out/\n");
    await writeFile(join(tmp, ".gitattributes"), "* text=auto\n");
    await writeFile(join(tmp, ".DS_Store"), "");
    expect((await vd("init", tmp)).code).toBe(EXIT_OK);
    expect((await readdir(tmp)).sort()).toEqual([
      ".DS_Store",
      ".git",
      ".gitattributes",
      ".gitignore",
      "assets",
      "out",
      "scenario.yaml",
    ]);
  });

  test.each([
    ["a hidden file", ".notes", "file"],
    ["a hidden folder", ".drafts", "folder"],
  ])("refuses a folder with %s", async (_, name, kind) => {
    if (kind === "file") await writeFile(join(tmp, name), "secret");
    else await mkdir(join(tmp, name));
    const result = await vd("init", tmp);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain("is not empty");
    expect(await readdir(tmp)).toEqual([name]);
  });

  test("refuses a folder that is not empty and leaves it untouched", async () => {
    await writeFile(join(tmp, "notes.txt"), "keep me");
    const result = await vd("init", tmp);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain("is not empty");
    expect(await readdir(tmp)).toEqual(["notes.txt"]);
  });

  test("names the project after a relative folder and prints it as typed", async () => {
    const result = await inDir(tmp, () => vd("init", "relative-drama"));
    expect(result).toEqual({ code: EXIT_OK, stdout: "Created relative-drama", stderr: "" });
    const text = await readFile(join(tmp, "relative-drama", "scenario.yaml"), "utf8");
    expect(parseScenario(text).scenario?.title).toBe("relative-drama");
  });

  test.skipIf(isRoot)("reports a file system error by code, naming the path as typed", async () => {
    await mkdir(join(tmp, "locked"), { mode: 0o500 });
    const result = await inDir(tmp, () => vd("init", "locked/drama"));
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe("vd init: cannot create locked/drama: EACCES");
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
    expect((await vd("init", "")).code).toBe(EXIT_USAGE);
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

  test("fails when there is no scenario.yaml, naming the folder as typed", async () => {
    const result = await inDir(tmp, () => vd("validate", "missing"));
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe("vd validate: cannot read scenario.yaml in missing: ENOENT");
  });

  test("reports an unreadable scenario.yaml by code", async () => {
    await mkdir(join(tmp, "scenario.yaml"));
    const result = await inDir(tmp, () => vd("validate"));
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe("vd validate: cannot read scenario.yaml in .: EISDIR");
  });

  test("passes the package sample", async () => {
    const sample = join(dirname(scenarioSchemaPath()), "..", "fixtures", "sample.yaml");
    const dir = join(tmp, "sample");
    await mkdir(dir);
    await cp(sample, join(dir, "scenario.yaml"));
    expect((await vd("validate", dir)).code).toBe(EXIT_OK);
  });
});

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = join(cliRoot, "bin", "vd.js");
const built = existsSync(join(cliRoot, "dist", "bin.js"));

describe("bin/vd.js", () => {
  test("is the bin entry, checked in outside the build output, and executable", async () => {
    const pkg = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
    const entry = resolve(cliRoot, pkg.bin.vd);
    expect(entry).toBe(bin);
    // npm links bins during npm ci, before anything is built.
    expect(relative(cliRoot, entry).split(sep)[0]).not.toBe("dist");
    expect(existsSync(entry)).toBe(true);
    expect((await stat(entry)).mode & 0o111).not.toBe(0);
    expect((await readFile(entry, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  test("tells the user to build when dist is missing", async () => {
    // A copy of the launcher with no dist/ next to it.
    const copy = join(tmp, "bin", "vd.js");
    await mkdir(dirname(copy));
    await cp(bin, copy);
    const result = spawnSync(process.execPath, [copy, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(EXIT_FAILURE);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("npm run build");
  });

  test("reports a build that fails to load in one line, without paths", async () => {
    // A copy of the launcher next to a dist/ whose import fails, like a stale build.
    const copy = join(tmp, "bin", "vd.js");
    await mkdir(dirname(copy));
    await mkdir(join(tmp, "dist"));
    await cp(bin, copy);
    await writeFile(join(tmp, "dist", "bin.js"), 'import "@vd-creator/no-such-package";\n');
    const result = spawnSync(process.execPath, [copy], { encoding: "utf8", env: {} });
    expect(result.status).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      "vd: cannot load the build (ERR_MODULE_NOT_FOUND); run npm run build\n",
    );

    const debug = spawnSync(process.execPath, [copy], {
      encoding: "utf8",
      env: { VD_DEBUG: "1" },
    });
    expect(debug.status).toBe(EXIT_FAILURE);
    expect(debug.stderr).toContain(tmp);
  });

  test.skipIf(!built)("passes exit codes through", async () => {
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
  // An output that fails stands in for an unexpected error whose message holds a path.
  const failingStdout = () => {
    throw new Error("boom at /some/absolute/path");
  };

  test("hides the message and stack of an unexpected error", async () => {
    const result = await vdWith({}, { stdout: failingStdout }, ["--help"]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe("vd: unexpected error\nSet VD_DEBUG=1 for details.");
  });

  test("prints the stack of an unexpected error with VD_DEBUG=1", async () => {
    const result = await vdWith({ VD_DEBUG: "1" }, { stdout: failingStdout }, ["--help"]);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toMatch(
      /^vd: unexpected error\nError: boom at \/some\/absolute\/path\n\s+at /,
    );
  });

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

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from "./index.js";
import { libraryTestHooks, safeLibraryText } from "./library.js";

let tmp: string;
let lib: string;
let sound: string;
let evidence: string;
let prompts: string[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vd-cli-library-"));
  lib = join(tmp, "vd-library");
  sound = join(tmp, "door.wav");
  evidence = join(tmp, "terms.html");
  await mkdir(join(tmp, "home"));
  await writeFile(sound, "RIFF fake wav data");
  await writeFile(evidence, "<html>CC BY 4.0</html>");
  prompts = [];
});

afterEach(async () => {
  libraryTestHooks.confirm = undefined;
  await rm(tmp, { recursive: true, force: true });
});

/** Runs vd with HOME and VD_LIBRARY in the temporary folder, so no real library is used. */
async function vdEnv(env: Record<string, string>, ...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    { HOME: join(tmp, "home"), ...env },
    { repoRoot: tmp },
  );
  const result = { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  // No output names a path in the temporary folder, whatever happened.
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(tmp);
  return result;
}

function vd(...args: string[]) {
  return vdEnv({ VD_LIBRARY: lib }, ...args);
}

function answer(yes: boolean) {
  libraryTestHooks.confirm = async (prompt) => {
    prompts.push(prompt);
    return yes;
  };
}

async function entryYaml(kind: string, id: string) {
  return parse(await readFile(join(lib, kind, id, "entry.yaml"), "utf8"));
}

const importDoor = [
  "library",
  "import",
  "door.wav",
  "--kind",
  "sfx",
  "--id",
  "door-creak-01",
  "--license",
  "CC-BY-4.0",
  "--url",
  "https://example.com/sounds/1",
  "--site",
  "Example Sounds",
  "--author",
  "Jane Doe",
  "--attribution",
  '"Old door" by Jane Doe, CC BY 4.0',
  "--evidence",
  "terms.html",
  "--tags",
  "door, wood,creak",
  "--title",
  "Old wooden door creak",
];

/** Runs `fn` with the temporary folder as the current folder, so paths can be relative. */
async function inTmp<T>(fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
  }
}

describe("vd library", () => {
  test("init, import with a license and evidence, search, verify, and check", async () => {
    const init = await vd("library", "init", lib);
    expect(init).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(init.stdout).toMatch(/^Created a sound library/);

    const imported = await inTmp(() => vd(...importDoor));
    expect(imported).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(imported.stdout).toMatch(/^Imported sfx\/door-creak-01 \(unverified\)/);
    const entry = await entryYaml("sfx", "door-creak-01");
    expect(entry.license).toMatchObject({ id: "CC-BY-4.0", verified: false });
    expect(entry.license.evidence).toMatch(/^evidence\/[0-9a-f]{64}\.html$/);
    expect(entry.tags).toEqual(["door", "wood", "creak"]);
    expect(entry.source).toMatchObject({ type: "downloaded", site: "Example Sounds" });

    const found = await vd("library", "search", "wood", "door");
    expect(found).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(found.stdout).toBe(
      "sfx/door-creak-01: Old wooden door creak [door, wood, creak] (CC-BY-4.0, unverified)",
    );
    expect((await vd("library", "search", "door", "--kind", "bgm")).stdout).toBe(
      "No matching entries",
    );
    const json = await vd("library", "search", "creak", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject([
      { kind: "sfx", id: "door-creak-01", license: "CC-BY-4.0", verified: false },
    ]);

    answer(true);
    const verified = await vd("library", "verify", "door-creak-01");
    expect(verified).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(verified.stdout).toContain("URL: https://example.com/sounds/1");
    expect(verified.stdout).toContain("License: CC-BY-4.0");
    expect(verified.stdout).toContain(`Evidence: ${entry.license.evidence}`);
    expect(verified.stdout).toMatch(/Verified sfx\/door-creak-01$/);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/Type yes to confirm/);
    const after = await entryYaml("sfx", "door-creak-01");
    expect(after.license.verified).toBe(true);
    expect(after.license.approvedFor).toBeUndefined();
    expect((await vd("library", "search", "door")).stdout).toContain("(CC-BY-4.0, verified)");

    expect(await vd("library", "check")).toEqual({
      code: EXIT_OK,
      stdout: "Library check passed",
      stderr: "",
    });
  });

  test("--library overrides VD_LIBRARY", async () => {
    await vd("library", "init", lib);
    const other = await vdEnv(
      { VD_LIBRARY: join(tmp, "missing") },
      "library",
      "check",
      "--library",
      lib,
    );
    expect(other.code).toBe(EXIT_OK);
  });

  test("fails without a library, and names no path", async () => {
    const result = await vdEnv({}, "library", "search", "door");
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toMatch(/no library is set; use --library, VD_LIBRARY/);
  });

  test("reports a folder that is not a library without naming it", async () => {
    const result = await vdEnv({ VD_LIBRARY: join(sound, "lib") }, "library", "check");
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      "error: library.yaml: Library file library.yaml: could not inspect library.yaml (ENOTDIR)",
    );
  });

  test("init refuses an existing library", async () => {
    await vd("library", "init", lib);
    const again = await vd("library", "init", lib);
    expect(again.code).toBe(EXIT_FAILURE);
    expect(again.stderr).toBe("vd library init: The library folder already has library.yaml");
  });

  test("rejects bad usage", async () => {
    expect((await vd("library")).code).toBe(EXIT_USAGE);
    expect((await vd("library", "promote")).code).toBe(EXIT_USAGE);
    expect((await vd("library", "import", "door.wav", "--kind", "sfx")).code).toBe(EXIT_USAGE);
    expect((await vd("library", "search")).code).toBe(EXIT_USAGE);
    expect((await vd("library", "search", "x", "--kind", "voice")).code).toBe(EXIT_USAGE);
    expect((await vd("library", "check", "--json")).code).toBe(EXIT_USAGE);
    expect((await vd("library", "verify", "a", "--yes")).code).toBe(EXIT_USAGE);
    expect((await vd("validate", "--kind", "sfx")).code).toBe(EXIT_USAGE);
    const help = await vd("library", "--help");
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toMatch(/^Usage: vd library/);
  });

  describe("with a library", () => {
    beforeEach(async () => {
      await vd("library", "init", lib);
    });

    test("import without evidence is added but reported", async () => {
      const result = await vd(
        "library",
        "import",
        sound,
        "--kind",
        "sfx",
        "--id",
        "door-02",
        "--license",
        "CC0-1.0",
      );
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toBe(
        "error: sfx/door-02/entry.yaml: Downloaded entry has no license.evidence",
      );
      expect(result.stdout).toMatch(/with errors to fix before verifying/);
      const check = await vd("library", "check");
      expect(check.code).toBe(EXIT_FAILURE);
      expect(check.stderr).toContain("Downloaded entry has no license.evidence");
    });

    test("import errors do not name the input file", async () => {
      const missing = join(tmp, "missing.wav");
      const result = await vd(
        "library",
        "import",
        missing,
        "--kind",
        "sfx",
        "--id",
        "x-01",
        "--license",
        "CC0-1.0",
      );
      expect(result).toMatchObject({
        code: EXIT_FAILURE,
        stderr: "vd library import: Sound file [input file] not found",
      });
      const license = await vd(
        "library",
        "import",
        sound,
        "--kind",
        "sfx",
        "--id",
        "x-01",
        "--license",
        "nope",
      );
      expect(license.stderr).toBe(
        'vd library import: Unknown license "nope". Add it to licenses.yaml before importing.',
      );
    });

    test("verify changes nothing unless a human confirms", async () => {
      await inTmp(() => vd(...importDoor));
      const before = await readFile(join(lib, "sfx", "door-creak-01", "entry.yaml"), "utf8");

      answer(false);
      const declined = await vd("library", "verify", "door-creak-01");
      expect(declined.code).toBe(EXIT_FAILURE);
      expect(declined.stdout).toMatch(/Not confirmed; sfx\/door-creak-01 was not verified$/);

      // Without the test hook, a terminal is required, and tests have none.
      libraryTestHooks.confirm = undefined;
      const noTerminal = await vd("library", "verify", "door-creak-01");
      expect(noTerminal.code).toBe(EXIT_FAILURE);
      expect(noTerminal.stderr).toBe(
        "vd library verify: verify needs a human at an interactive terminal; the entry was not changed",
      );
      expect(await readFile(join(lib, "sfx", "door-creak-01", "entry.yaml"), "utf8")).toBe(before);
    });

    test("verify refuses a broken entry before asking", async () => {
      await vd(
        "library",
        "import",
        sound,
        "--kind",
        "sfx",
        "--id",
        "door-02",
        "--license",
        "CC0-1.0",
      );
      answer(true);
      const result = await vd("library", "verify", "door-02");
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toContain("Downloaded entry has no license.evidence");
      expect(prompts).toEqual([]);
      expect((await entryYaml("sfx", "door-02")).license.verified).toBe(false);
    });

    test("verify --approve-commercial asks for both in one confirmation", async () => {
      await inTmp(() => vd(...importDoor));
      answer(true);
      const result = await vd("library", "verify", "door-creak-01", "--approve-commercial");
      expect(result.code).toBe(EXIT_OK);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatch(/and approve commercial use/);
      expect((await entryYaml("sfx", "door-creak-01")).license).toMatchObject({
        verified: true,
        approvedFor: "commercial",
      });
    });

    test("verify needs --kind when an sfx and a bgm entry share the ID", async () => {
      await inTmp(() => vd(...importDoor));
      const bgm = importDoor.map((arg) => (arg === "sfx" ? "bgm" : arg));
      await inTmp(() => vd(...bgm));
      answer(true);
      const ambiguous = await vd("library", "verify", "door-creak-01");
      expect(ambiguous.stderr).toMatch(/give the kind/);
      expect(prompts).toEqual([]);
      expect((await vd("library", "verify", "door-creak-01", "--kind", "bgm")).code).toBe(EXIT_OK);
      expect((await entryYaml("bgm", "door-creak-01")).license.verified).toBe(true);
      expect((await entryYaml("sfx", "door-creak-01")).license.verified).toBe(false);
    });

    test("check reports a sound file that changed", async () => {
      await inTmp(() => vd(...importDoor));
      await writeFile(join(lib, "sfx", "door-creak-01", "sound.wav"), "changed");
      const result = await vd("library", "check");
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toMatch(
        /^error: sfx\/door-creak-01\/entry\.yaml: sfx\/door-creak-01\/sound\.wav does not match its sha256/,
      );
    });

    test("search escapes unprintable characters and redacts paths in metadata", async () => {
      await inTmp(() =>
        vd(
          ...importDoor.map((arg) =>
            arg === "Old wooden door creak" ? `door\u2028${tmp}/x` : arg,
          ),
        ),
      );
      const text = await vd("library", "search", "door");
      expect(text.stdout).toContain("door\\u{2028}[path]");
      const json = await vd("library", "search", "door", "--json");
      expect(JSON.parse(json.stdout)[0].title).toBe("door\\u{2028}[path]");
    });

    test("verify refuses if the license terms changed before the confirmation", async () => {
      await inTmp(() => vd(...importDoor));
      libraryTestHooks.confirm = async () => {
        const file = join(lib, "licenses.yaml");
        const licenses = parse(await readFile(file, "utf8"));
        licenses["CC-BY-4.0"].commercialUse = "unknown";
        await writeFile(file, stringify(licenses));
        return true;
      };
      const result = await vd("library", "verify", "door-creak-01");
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toMatch(/changed meanwhile; it was not verified/);
      expect((await entryYaml("sfx", "door-creak-01")).license.verified).toBe(false);
    });
  });
});

describe("safeLibraryText", () => {
  test("keeps URLs and relative paths, and redacts absolute ones", () => {
    expect(safeLibraryText("see https://example.com/a/b and sfx/a and /home/u/x")).toBe(
      "see https://example.com/a/b and sfx/a and [path]",
    );
    expect(safeLibraryText("C:\\Users\\u\\x.wav")).toBe("[path]");
    expect(safeLibraryText("a\nb\u200bc")).toBe("a\\u{a}b\\u{200b}c");
  });

  test("redacts absolute input files, even with spaces, and shows relative ones", () => {
    expect(safeLibraryText("Sound file /my dir/a.wav not found", ["/my dir/a.wav"])).toBe(
      "Sound file [input file] not found",
    );
    expect(safeLibraryText("sfx/x/sound.wav and sound.wav", ["sound.wav"])).toBe(
      "sfx/x/sound.wav and sound.wav",
    );
  });
});

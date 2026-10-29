import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDITS_FILE, importEntry, readLibrary, verifyEntry } from "@vd-creator/library";
import { encodeWav } from "@vd-creator/providers";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from "./index.js";

let tmp: string;
let lib: string;
let dir: string;

const ATTRIBUTION = '"Old door" by Jane Doe, CC BY 4.0';

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vd-cli-library-project-"));
  lib = join(tmp, "vd-library");
  dir = join(tmp, "drama");
  expect((await vd("init", dir)).code).toBe(EXIT_OK);
  expect((await vd("library", "init", lib)).code).toBe(EXIT_OK);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Runs vd with VD_LIBRARY set, unless `env` says otherwise, and no real user directory. */
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
  // No output names a path in the temporary folder, except the init commands', which print it.
  if (!args.slice(0, 2).includes("init")) {
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(tmp);
  }
  return result;
}

function vd(...args: string[]) {
  return vdEnv({ VD_LIBRARY: lib }, ...args);
}

/** A PCM WAV of `sec` seconds at 8 kHz. */
function wav(sec: number, level = 0.1): Uint8Array {
  return encodeWav(new Array(Math.round(sec * 8000)).fill(level), 8000);
}

async function addDoor(options: { verify: boolean }) {
  const sound = join(tmp, "door.wav");
  const evidence = join(tmp, "terms.html");
  await writeFile(sound, wav(2));
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
}

async function editScenario(edit: (text: string) => string) {
  const file = join(dir, "scenario.yaml");
  await writeFile(file, edit(await readFile(file, "utf8")));
}

/** Makes the scenario use the library door, under `use`. */
async function useDoor(use: "private" | "non-commercial" | "commercial") {
  await editScenario((text) =>
    text
      .replace(/use: \S+/, `use: ${use}`)
      .concat("      - sfx: { library: door-01 }\n        id: door\n"),
  );
}

async function credits() {
  return JSON.parse(await readFile(join(dir, CREDITS_FILE), "utf8"));
}

describe("library sounds in a project", () => {
  test("a verified CC-BY entry validates, copies with its attribution, and plays", async () => {
    await addDoor({ verify: true });
    await useDoor("commercial");

    const before = await vd("validate", dir);
    expect(before.code).toBe(EXIT_OK);
    expect(before.stderr).toBe(
      "licenses: sfx/door-01 is not copied into the project yet; run vd generate (warning)",
    );

    const generated = await vd("generate", dir);
    expect(generated).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(generated.stdout).toMatch(/ {2}copy {8}sfx "door"/);
    expect(generated.stdout).toMatch(/Copied sfx "door": assets\/library\/[0-9a-f]{16}\.wav/);

    const { entries } = await credits();
    expect(entries).toEqual([
      expect.objectContaining({
        id: "door-01",
        kind: "sfx",
        file: expect.stringMatching(/^library\/[0-9a-f]{16}\.wav$/),
        license: expect.objectContaining({
          id: "CC-BY-4.0",
          verified: true,
          attribution: ATTRIBUTION,
        }),
      }),
    ]);

    // Once copied, the project validates and plans without the library.
    expect(await vdEnv({}, "validate", dir)).toMatchObject({ code: EXIT_OK, stderr: "" });
    const again = await vdEnv({}, "generate", dir);
    expect(again).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(again.stdout).toContain("Nothing to generate.");

    // vd clean keeps the copy.
    expect((await vd("clean", dir)).stdout).toBe("Removed 0 files and 0 cache entries");
    expect((await vd("library", "status", dir)).stdout).toBe("sfx/door-01: current");
  });

  test("an unverified entry fails validation under commercial use", async () => {
    await addDoor({ verify: false });
    await useDoor("commercial");
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const result = await vd("validate", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain('licenses: Library entry "door-01" has an unverified');
    expect(result.stdout).toBe("");

    // Under private use, it is a warning.
    await editScenario((text) => text.replace("use: commercial", "use: private"));
    const ok = await vd("validate", dir);
    expect(ok.code).toBe(EXIT_OK);
    expect(ok.stderr).toMatch(/unverified.*\(warning\)$/);
  });

  test("without a library, an uncopied entry fails validate and generate clearly", async () => {
    await useDoor("private");
    const draft = await vdEnv({}, "validate", dir);
    expect(draft.code).toBe(EXIT_OK);
    expect(draft.stderr).toMatch(
      /No sound library is set; use --library, VD_LIBRARY.*\(warning\)$/,
    );
    await editScenario((text) => text.replace("use: private", "use: non-commercial"));
    const validated = await vdEnv({}, "validate", dir);
    expect(validated.code).toBe(EXIT_FAILURE);
    expect(validated.stderr).toContain("No sound library is set; use --library, VD_LIBRARY");
    const generated = await vdEnv({}, "generate", dir);
    expect(generated.code).toBe(EXIT_FAILURE);
    expect(generated.stderr).toContain('vd generate: unresolved sfx "door": No sound library');

    // --library overrides the environment.
    await addDoor({ verify: true });
    const flagged = await vdEnv(
      { VD_LIBRARY: join(tmp, "nope") },
      "generate",
      dir,
      "--library",
      lib,
    );
    expect(flagged.code).toBe(EXIT_OK);
  });
});

describe("vd library promote, status, and sync", () => {
  test("promote adds a generated SFX to the library, unverified", async () => {
    await editScenario((text) => text.concat("      - sfx: Rain on glass\n        id: rain\n"));
    const early = await vd(
      "library",
      "promote",
      dir,
      "--item",
      "rain",
      "--id",
      "rain-01",
      "--license",
      "CC0-1.0",
    );
    expect(early.code).toBe(EXIT_FAILURE);
    expect(early.stderr).toContain("run vd generate first");

    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const promoted = await vd(
      "library",
      "promote",
      dir,
      "--item",
      "rain",
      "--id",
      "rain-01",
      "--license",
      "CC0-1.0",
      "--tags",
      "rain, weather",
    );
    expect(promoted).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(promoted.stdout).toMatch(/^Promoted rain to sfx\/rain-01 \(unverified\)/);
    const entry = parse(await readFile(join(lib, "sfx", "rain-01", "entry.yaml"), "utf8"));
    expect(entry).toMatchObject({
      id: "rain-01",
      kind: "sfx",
      tags: ["rain", "weather"],
      source: { type: "generated", provider: "mock", project: "drama", item: "rain" },
      license: { id: "CC0-1.0", verified: false },
    });

    // A line, a missing item, and a missing option.
    const line = await vd(
      "library",
      "promote",
      dir,
      "--item",
      "s1-l1",
      "--id",
      "x",
      "--license",
      "CC0-1.0",
    );
    expect(line.stderr).toContain('no SFX or BGM with the ID "s1-l1"');
    expect((await vd("library", "promote", dir, "--item", "rain", "--id", "x")).code).toBe(
      EXIT_USAGE,
    );
  });

  test("promote turns a generated BGM into a bgm entry", async () => {
    await editScenario((text) =>
      text.replace(
        "    title: Opening\n",
        "    title: Opening\n    bgm:\n      prompt: Calm piano\n",
      ),
    );
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const promoted = await vd(
      "library",
      "promote",
      "--item",
      "s1",
      "--id",
      "piano-01",
      "--license",
      "CC0-1.0",
      dir,
    );
    expect(promoted).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(promoted.stdout).toMatch(/^Promoted s1 to bgm\/piano-01/);
  });

  test("status reports a changed sound and sync updates it", async () => {
    await addDoor({ verify: true });
    await useDoor("private");
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const oldFile = (await credits()).entries[0].file;

    // Replace the sound under the same ID, as a human would after re-editing it.
    const entryDir = join(lib, "sfx", "door-01");
    const yamlText = await readFile(join(entryDir, "entry.yaml"), "utf8");
    const sound = wav(3, 0.2);
    const sha = createHash("sha256").update(sound).digest("hex");
    const file = parse(yamlText).file as string;
    await writeFile(join(entryDir, file), sound);
    await writeFile(
      join(entryDir, "entry.yaml"),
      yamlText.replace(/sha256: [0-9a-f]{64}/, `sha256: ${sha}`).replace(/durationSec: .*\n/, ""),
    );
    expect((await readLibrary(lib)).issues).toEqual([]);

    const status = await vd("library", "status", dir);
    expect(status).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(status.stdout).toBe(
      "sfx/door-01: sound changed\n1 changed; run vd library sync to update them",
    );

    const synced = await vd("library", "sync", dir);
    expect(synced).toMatchObject({ code: EXIT_OK, stderr: "" });
    expect(synced.stdout).toBe(
      "Updated sfx/door-01 (sound changed)\nUpdated 1 of 1 library sounds",
    );
    const [credit] = (await credits()).entries;
    expect(credit.sha256).toBe(sha);
    expect(credit.file).not.toBe(oldFile);
    expect((await vd("library", "status", dir)).stdout).toBe("sfx/door-01: current");

    // An entry gone from the library is reported and kept.
    await rm(entryDir, { recursive: true });
    expect((await vd("library", "status", dir)).stdout).toMatch(
      /^sfx\/door-01: missing from the library/,
    );
    const kept = await vd("library", "sync", dir);
    expect(kept.code).toBe(EXIT_OK);
    expect(kept.stderr).toMatch(/^vd library sync: kept sfx\/door-01/);
    expect((await credits()).entries).toHaveLength(1);
  });

  test("status of a project without library sounds, and a missing project", async () => {
    expect((await vd("library", "status", dir)).stdout).toBe("The project has no library sounds");
    const missing = await vd("library", "sync", join(tmp, "nope"));
    expect(missing.code).toBe(EXIT_FAILURE);
    expect(missing.stderr).toMatch(/^vd library sync: cannot read scenario.yaml in/);
  });
});

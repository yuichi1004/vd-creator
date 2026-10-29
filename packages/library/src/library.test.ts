import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parse } from "yaml";
import {
  checkLibrary,
  ENTRY_FILE,
  importEntry,
  initLibrary,
  LICENSES_FILE,
  LibraryError,
  LicenseRegistrySchema,
  promoteEntry,
  readLibrary,
  STANDARD_LICENSES,
  searchEntries,
  verifyEntry,
} from "./index.js";

let dir: string;
let root: string;
let sound: string;
let evidence: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-library-"));
  root = join(dir, "lib");
  sound = join(dir, "door.wav");
  evidence = join(dir, "terms.html");
  await writeFile(sound, "RIFF fake wav data");
  await writeFile(evidence, "<html>CC BY 4.0</html>");
  await initLibrary(root, { name: "Test library" });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const download = {
  kind: "sfx" as const,
  id: "door-creak-01",
  license: "CC-BY-4.0",
  title: "Old wooden door creak",
  tags: ["door", "wood", "creak"],
  url: "https://example.com/sounds/1",
  author: "Jane Doe",
  attribution: '"Old door" by Jane Doe, CC BY 4.0',
  date: "2026-10-29",
};

function messages(issues: { message: string }[]): string[] {
  return issues.map((i) => i.message);
}

describe("initLibrary", () => {
  test("writes the standard Creative Commons registry", async () => {
    const library = await readLibrary(root);
    expect(library.meta).toEqual({ version: 1, name: "Test library" });
    expect(Object.keys(library.licenses)).toEqual([
      "CC0-1.0",
      "CC-BY-4.0",
      "CC-BY-SA-4.0",
      "CC-BY-NC-4.0",
      "CC-BY-NC-SA-4.0",
    ]);
    const text = await readFile(join(root, LICENSES_FILE), "utf8");
    expect(text).toMatch(/^# License registry/);
    expect(LicenseRegistrySchema.parse(parse(text))).toEqual(STANDARD_LICENSES);
    expect(library.licenses["CC-BY-NC-4.0"]?.commercialUse).toBe("forbidden");
    expect(library.licenses["CC-BY-SA-4.0"]?.shareAlike).toBe(true);
    expect(await checkLibrary(root)).toEqual([]);
  });

  test("refuses to overwrite a library", async () => {
    await expect(initLibrary(root)).rejects.toThrow(LibraryError);
  });

  test("readLibrary rejects a folder without library.yaml", async () => {
    await expect(readLibrary(dir)).rejects.toThrow(/library\.yaml not found/);
  });
});

describe("importEntry", () => {
  test("imports a downloaded sound with its evidence, unverified", async () => {
    const { entry, issues } = await importEntry(root, sound, { ...download, evidence });
    expect(issues).toEqual([]);
    expect(entry.dir).toBe("sfx/door-creak-01");
    expect(entry.entry.license).toMatchObject({ id: "CC-BY-4.0", verified: false });
    expect(entry.entry.license.evidence).toMatch(/^evidence\/[0-9a-f]{64}\.html$/);
    expect(entry.entry.source).toMatchObject({ type: "downloaded", retrievedAt: "2026-10-29" });

    const written = parse(await readFile(join(root, entry.dir, ENTRY_FILE), "utf8"));
    expect(written.file).toBe("sound.wav");
    expect(await readFile(join(root, entry.dir, "sound.wav"), "utf8")).toBe("RIFF fake wav data");
    expect(await checkLibrary(root)).toEqual([]);
  });

  test("an agent import stays unverified until verifyEntry", async () => {
    await importEntry(root, sound, { ...download, evidence });
    const [before] = await searchEntries(root, "door");
    expect(before?.verified).toBe(false);

    const verified = await verifyEntry(root, "door-creak-01", { date: "2026-10-30" });
    expect(verified.entry.license).toMatchObject({ verified: true, verifiedAt: "2026-10-30" });
    expect(verified.entry.license.approvedFor).toBeUndefined();
    const [after] = await searchEntries(root, "door");
    expect(after?.verified).toBe(true);
  });

  test("verifyEntry keeps comments and can approve commercial use", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    const path = join(root, entry.dir, ENTRY_FILE);
    await writeFile(path, `# Checked against the site\n${await readFile(path, "utf8")}`);
    await verifyEntry(root, "door-creak-01", { approveCommercial: true });
    const text = await readFile(path, "utf8");
    expect(text).toMatch(/^# Checked against the site\n/);
    expect(parse(text).license.approvedFor).toBe("commercial");
  });

  test("reports missing evidence, and verifyEntry refuses the entry", async () => {
    const { issues } = await importEntry(root, sound, download);
    expect(messages(issues)).toEqual(["Downloaded entry has no license.evidence"]);
    await expect(verifyEntry(root, "door-creak-01")).rejects.toThrow(/no license\.evidence/);
  });

  test("reports an evidence file that was deleted", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    await rm(join(root, entry.entry.license.evidence ?? ""));
    expect(messages(await checkLibrary(root))).toEqual([
      `Evidence file ${entry.entry.license.evidence} not found`,
    ]);
  });

  test("refuses an unknown license, a reused ID, and an unsafe ID", async () => {
    await expect(importEntry(root, sound, { ...download, license: "nope" })).rejects.toThrow(
      /Unknown license "nope"/,
    );
    await importEntry(root, sound, { ...download, evidence });
    await expect(importEntry(root, sound, { ...download, evidence })).rejects.toThrow(
      /already exists/,
    );
    await expect(importEntry(root, sound, { ...download, id: "../escape" })).rejects.toThrow(
      /Invalid entry id/,
    );
  });

  test("refuses a missing sound file without writing anything", async () => {
    await expect(importEntry(root, join(dir, "missing.wav"), download)).rejects.toThrow(
      /Sound file .*missing\.wav not found/,
    );
    expect((await readLibrary(root)).entries).toEqual([]);
  });
});

describe("promoteEntry", () => {
  test("promotes a generated asset with its generation record", async () => {
    const { entry, issues } = await promoteEntry(root, sound, {
      id: "thunder-01",
      license: "CC0-1.0",
      tags: ["thunder"],
      record: {
        kind: "sfx",
        providerId: "mock",
        request: { prompt: "distant thunder", take: 0 },
        durationSec: 3,
        createdAt: "2026-10-29T10:00:00.000Z",
      },
      project: "lighthouse-keeper",
      item: "s1-thunder",
    });
    expect(issues).toEqual([]);
    expect(entry.entry).toMatchObject({
      kind: "sfx",
      durationSec: 3,
      source: { type: "generated", provider: "mock", project: "lighthouse-keeper" },
      license: { verified: false },
    });
  });

  test("refuses a voice asset", async () => {
    await expect(
      promoteEntry(root, sound, {
        id: "voice-01",
        license: "CC0-1.0",
        record: { kind: "voice", providerId: "mock", request: {} },
      }),
    ).rejects.toThrow(/Only sfx and bgm/);
  });
});

describe("checkLibrary", () => {
  test("reports a hash mismatch", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    await writeFile(join(root, entry.dir, "sound.wav"), "edited");
    const issues = await checkLibrary(root);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: "sfx/door-creak-01/entry.yaml",
      entryId: "door-creak-01",
      severity: "error",
    });
    expect(issues[0]?.message).toMatch(/sfx\/door-creak-01\/sound\.wav does not match its sha256/);
  });

  test("reports unknown licenses and missing attribution", async () => {
    const { entry } = await importEntry(root, sound, {
      ...download,
      evidence,
      attribution: undefined,
    });
    expect(messages(await checkLibrary(root))).toEqual([
      'License "CC-BY-4.0" requires attribution, but license.attribution is empty',
    ]);
    await writeFile(join(root, LICENSES_FILE), "{}\n");
    expect(messages(await checkLibrary(root))).toEqual([
      'License "CC-BY-4.0" is not in licenses.yaml',
    ]);
    expect(entry.entry.license.attribution).toBeUndefined();
  });

  test("reports an ID that does not match its folder, and duplicates", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    const text = await readFile(join(root, entry.dir, ENTRY_FILE), "utf8");
    await mkdir(join(root, "sfx", "copy"));
    await writeFile(join(root, "sfx", "copy", ENTRY_FILE), text);
    await writeFile(join(root, "sfx", "copy", "sound.wav"), "RIFF fake wav data");
    const found = messages(await checkLibrary(root));
    expect(found).toContain('Entry id "door-creak-01" does not match its folder name "copy"');
    expect(found).toContain('Duplicate sfx id "door-creak-01", first used in sfx/copy');
  });

  test("reports an invalid entry.yaml with its relative path", async () => {
    await mkdir(join(root, "bgm", "broken"));
    await writeFile(join(root, "bgm", "broken", ENTRY_FILE), "id: broken\nkind: bgm\ntypo: 1\n");
    const issues = await checkLibrary(root);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.file).toBe("bgm/broken/entry.yaml");
      expect(issue.message).not.toContain(dir);
    }
  });

  test("messages never contain the library's absolute path", async () => {
    const { entry } = await importEntry(root, sound, download);
    await writeFile(join(root, entry.dir, "sound.wav"), "edited");
    await rm(join(root, LICENSES_FILE));
    const issues = await checkLibrary(root);
    expect(issues.length).toBeGreaterThan(1);
    for (const issue of issues) expect(issue.message).not.toContain(dir);
  });
});

describe("searchEntries", () => {
  beforeEach(async () => {
    await importEntry(root, sound, { ...download, evidence });
    await importEntry(root, sound, {
      kind: "bgm",
      id: "rain-piano-01",
      license: "CC0-1.0",
      title: "Calm piano",
      tags: ["rain", "piano", "calm"],
      notes: "Loops cleanly after 0.2 s.",
      evidence,
    });
    await importEntry(root, sound, {
      kind: "sfx",
      id: "rain-window-01",
      license: "CC0-1.0",
      title: "Rain on a window, with a door far away",
      tags: ["rain", "window"],
      evidence,
    });
  });

  test("finds entries by tag", async () => {
    const results = await searchEntries(root, "rain");
    expect(results.map((r) => r.id)).toEqual(["rain-piano-01", "rain-window-01"]);
    expect(results[0]).toMatchObject({ kind: "bgm", license: "CC0-1.0", verified: false });
  });

  test("filters by kind and requires every word", async () => {
    expect((await searchEntries(root, "rain", { kind: "sfx" })).map((r) => r.id)).toEqual([
      "rain-window-01",
    ]);
    expect((await searchEntries(root, "RAIN calm")).map((r) => r.id)).toEqual(["rain-piano-01"]);
    expect(await searchEntries(root, "rain thunder")).toEqual([]);
  });

  test("ranks whole-tag matches before title matches", async () => {
    // "door" is a tag of door-creak-01 and only in the title of rain-window-01.
    expect((await searchEntries(root, "door")).map((r) => r.id)).toEqual([
      "door-creak-01",
      "rain-window-01",
    ]);
  });

  test("matches notes, and an empty query lists everything", async () => {
    expect((await searchEntries(root, "loops")).map((r) => r.id)).toEqual(["rain-piano-01"]);
    expect(await searchEntries(root, "")).toHaveLength(3);
  });
});

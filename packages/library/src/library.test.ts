import {
  chmod,
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { testHooks } from "./entries.js";
import {
  checkLibrary,
  ENTRY_FILE,
  importEntry,
  initLibrary,
  LIBRARY_FILE,
  LICENSES_FILE,
  LibraryError,
  LicenseRegistrySchema,
  promoteEntry,
  readLibrary,
  STANDARD_LICENSES,
  searchEntries,
  verifyEntry,
} from "./index.js";

// Lets a test make the next rename fail with a given error, such as EXDEV.
const fsControl = vi.hoisted(() => ({ renameError: undefined as Error | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename: typeof actual.rename = async (from, to) => {
    const failure = fsControl.renameError;
    fsControl.renameError = undefined;
    if (failure) throw failure;
    return actual.rename(from, to);
  };
  return { ...actual, rename };
});

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
    expect(verified.verified).toBe(true);
    expect(verified.entry.entry.license).toMatchObject({
      verified: true,
      verifiedAt: "2026-10-30",
    });
    expect(verified.entry.entry.license.approvedFor).toBeUndefined();
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

// Rewrites the entry.yaml of `entryDir` with `change` applied to its parsed content.
async function editEntry(
  entryDir: string,
  change: (entry: { license: Record<string, unknown> }) => void,
) {
  const path = join(root, entryDir, ENTRY_FILE);
  const entry = parse(await readFile(path, "utf8"));
  change(entry);
  await writeFile(path, stringify(entry));
}

describe("inherited registry keys (P2-2)", () => {
  test.each(["constructor", "toString", "hasOwnProperty"])(
    "license %s is not found in the registry",
    async (id) => {
      await expect(
        importEntry(root, sound, { ...download, license: id, evidence }),
      ).rejects.toThrow(`Unknown license "${id}"`);
      const { entry } = await importEntry(root, sound, { ...download, evidence });
      await editEntry(entry.dir, (e) => {
        e.license.id = id;
      });
      expect(messages(await checkLibrary(root))).toEqual([
        `License "${id}" is not in licenses.yaml`,
      ]);
    },
  );

  test("a __proto__ key in licenses.yaml is rejected without touching prototypes", async () => {
    await writeFile(
      join(root, LICENSES_FILE),
      "__proto__:\n  name: x\n  attribution: none\n  commercialUse: allowed\n" +
        "  modification: allowed\n  shareAlike: false\n",
    );
    const library = await readLibrary(root);
    expect(messages(library.issues).join("\n")).toMatch(/"__proto__" is not a valid license ID/);
    expect(Object.getPrototypeOf(library.licenses)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).commercialUse).toBeUndefined();
  });
});

describe("blank attribution (P2-3)", () => {
  test("import refuses whitespace-only attribution", async () => {
    const failure = await importEntry(root, sound, {
      ...download,
      evidence,
      attribution: "   ",
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LibraryError);
    expect(messages((failure as LibraryError).issues).join("\n")).toMatch(
      /Attribution must not be blank/,
    );
    expect((await readLibrary(root)).entries).toEqual([]);
  });

  test("checkLibrary reports whitespace-only attribution in entry.yaml", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    await editEntry(entry.dir, (e) => {
      e.license.attribution = " \t ";
    });
    expect(messages(await checkLibrary(root)).join("\n")).toMatch(/Attribution must not be blank/);
  });
});

describe("evidence content (P2-4)", () => {
  test("reports evidence whose bytes do not match the hash in its name", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    const rel = entry.entry.license.evidence ?? "";
    await writeFile(join(root, rel), "tampered");
    const [message] = messages(await checkLibrary(root));
    expect(message).toMatch(`Evidence file ${rel} does not match the hash in its name`);
  });

  test("reports evidence that is a folder", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    const rel = entry.entry.license.evidence ?? "";
    await rm(join(root, rel));
    await mkdir(join(root, rel));
    expect(messages(await checkLibrary(root))).toEqual([
      `Evidence file ${rel} is not a regular file`,
    ]);
  });

  test("reports evidence with a well-formed but wrong hash", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    const wrong = `evidence/${"a".repeat(64)}.html`;
    await writeFile(join(root, wrong), "<html>other</html>");
    await editEntry(entry.dir, (e) => {
      e.license.evidence = wrong;
    });
    expect(messages(await checkLibrary(root))[0]).toMatch(/does not match the hash in its name/);
  });

  test("import refuses an existing evidence file with different content", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    await writeFile(join(root, entry.entry.license.evidence ?? ""), "tampered");
    await expect(
      importEntry(root, sound, { ...download, id: "door-creak-02", evidence }),
    ).rejects.toThrow(/already exists with different content/);
    expect((await readLibrary(root)).entries.map((e) => e.entry.id)).toEqual(["door-creak-01"]);
  });

  test("import reuses an existing evidence file with the same content", async () => {
    await importEntry(root, sound, { ...download, evidence });
    const { issues } = await importEntry(root, sound, {
      ...download,
      id: "door-creak-02",
      evidence,
    });
    expect(issues).toEqual([]);
  });
});

describe("symbolic links (P2-5)", () => {
  test("reports a sound file that links outside the library", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    const file = join(root, entry.dir, "sound.wav");
    await rm(file);
    await symlink(sound, file);
    const found = messages(await checkLibrary(root));
    expect(found).toEqual([
      "Sound file sfx/door-creak-01/sound.wav: sfx/door-creak-01/sound.wav is a symbolic link; the library does not follow links",
    ]);
    for (const message of found) expect(message).not.toContain(dir);
  });

  test("reports an evidence file that is a link", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    const rel = entry.entry.license.evidence ?? "";
    const outside = join(dir, "evidence-copy.html");
    await rename(join(root, rel), outside);
    await symlink(outside, join(root, rel));
    expect(messages(await checkLibrary(root))[0]).toMatch(/is a symbolic link/);
  });

  test("skips an entry folder that links outside the library", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    const outside = join(dir, "outside-entry");
    await rename(join(root, entry.dir), outside);
    await symlink(outside, join(root, entry.dir));
    const library = await readLibrary(root);
    expect(library.entries).toEqual([]);
    expect(messages(library.issues)).toEqual([
      "Entry folder is a symbolic link; the library does not follow links",
    ]);
  });

  test("skips a kind folder that is a link", async () => {
    await importEntry(root, sound, { ...download, evidence });
    const outside = join(dir, "outside-sfx");
    await rename(join(root, "sfx"), outside);
    await symlink(outside, join(root, "sfx"));
    const library = await readLibrary(root);
    expect(library.entries).toEqual([]);
    expect(messages(library.issues).join("\n")).toMatch(/sfx is a symbolic link/);
  });

  test("import refuses to write through a linked kind folder", async () => {
    const outside = join(dir, "outside-sfx");
    await rename(join(root, "sfx"), outside);
    await symlink(outside, join(root, "sfx"));
    await expect(importEntry(root, sound, { ...download, evidence })).rejects.toThrow(
      /sfx is a symbolic link/,
    );
    await expect(readFile(join(outside, "door-creak-01", ENTRY_FILE))).rejects.toThrow();
  });

  test("import refuses to write through a linked evidence folder", async () => {
    const outside = join(dir, "outside-evidence");
    await rename(join(root, "evidence"), outside);
    await symlink(outside, join(root, "evidence"));
    await expect(importEntry(root, sound, { ...download, evidence })).rejects.toThrow(
      /evidence is a symbolic link/,
    );
    expect((await readLibrary(root)).entries).toEqual([]);
  });
});

// Moves the file or folder at `rel` in the library to `outside` and links it back.
async function linkOut(rel: string, outside: string) {
  await rename(join(root, rel), outside);
  await symlink(outside, join(root, rel));
}

describe("managed metadata files (P2-B)", () => {
  test("a linked library.yaml is refused by read and verify, and reported by check", async () => {
    await importEntry(root, sound, { ...download, evidence });
    await linkOut(LIBRARY_FILE, join(dir, "library.yaml"));
    const message =
      "Library file library.yaml: library.yaml is a symbolic link; the library does not follow links";
    await expect(readLibrary(root)).rejects.toThrow(message);
    expect(await checkLibrary(root)).toEqual([{ file: LIBRARY_FILE, message, severity: "error" }]);
    await expect(verifyEntry(root, "door-creak-01")).rejects.toThrow(message);
  });

  test("a linked licenses.yaml is reported, and verification refused", async () => {
    await importEntry(root, sound, { ...download, evidence });
    await linkOut(LICENSES_FILE, join(dir, "licenses.yaml"));
    const message =
      "License registry licenses.yaml: licenses.yaml is a symbolic link; the library does not follow links";
    const issues = await checkLibrary(root);
    expect(issues).toContainEqual({ file: LICENSES_FILE, message, severity: "error" });
    expect(messages(issues)).not.toContain("licenses.yaml not found");
    await expect(verifyEntry(root, "door-creak-01")).rejects.toThrow(message);
  });

  test("a linked entry.yaml is reported, and verification refused", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    const outside = join(dir, "entry.yaml");
    await linkOut(`${entry.dir}/${ENTRY_FILE}`, outside);
    const before = await readFile(outside, "utf8");
    const message =
      "Entry file sfx/door-creak-01/entry.yaml: sfx/door-creak-01/entry.yaml is a symbolic link; the library does not follow links";
    expect(await checkLibrary(root)).toEqual([
      { file: "sfx/door-creak-01/entry.yaml", message, severity: "error" },
    ]);
    await expect(verifyEntry(root, "door-creak-01")).rejects.toThrow(message);
    expect(await readFile(outside, "utf8")).toBe(before);
  });
});

describe("folders swapped during a write (P2-C)", () => {
  afterEach(() => {
    testHooks.validated = undefined;
    testHooks.staged = undefined;
  });

  // Swaps the library folder `rel` for a link to `outside`, keeping the real folder
  // inside the library under a dot name.
  async function swap(rel: string, outside: string) {
    const parts = rel.split("/");
    const name = parts.pop() ?? "";
    await rename(join(root, rel), join(root, ...parts, `.${name}-moved`));
    await symlink(outside, join(root, rel));
  }

  test.each(["validated", "staged"] as const)(
    "import writes nothing outside when sfx/ is swapped once %s",
    async (point) => {
      const outside = join(dir, "outside");
      await mkdir(outside);
      testHooks[point] = () => swap("sfx", outside);
      await expect(importEntry(root, sound, { ...download, evidence })).rejects.toThrow(
        "The library folders changed while the entry was being written; nothing was added",
      );
      expect(await readdir(outside)).toEqual([]);
      expect(await readdir(join(root, ".sfx-moved"))).not.toContain("door-creak-01");
    },
  );

  test.each(["validated", "staged"] as const)(
    "verifyEntry changes nothing outside when the entry folder is swapped once %s",
    async (point) => {
      const { entry } = await importEntry(root, sound, { ...download, evidence });
      const outside = join(dir, "outside-entry");
      await mkdir(outside);
      const text = await readFile(join(root, entry.dir, ENTRY_FILE), "utf8");
      await writeFile(join(outside, ENTRY_FILE), text);
      testHooks[point] = () => swap(entry.dir, outside);

      const result = await verifyEntry(root, "door-creak-01");
      expect(result).toMatchObject({
        verified: false,
        message:
          "The library folders changed while entry.yaml was being written; the entry was not verified",
      });
      expect(result.entry.entry.license.verified).toBe(false);
      expect(await readdir(outside)).toEqual([ENTRY_FILE]);
      expect(await readFile(join(outside, ENTRY_FILE), "utf8")).toBe(text);
      const moved = parse(
        await readFile(join(root, "sfx", ".door-creak-01-moved", ENTRY_FILE), "utf8"),
      );
      expect(moved.license.verified).toBe(false);
    },
  );

  test("verifyEntry reports verified when nothing changed", async () => {
    await importEntry(root, sound, { ...download, evidence });
    const result = await verifyEntry(root, "door-creak-01");
    expect(result.verified).toBe(true);
    expect(result.message).toBeUndefined();
    expect(await readdir(join(root, "sfx", "door-creak-01"))).toEqual([ENTRY_FILE, "sound.wav"]);
  });
});

// File permissions do not stop root, so these tests are skipped when running as root.
const isRoot = process.getuid?.() === 0;

describe("unreadable managed files (P2-B)", () => {
  async function unreadable(rel: string) {
    await chmod(join(root, ...rel.split("/")), 0o000);
  }

  test.skipIf(isRoot)("an unreadable library.yaml is a check issue", async () => {
    await unreadable(LIBRARY_FILE);
    const message = "Library file library.yaml: could not read it (EACCES)";
    const issues = await checkLibrary(root);
    expect(issues).toEqual([{ file: LIBRARY_FILE, message, severity: "error" }]);
    expect(JSON.stringify(issues)).not.toContain(dir);
    await expect(readLibrary(root)).rejects.toThrow(message);
  });

  test.skipIf(isRoot)("an unreadable licenses.yaml is a check issue", async () => {
    await importEntry(root, sound, { ...download, evidence });
    await unreadable(LICENSES_FILE);
    const message = "License registry licenses.yaml: could not read it (EACCES)";
    const issues = await checkLibrary(root);
    expect(issues).toContainEqual({ file: LICENSES_FILE, message, severity: "error" });
    expect(JSON.stringify(issues)).not.toContain(dir);
    await expect(verifyEntry(root, "door-creak-01")).rejects.toThrow(message);
  });

  test.skipIf(isRoot)("an unreadable entry.yaml is a check issue", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    await unreadable(`${entry.dir}/${ENTRY_FILE}`);
    const file = "sfx/door-creak-01/entry.yaml";
    const issues = await checkLibrary(root);
    expect(issues).toEqual([
      { file, message: `Entry file ${file}: could not read it (EACCES)`, severity: "error" },
    ]);
    expect(JSON.stringify(issues)).not.toContain(dir);
  });

  test.skipIf(isRoot)("an unreadable kind folder is a check issue", async () => {
    await importEntry(root, sound, { ...download, evidence });
    await unreadable("sfx");
    try {
      const issues = await checkLibrary(root);
      expect(issues).toEqual([
        { file: "sfx", message: "Could not list sfx (EACCES)", severity: "error" },
      ]);
      expect(JSON.stringify(issues)).not.toContain(dir);
    } finally {
      await chmod(join(root, "sfx"), 0o755);
    }
  });

  test.skipIf(isRoot)("unreadable sound and evidence files are check issues", async () => {
    const { entry } = await importEntry(root, sound, { ...download, evidence });
    await unreadable(`${entry.dir}/sound.wav`);
    await unreadable(entry.entry.license.evidence ?? "");
    const issues = await checkLibrary(root);
    expect(messages(issues)).toEqual([
      "Could not read sfx/door-creak-01/sound.wav (EACCES)",
      `Could not read ${entry.entry.license.evidence} (EACCES)`,
    ]);
    expect(JSON.stringify(issues)).not.toContain(dir);
  });
});

describe("failed writes (P2-C)", () => {
  afterEach(() => {
    testHooks.writing = undefined;
    testHooks.renaming = undefined;
    fsControl.renameError = undefined;
  });

  const moved = () => join(root, "sfx", ".door-creak-01-moved");
  const moveEntry = () => rename(join(root, "sfx", "door-creak-01"), moved());
  const exdev = () =>
    Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${dir}'`), {
      code: "EXDEV",
    });

  test.each([
    ["writing", "write a temporary file in sfx/door-creak-01 (ENOENT)"],
    ["renaming", "replace sfx/door-creak-01/entry.yaml (ENOENT)"],
  ] as const)(
    "verifyEntry is not verified when the entry folder moves before %s",
    async (point, what) => {
      await importEntry(root, sound, { ...download, evidence });
      testHooks[point] = moveEntry;
      const result = await verifyEntry(root, "door-creak-01");
      expect(result).toMatchObject({
        verified: false,
        message: `Could not ${what}; the entry was not verified`,
      });
      expect(result.message).not.toContain(dir);
      const kept = parse(await readFile(join(moved(), ENTRY_FILE), "utf8"));
      expect(kept.license.verified).toBe(false);
      // The folder changed, so a temporary file written before the move is left alone.
      const temps = (await readdir(moved())).filter((f) => f.endsWith(".tmp"));
      expect(temps).toHaveLength(point === "renaming" ? 1 : 0);
    },
  );

  test("verifyEntry is not verified on EXDEV at rename, and leaves no temporary file", async () => {
    await importEntry(root, sound, { ...download, evidence });
    fsControl.renameError = exdev();
    const result = await verifyEntry(root, "door-creak-01");
    expect(result).toMatchObject({
      verified: false,
      message: "Could not replace sfx/door-creak-01/entry.yaml (EXDEV); the entry was not verified",
    });
    const entryDir = join(root, "sfx", "door-creak-01");
    expect(await readdir(entryDir)).toEqual([ENTRY_FILE, "sound.wav"]);
    expect(parse(await readFile(join(entryDir, ENTRY_FILE), "utf8")).license.verified).toBe(false);
  });

  test("import adds nothing and leaves no staging folder on EXDEV at rename", async () => {
    testHooks.renaming = () => {
      fsControl.renameError = exdev();
    };
    const failure = importEntry(root, sound, { ...download, evidence });
    await expect(failure).rejects.toThrow(
      "Could not write sfx/door-creak-01 (EXDEV); nothing was added",
    );
    expect(await readdir(join(root, "sfx"))).toEqual([]);
  });
});

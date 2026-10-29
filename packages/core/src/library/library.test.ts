import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDITS_FILE,
  importEntry,
  initLibrary,
  readLibrary,
  verifyEntry,
} from "@vd-creator/library";
import { createMockProviders, encodeWav } from "@vd-creator/providers";
import { type Scenario, ScenarioDocument } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AssetCache } from "../cache.js";
import { planGeneration, runGeneration } from "../generate.js";
import { defaultResolvers } from "../resolver.js";
import { computeTimeline } from "../timeline.js";
import { checkLibraryLicenses } from "./licenses.js";
import { LIBRARY_DURATIONS_FILE, readCredits } from "./project.js";
import { libraryResolver, NO_LIBRARY } from "./resolver.js";
import { libraryStatus, syncLibrary } from "./sync.js";

let tmp: string;
let root: string;
let project: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vd-core-library-"));
  root = join(tmp, "library");
  project = join(tmp, "project");
  await initLibrary(root);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const ATTRIBUTION = '"Old door" by Jane Doe, CC BY 4.0';

/** A PCM WAV of `sec` seconds at 8 kHz. */
function wav(sec: number, level = 0.1): Uint8Array {
  return encodeWav(new Array(Math.round(sec * 8000)).fill(level), 8000);
}

/** Imports a downloaded CC-BY sound into the library, and verifies it unless told not to. */
async function addDoor(options: { verify?: boolean; sec?: number } = {}) {
  const sound = join(tmp, "door.wav");
  const evidence = join(tmp, "terms.html");
  await writeFile(sound, wav(options.sec ?? 2));
  await writeFile(evidence, "<html>CC BY 4.0</html>");
  await importEntry(root, sound, {
    kind: "sfx",
    id: "door-01",
    license: "CC-BY-4.0",
    title: "Old door",
    url: "https://example.com/sounds/1",
    author: "Jane Doe",
    attribution: ATTRIBUTION,
    evidence,
  });
  if (options.verify ?? true) await verifyEntry(root, "door-01", { kind: "sfx" });
}

function scenario(use: string): Scenario {
  const doc = new ScenarioDocument(
    [
      "version: 1",
      "title: Library test",
      `publish: { use: ${use} }`,
      "scenes:",
      "  - id: s1",
      "    items:",
      "      - sfx: { library: door-01 }",
      "        id: door",
      "      - pause: 1",
    ].join("\n"),
  );
  const { scenario, issues } = doc.validate();
  if (!scenario) throw new Error(`invalid scenario: ${JSON.stringify(issues)}`);
  return scenario;
}

async function generate(s: Scenario, library?: string) {
  const cache = await AssetCache.load(project);
  const resolvers = [libraryResolver(library), ...defaultResolvers(createMockProviders())];
  return { cache, resolvers, result: await runGeneration(s, cache, resolvers) };
}

describe("library resolver", () => {
  test("copies a verified CC-BY entry, credits it, and uses its duration", async () => {
    await addDoor({ sec: 2 });
    const s = scenario("commercial");
    const cache = await AssetCache.load(project);
    const resolvers = [libraryResolver(root), ...defaultResolvers(createMockProviders())];

    const plan = await planGeneration(s, cache, resolvers);
    expect(plan.items[0]).toMatchObject({ id: "door", status: "to-generate", resolver: "library" });
    expect(plan.cost).toEqual({ characters: 0, requests: 0 });

    const { result } = await generate(s, root);
    expect(result.failed).toBe(0);
    const [item] = result.items;
    expect(item).toMatchObject({ status: "generated", resolver: "library", durationSec: 2 });
    expect(item?.status === "generated" && item.file).toMatch(/^library\/[0-9a-f]{16}\.wav$/);

    const credits = await readCredits(project);
    expect(credits.entries).toEqual([
      expect.objectContaining({
        id: "door-01",
        kind: "sfx",
        file: item?.status === "generated" ? item.file : "",
        license: expect.objectContaining({ id: "CC-BY-4.0", attribution: ATTRIBUTION }),
      }),
    ]);
    expect(await checkLibraryLicenses(project, s, { library: root })).toEqual([]);

    // The project plays without the library.
    const timeline = await computeTimeline(s, cache, [
      libraryResolver(),
      ...defaultResolvers(createMockProviders()),
    ]);
    expect(timeline.items[0]).toMatchObject({ id: "door", durationSec: 2 });
    expect(timeline.items[0]?.missing).toBeUndefined();
    expect(timeline.durationSec).toBe(3);
    expect(await checkLibraryLicenses(project, s)).toEqual([]);

    // A second run copies nothing.
    expect((await generate(s, root)).result.items[0]?.status).toBe("cached");
  });

  test("an unverified entry is an error under commercial use", async () => {
    await addDoor({ verify: false });
    const s = scenario("commercial");
    const before = await checkLibraryLicenses(project, s, { library: root });
    expect(before).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        message: expect.stringMatching(/not copied/),
      }),
    );
    expect(before).toContainEqual(
      expect.objectContaining({
        severity: "error",
        target: { type: "entry", kind: "sfx", id: "door-01" },
        message: expect.stringMatching(/unverified/),
      }),
    );
    await generate(s, root);
    const after = await checkLibraryLicenses(project, s, { library: root });
    expect(after).toEqual([expect.objectContaining({ severity: "error" })]);
    // Under private use it is only a warning.
    expect(await checkLibraryLicenses(project, scenario("private"))).toEqual([
      expect.objectContaining({ severity: "warning" }),
    ]);
  });

  test("without a library, an uncopied entry is unresolved and its license unknown", async () => {
    const s = scenario("private");
    const { result } = await generate(s);
    expect(result.items[0]).toMatchObject({ status: "unresolved", reason: NO_LIBRARY });
    // Like an unverified entry: a warning for private use and an error otherwise.
    expect(await checkLibraryLicenses(project, s)).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining(NO_LIBRARY),
      }),
    ]);
    expect(await checkLibraryLicenses(project, scenario("non-commercial"))).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining(NO_LIBRARY) }),
    ]);
  });

  test("an unknown entry is unresolved with the library's message", async () => {
    const { result } = await generate(scenario("private"), root);
    expect(result.items[0]).toMatchObject({
      status: "unresolved",
      reason: 'No sfx entry with id "door-01"',
    });
  });

  test("a broken durations file makes the copy again instead of failing", async () => {
    await addDoor();
    const s = scenario("private");
    await generate(s, root);
    await writeFile(join(project, "assets", LIBRARY_DURATIONS_FILE), "{ not json");
    const { result } = await generate(s, root);
    expect(result.items[0]).toMatchObject({ status: "generated", durationSec: 2 });
    const text = await readFile(join(project, "assets", LIBRARY_DURATIONS_FILE), "utf8");
    expect(JSON.parse(text)).toEqual({ version: 1, durations: expect.any(Object) });
    expect(text.endsWith("}\n")).toBe(true);
  });
});

describe("library status and sync", () => {
  test("reports and updates a changed sound", async () => {
    await addDoor({ sec: 2 });
    const s = scenario("private");
    await generate(s, root);
    expect(await libraryStatus(project, await readLibrary(root))).toEqual([
      { kind: "sfx", id: "door-01", state: "current" },
    ]);

    // Replace the sound in the library under the same ID.
    const entryDir = join(root, "sfx", "door-01");
    const yamlText = await readFile(join(entryDir, "entry.yaml"), "utf8");
    const newSound = wav(3, 0.2);
    const sha = createHash("sha256").update(newSound).digest("hex");
    const file = /file: (\S+)/.exec(yamlText)?.[1] ?? "";
    await writeFile(join(entryDir, file), newSound);
    await writeFile(
      join(entryDir, "entry.yaml"),
      yamlText.replace(/sha256: [0-9a-f]{64}/, `sha256: ${sha}`).replace(/durationSec: .*\n/, ""),
    );

    const changed = await readLibrary(root);
    expect(await libraryStatus(project, changed)).toEqual([
      { kind: "sfx", id: "door-01", state: "sound-changed" },
    ]);
    expect(await syncLibrary(project, changed)).toEqual([
      { kind: "sfx", id: "door-01", state: "sound-changed", updated: true },
    ]);
    expect(await libraryStatus(project, changed)).toEqual([
      { kind: "sfx", id: "door-01", state: "current" },
    ]);
    const credit = (await readCredits(project)).entries[0];
    expect(credit?.sha256).toBe(sha);
    const cache = await AssetCache.load(project);
    const timeline = await computeTimeline(s, cache, [libraryResolver()]);
    expect(timeline.items[0]).toMatchObject({ durationSec: 3, assetFile: credit?.file });
  });

  test("reports an entry missing from the library and leaves it", async () => {
    await addDoor();
    await generate(scenario("private"), root);
    await rm(join(root, "sfx", "door-01"), { recursive: true });
    const library = await readLibrary(root);
    expect(await syncLibrary(project, library)).toEqual([
      expect.objectContaining({ id: "door-01", state: "missing", updated: false }),
    ]);
    expect((await readCredits(project)).entries).toHaveLength(1);
    expect(JSON.parse(await readFile(join(project, CREDITS_FILE), "utf8")).version).toBe(1);
  });
});

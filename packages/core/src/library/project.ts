// A project's copies of library sounds: assets/library/, credits.json, and the durations of
// the copies. See "Project integration" in docs/plans/0007-sound-library.md.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  CREDITS_FILE,
  type CreditEntry,
  type Credits,
  CreditsSchema,
  type Entry,
  type Library,
  type LibraryEntry,
  LibraryError,
  type LibraryKind,
  toCreditEntry,
} from "@vd-creator/library";
import { readWavInfo } from "@vd-creator/providers";
import type { Scenario } from "@vd-creator/scenario";
import { ASSETS_DIR } from "../cache.js";
import { ASSET_KEY_PREFIX_LENGTH } from "../canonical.js";
import { type ScenarioItem, scenarioItems } from "../items.js";

/** Folder of the library copies, relative to assets/. */
export const LIBRARY_ASSET_DIR = "library";
/** Durations of the library copies, relative to assets/. credits.json has no duration field. */
export const LIBRARY_DURATIONS_FILE = `${LIBRARY_ASSET_DIR}/durations.json`;

/** A scenario's reference to a library entry. */
export type LibraryRef = { kind: LibraryKind; id: string };

/** Thrown when credits.json or the durations file cannot be read. */
export class ProjectCreditsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectCreditsError";
  }
}

/** The library entry an item uses, or `undefined` for a generated item. */
export function libraryRef(item: ScenarioItem): LibraryRef | undefined {
  if (item.kind === "sfx" && typeof item.item.sfx !== "string") {
    return { kind: "sfx", id: item.item.sfx.library };
  }
  if (item.kind === "bgm" && "library" in item.bgm) return { kind: "bgm", id: item.bgm.library };
  return undefined;
}

/** The library entries a scenario uses, each once, in scenario order. */
export function libraryRefs(scenario: Scenario): LibraryRef[] {
  const refs = new Map<string, LibraryRef>();
  for (const item of scenarioItems(scenario)) {
    const ref = libraryRef(item);
    if (ref) refs.set(refKey(ref), ref);
  }
  return [...refs.values()];
}

/** A label for messages, such as `sfx/door-01`. */
export function refLabel(ref: LibraryRef): string {
  return `${ref.kind}/${ref.id}`;
}

function refKey(ref: LibraryRef): string {
  return `${ref.kind}\0${ref.id}`;
}

/** The credit of an entry in credits.json, if the project has one. */
export function findCredit(credits: Credits, ref: LibraryRef): CreditEntry | undefined {
  return credits.entries.find((e) => e.kind === ref.kind && e.id === ref.id);
}

/** Reads `<projectDir>/credits.json`, or returns empty credits if it does not exist. */
export async function readCredits(projectDir: string): Promise<Credits> {
  const data = await readJson(join(projectDir, CREDITS_FILE), CREDITS_FILE);
  if (data === undefined) return { version: 1, entries: [], providers: [] };
  const parsed = CreditsSchema.safeParse(data);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new ProjectCreditsError(`${CREDITS_FILE} is invalid${where}: ${issue?.message}`);
  }
  return parsed.data;
}

/** Durations of the library copies, by sha256 of the file. */
export type LibraryDurations = Record<string, number>;

/**
 * Reads the durations of the library copies. A missing or broken file, or a broken record in
 * it, counts as unknown, so the copy is made again from the library instead of failing.
 */
export async function readDurations(projectDir: string): Promise<LibraryDurations> {
  let data: unknown;
  try {
    data = await readJson(join(projectDir, ASSETS_DIR, LIBRARY_DURATIONS_FILE), "");
  } catch {
    return {};
  }
  const durations = isRecord(data) && data.version === 1 ? data.durations : undefined;
  const out: LibraryDurations = {};
  if (!isRecord(durations)) return out;
  for (const [sha, sec] of Object.entries(durations)) {
    if (/^[0-9a-f]{64}$/.test(sha) && typeof sec === "number" && Number.isFinite(sec) && sec > 0) {
      out[sha] = sec;
    }
  }
  return out;
}

async function readJson(path: string, name: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ProjectCreditsError(`Cannot read ${name}`, { cause: e });
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ProjectCreditsError(`${name} is not valid JSON`, { cause: e });
  }
}

/** The copy of an entry in a project: `library/<sha256 prefix>.<ext>`, relative to assets/. */
export function libraryAssetFile(entry: Entry): string {
  const ext = extname(entry.file).toLowerCase();
  return `${LIBRARY_ASSET_DIR}/${entry.sha256.slice(0, ASSET_KEY_PREFIX_LENGTH)}${ext}`;
}

/** A copy of an entry in a project, and its duration. */
export type ProjectCopy = { credit: CreditEntry; durationSec: number };

/**
 * The project's copy of an entry, if credits.json has the entry, its file exists and matches
 * the credit's sha256, and its duration is known. This is what plays; the library is not
 * needed. credits.json records no size, so the hash is the whole check.
 */
export async function projectCopy(
  projectDir: string,
  credits: Credits,
  durations: LibraryDurations,
  ref: LibraryRef,
): Promise<ProjectCopy | undefined> {
  const credit = findCredit(credits, ref);
  const durationSec = credit && durations[credit.sha256];
  if (!credit || durationSec === undefined) return undefined;
  const path = join(projectDir, ASSETS_DIR, credit.file);
  if ((await fileSha256(path)) !== credit.sha256) return undefined;
  return { credit, durationSec };
}

// Hashes of project copies by path, kept while the file's size, mtime, and inode stay the
// same, so that a plan does not read every copy again.
const copyHashes = new Map<string, { key: string; hash: Promise<string> }>();

/**
 * The sha256 of a regular file, or `undefined` if it is not one. The hash is computed once per
 * version of the file, so concurrent and later calls share it.
 */
async function fileSha256(path: string): Promise<string | undefined> {
  let key: string;
  try {
    const info = await lstat(path);
    if (!info.isFile()) return undefined;
    key = `${info.size}:${info.mtimeMs}:${info.ino}`;
  } catch {
    return undefined;
  }
  let known = copyHashes.get(path);
  if (known?.key !== key) {
    known = { key, hash: sha256(path) };
    copyHashes.set(path, known);
    const current = known;
    current.hash.catch(() => {
      if (copyHashes.get(path) === current) copyHashes.delete(path);
    });
  }
  try {
    return await known.hash;
  } catch {
    return undefined;
  }
}

// Temporary copies being written by this process, which a cleanup must leave alone.
const activeTemps = new Set<string>();
// A temporary copy at least this old is left over from a run that stopped.
const ORPHAN_AGE_MS = 60_000;
const TEMP_COPY = new RegExp(
  `^[0-9a-f]{${ASSET_KEY_PREFIX_LENGTH}}\\.[^.]+\\.[0-9a-f-]{36}\\.tmp$`,
);

/**
 * Removes the temporary copies, `<sha256 prefix>.<ext>.<uuid>.tmp`, that a stopped run left
 * in assets/library/. A copy still being written, by this process or by a recent one, stays.
 */
export async function removeOrphanCopies(projectDir: string): Promise<void> {
  const folder = join(projectDir, ASSETS_DIR, LIBRARY_ASSET_DIR);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const path = join(folder, name);
    if (!TEMP_COPY.test(name) || activeTemps.has(path)) continue;
    try {
      const info = await lstat(path);
      // copyFile may keep the source's mtime, so the inode change time counts too.
      const written = Math.max(info.mtimeMs, info.ctimeMs);
      if (info.isFile() && now - written >= ORPHAN_AGE_MS) await rm(path, { force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * Copies a library entry into the project and records it in credits.json, replacing any
 * earlier credit of the same entry. The copy must match the entry's sha256. Its duration is
 * the entry's `durationSec`, or else read from the file if it is a PCM WAV. Throws a
 * `LibraryError` if the copy does not match or its duration is unknown; credits.json is then
 * unchanged. Writes to one project are serialized.
 */
export async function copyLibraryEntry(
  projectDir: string,
  library: Library,
  item: LibraryEntry,
): Promise<ProjectCopy> {
  const { entry } = item;
  const file = libraryAssetFile(entry);
  const target = join(projectDir, ASSETS_DIR, file);
  const source = `${item.dir}/${entry.file}`;
  if ((await fileSha256(target)) !== entry.sha256) {
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    activeTemps.add(temp);
    try {
      try {
        await copyFile(join(library.root, item.dir, entry.file), temp);
      } catch (e) {
        throw new LibraryError(`Cannot copy ${source}`, [], { cause: e });
      }
      if ((await sha256(temp)) !== entry.sha256) {
        throw new LibraryError(`${source} does not match its sha256`);
      }
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
      activeTemps.delete(temp);
    }
  }
  const durationSec = entry.durationSec ?? (await wavDuration(target));
  if (durationSec === undefined) {
    throw new LibraryError(
      `The duration of ${source} is unknown; set durationSec in ${item.dir}/entry.yaml`,
    );
  }
  const credit = toCreditEntry(item, library.licenses, file);
  await updateProject(projectDir, (credits, durations) => {
    credits.entries = [
      ...credits.entries.filter((e) => !(e.kind === credit.kind && e.id === credit.id)),
      credit,
    ];
    durations[entry.sha256] = durationSec;
  });
  return { credit, durationSec };
}

/**
 * The duration of an entry's file in the library: its `durationSec`, or else read from the
 * file if it is a PCM WAV. `undefined` if neither works.
 */
export async function entryDuration(
  library: Library,
  item: LibraryEntry,
): Promise<number | undefined> {
  return (
    item.entry.durationSec ?? (await wavDuration(join(library.root, item.dir, item.entry.file)))
  );
}

async function wavDuration(path: string): Promise<number | undefined> {
  if (extname(path).toLowerCase() !== ".wav") return undefined;
  try {
    const { durationSec } = readWavInfo(new Uint8Array(await readFile(path)));
    return durationSec > 0 ? durationSec : undefined;
  } catch {
    return undefined;
  }
}

const updates = new Map<string, Promise<void>>();

/**
 * Reads credits.json and the durations, lets `change` edit them, and writes both back
 * atomically. Updates of one project run one at a time, so concurrent copies keep each
 * other's credits.
 */
export function updateProject(
  projectDir: string,
  change: (credits: Credits, durations: LibraryDurations) => void,
): Promise<void> {
  const run = (updates.get(projectDir) ?? Promise.resolve()).then(async () => {
    const credits = await readCredits(projectDir);
    const durations = await readDurations(projectDir);
    change(credits, durations);
    // Sorted by kind, then ID, so that the file does not depend on the order of copies.
    credits.entries.sort((a, b) => compareText(a.kind, b.kind) || compareText(a.id, b.id));
    const sorted = Object.fromEntries(
      Object.entries(durations).sort(([a], [b]) => compareText(a, b)),
    );
    await writeAtomic(
      join(projectDir, ASSETS_DIR, LIBRARY_DURATIONS_FILE),
      `${JSON.stringify({ version: 1, durations: sorted }, null, 2)}\n`,
    );
    await writeAtomic(join(projectDir, CREDITS_FILE), `${JSON.stringify(credits, null, 2)}\n`);
  });
  const tail = run.catch(() => {});
  updates.set(projectDir, tail);
  void tail.then(() => {
    if (updates.get(projectDir) === tail) updates.delete(projectDir);
  });
  return run;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function writeAtomic(target: string, data: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

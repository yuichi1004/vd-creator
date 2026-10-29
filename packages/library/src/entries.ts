import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { IdSchema } from "@vd-creator/scenario";
import { Document, parseDocument } from "yaml";
import { checkEntry } from "./check.js";
import {
  assertManagedDir,
  exists,
  findEntry,
  hashFile,
  inspectManagedPath,
  isErrno,
  type Library,
  type LibraryEntry,
  LibraryError,
  type LibraryIssue,
  parseYaml,
  pathProblem,
  readLibrary,
  readManagedText,
  recordIdentity,
  sameIdentity,
} from "./library.js";
import {
  ENTRY_FILE,
  type Entry,
  type EntryInput,
  EntrySchema,
  EVIDENCE_DIR,
  EVIDENCE_PATH,
  LIBRARY_FILE,
  LIBRARY_KINDS,
  LICENSES_FILE,
  type LibraryKind,
  lookupLicense,
  type Source,
} from "./schema.js";

/** Audio file extensions that an entry may have. */
export const AUDIO_EXTENSIONS = [".wav", ".mp3", ".flac", ".ogg", ".m4a"] as const;

/**
 * For tests only: called at the two points where a write can be interrupted, so that a
 * test can swap a folder for a symbolic link there. `validated` runs after the folders
 * are validated and before anything is written; `staged` runs after the new files are
 * written to a temporary place and before they are moved into place.
 */
export const testHooks: {
  validated?: (operation: "import" | "verify") => Promise<void> | void;
  staged?: (operation: "import" | "verify") => Promise<void> | void;
} = {};

const IMPORT_CHANGED =
  "The library folders changed while the entry was being written; nothing was added";
const VERIFY_CHANGED =
  "The library folders changed while entry.yaml was being written; the entry was not verified";

/** Result of adding an entry. `issues` are what `vd library check` reports for it. */
export type AddEntryResult = { entry: LibraryEntry; issues: LibraryIssue[] };

/** Fields shared by imports and promotions. */
type CommonEntryOptions = {
  /** New entry ID, unique within its kind. */
  id: string;
  /** License ID in licenses.yaml. */
  license: string;
  /** Defaults to the ID. */
  title?: string;
  tags?: string[];
  notes?: string;
  attribution?: string;
  durationSec?: number;
  loopable?: boolean;
  /** Today's date as YYYY-MM-DD. Defaults to the current UTC date. */
  date?: string;
};

export type ImportEntryOptions = CommonEntryOptions & {
  kind: LibraryKind;
  sourceType?: "downloaded" | "recorded" | "other";
  url?: string;
  site?: string;
  author?: string;
  /** Defaults to `date` for downloaded files. */
  retrievedAt?: string;
  /** File with the license terms as seen at download time. It is copied into evidence/. */
  evidence?: string;
  /** The file differs from the original download. */
  modified?: boolean;
};

/**
 * Generation record of a project asset, as in the project's cache.json (plan 0004):
 * `{ kind, providerId, request, durationSec, createdAt }`.
 */
export type GenerationRecord = {
  kind: string;
  providerId: string;
  request: Record<string, unknown>;
  durationSec?: number;
  createdAt?: string;
};

export type PromoteEntryOptions = CommonEntryOptions & {
  record: GenerationRecord;
  /** Name of the project the asset comes from. */
  project?: string;
  /** Item ID in that project. */
  item?: string;
};

/**
 * Imports an outside sound file with its license. The entry starts unverified, whoever
 * imports it; only `verifyEntry` marks it verified. Refuses an unknown license or an ID
 * already in use. Other gaps, such as missing evidence, are returned in `issues`.
 */
export async function importEntry(
  root: string,
  file: string,
  options: ImportEntryOptions,
): Promise<AddEntryResult> {
  const sourceType = options.sourceType ?? "downloaded";
  const source: Source = {
    type: sourceType,
    url: options.url,
    site: options.site,
    author: options.author,
    retrievedAt:
      options.retrievedAt ?? (sourceType === "downloaded" ? (options.date ?? today()) : undefined),
  };
  return addEntry(root, file, options.kind, options, source, {
    evidence: options.evidence,
    modified: options.modified,
  });
}

/**
 * Promotes a generated project asset into the library, given the asset file and its
 * generation record. The entry starts unverified.
 */
export async function promoteEntry(
  root: string,
  file: string,
  options: PromoteEntryOptions,
): Promise<AddEntryResult> {
  const { record } = options;
  const kind = LIBRARY_KINDS.find((k) => k === record.kind);
  if (!kind) {
    throw new LibraryError(`Only sfx and bgm assets can be promoted, not "${record.kind}"`);
  }
  const source: Source = {
    type: "generated",
    provider: record.providerId,
    request: record.request,
    generatedAt: record.createdAt,
    project: options.project,
    item: options.item,
  };
  return addEntry(
    root,
    file,
    kind,
    { ...options, durationSec: options.durationSec ?? record.durationSec },
    source,
    {},
  );
}

/**
 * Result of `verifyEntry`. `verified` is false, with `message` set, when the library
 * folders changed on disk during the write; entry.yaml was then left as it was.
 */
export type VerifyEntryResult = { verified: boolean; entry: LibraryEntry; message?: string };

/**
 * Marks an entry's license record as confirmed by a human, with today's date. With
 * `approveCommercial`, also approves conditional or unknown terms for commercial use.
 * Refuses while the entry, library.yaml, or licenses.yaml has check errors. Comments in
 * entry.yaml are kept.
 */
export async function verifyEntry(
  root: string,
  id: string,
  options: { kind?: LibraryKind; approveCommercial?: boolean; date?: string } = {},
): Promise<VerifyEntryResult> {
  const library = await readLibrary(root);
  const blocking = (file: string) =>
    file === LIBRARY_FILE ||
    file === LICENSES_FILE ||
    LIBRARY_KINDS.some(
      (k) =>
        (options.kind === undefined || options.kind === k) && file === `${k}/${id}/${ENTRY_FILE}`,
    );
  const refuse = (errors: LibraryIssue[]) => {
    if (errors.length === 0) return;
    throw new LibraryError(
      `Cannot verify "${id}" until these are fixed: ${errors.map((i) => i.message).join("; ")}`,
      errors,
    );
  };
  refuse(library.issues.filter((i) => i.severity === "error" && blocking(i.file)));
  const found = findEntry(library, id, options.kind);
  const entryFile = `${found.dir}/${ENTRY_FILE}`;
  refuse((await checkEntry(library, found)).filter((i) => i.severity === "error"));

  const entryDir = join(root, ...found.dir.split("/"));
  const ids = await recordIdentity([root, join(root, found.kind), entryDir]);
  await assertManagedDir(root, found.dir);
  const original = await readManagedText(root, entryFile, "Entry file");
  if (original === undefined) throw new LibraryError(`Entry file ${entryFile} not found`);
  const doc = parseDocument(original);
  doc.setIn(["license", "verified"], true);
  doc.setIn(["license", "verifiedAt"], options.date ?? today());
  if (options.approveCommercial) doc.setIn(["license", "approvedFor"], "commercial");
  const text = String(doc);
  const { data, issues } = parseYaml(text, entryFile, EntrySchema);
  if (!data) throw new LibraryError(`Cannot verify "${id}"`, issues);

  const unchanged: VerifyEntryResult = { verified: false, entry: found, message: VERIFY_CHANGED };
  await testHooks.validated?.("verify");
  if (!(await sameIdentity(ids))) return unchanged;
  const temp = join(entryDir, `.${ENTRY_FILE}.${randomUUID()}.tmp`);
  await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
  await testHooks.staged?.("verify");
  // On a change, the temporary file is left alone: its folder may now be anywhere.
  if (!(await sameIdentity(ids))) return unchanged;
  await rename(temp, join(entryDir, ENTRY_FILE));
  return { verified: true, entry: { ...found, entry: data } };
}

export type SearchResult = {
  kind: LibraryKind;
  id: string;
  title: string;
  tags: string[];
  durationSec?: number;
  license: string;
  verified: boolean;
  dir: string;
};

/**
 * Finds entries whose ID, title, tags, or notes contain every word of the query, ignoring
 * case. Entries with more words matching a whole tag come first. An empty query lists all
 * entries.
 */
export async function searchEntries(
  root: string,
  query: string | string[],
  options: { kind?: LibraryKind } = {},
): Promise<SearchResult[]> {
  const library = await readLibrary(root);
  return searchLibrary(library, query, options);
}

/** `searchEntries` over a library that is already read. */
export function searchLibrary(
  library: Library,
  query: string | string[],
  options: { kind?: LibraryKind } = {},
): SearchResult[] {
  const words = (Array.isArray(query) ? query : [query])
    .flatMap((q) => q.toLowerCase().split(/\s+/))
    .filter((w) => w.length > 0);
  const scored: { score: number; result: SearchResult }[] = [];
  for (const { kind, dir, entry } of library.entries) {
    if (options.kind && kind !== options.kind) continue;
    const tags = entry.tags.map((t) => t.toLowerCase());
    const fields = [entry.id, entry.title, entry.notes ?? "", ...tags].map((f) => f.toLowerCase());
    if (!words.every((w) => fields.some((f) => f.includes(w)))) continue;
    scored.push({
      score: words.filter((w) => tags.includes(w)).length,
      result: {
        kind,
        id: entry.id,
        title: entry.title,
        tags: entry.tags,
        durationSec: entry.durationSec,
        license: entry.license.id,
        verified: entry.license.verified,
        dir,
      },
    });
  }
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.result.kind.localeCompare(b.result.kind) ||
        a.result.id.localeCompare(b.result.id),
    )
    .map((s) => s.result);
}

async function addEntry(
  root: string,
  file: string,
  kind: LibraryKind,
  options: CommonEntryOptions,
  source: Source,
  extra: { evidence?: string; modified?: boolean },
): Promise<AddEntryResult> {
  const library = await readLibrary(root);
  const { id } = options;
  // Checked before the ID is used in a path.
  const idResult = IdSchema.safeParse(id);
  if (!idResult.success) {
    throw new LibraryError(`Invalid entry id "${id}": ${idResult.error.issues[0]?.message}`);
  }
  if (!lookupLicense(library.licenses, options.license)) {
    throw new LibraryError(
      `Unknown license "${options.license}". Add it to licenses.yaml before importing.`,
    );
  }
  const ext = extname(file).toLowerCase();
  if (!(AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new LibraryError(
      `Unsupported sound file type "${ext}"; use one of ${AUDIO_EXTENSIONS.join(", ")}`,
    );
  }
  const dir = `${kind}/${id}`;
  if (
    library.entries.some((e) => e.kind === kind && e.entry.id === id) ||
    (await exists(join(root, kind, id)))
  ) {
    throw new LibraryError(`${dir} already exists; entry IDs are never reused`);
  }
  await requireFile(file, "Sound file");
  if (extra.evidence !== undefined) await requireFile(extra.evidence, "Evidence file");

  const evidenceHash = extra.evidence === undefined ? undefined : await hashFile(extra.evidence);
  const evidence =
    evidenceHash === undefined
      ? undefined
      : `${EVIDENCE_DIR}/${evidenceHash}${safeExtension(extra.evidence ?? "")}`;
  const soundName = `sound${ext}`;
  const input: EntryInput = {
    id,
    kind,
    title: options.title ?? id,
    tags: options.tags ?? [],
    file: soundName,
    sha256: await hashFile(file),
    durationSec: options.durationSec,
    loopable: options.loopable,
    source: dropUndefined(source),
    license: dropUndefined({
      id: options.license,
      attribution: options.attribution,
      evidence,
      verified: false,
    }),
    notes: options.notes,
    modified: extra.modified ?? false,
  };
  const entryFile = `${dir}/${ENTRY_FILE}`;
  const text = String(new Document(dropUndefined(input)));
  const { data: entry, issues } = parseYaml(text, entryFile, EntrySchema);
  if (!entry) throw new LibraryError(`Invalid entry "${id}"`, issues);

  // Nothing is written through a symbolic link, so every write stays inside the library.
  const kindDir = join(root, kind);
  const evidenceDir = join(root, EVIDENCE_DIR);
  await assertManagedDir(root, kind);
  await mkdir(kindDir, { recursive: true });
  if (evidence !== undefined) {
    await assertManagedDir(root, EVIDENCE_DIR);
    await mkdir(evidenceDir, { recursive: true });
  }
  // The folders are validated after their identities are recorded, so the recorded
  // identities are those of the validated folders.
  const ids = await recordIdentity([root, kindDir, ...(evidence ? [evidenceDir] : [])]);
  await assertManagedDir(root, kind);
  if (evidence !== undefined) {
    await assertManagedDir(root, EVIDENCE_DIR);
    await checkExistingEvidence(root, evidence);
  }
  await testHooks.validated?.("import");
  if (!(await sameIdentity(ids))) throw new LibraryError(IMPORT_CHANGED);

  // The whole entry is written to a new dot folder in the kind folder, which readLibrary
  // skips, and moved into place only if no folder on the way changed meanwhile.
  const staging = await mkdtemp(join(kindDir, `.${id}.`));
  const stagedIds = [...ids, ...(await recordIdentity([staging]))];
  const stagedEvidence = join(staging, ".evidence");
  try {
    // Also confirms that mkdtemp created the folder in the validated kind folder.
    if (!(await sameIdentity(ids))) throw new LibraryError(IMPORT_CHANGED);
    await copyFile(file, join(staging, soundName), constants.COPYFILE_EXCL);
    if ((await hashFile(join(staging, soundName))) !== entry.sha256) {
      throw new LibraryError(`Sound file ${file} changed while it was being imported`);
    }
    if (extra.evidence !== undefined && evidence !== undefined) {
      await copyFile(extra.evidence, stagedEvidence, constants.COPYFILE_EXCL);
      if ((await hashFile(stagedEvidence)) !== EVIDENCE_PATH.exec(evidence)?.[1]) {
        throw new LibraryError(
          `Evidence file ${extra.evidence} changed while it was being imported`,
        );
      }
    }
    await writeFile(join(staging, ENTRY_FILE), text, { encoding: "utf8", flag: "wx" });
    await testHooks.staged?.("import");
    if (!(await sameIdentity(stagedIds))) throw new LibraryError(IMPORT_CHANGED);
    if (evidence !== undefined) {
      await placeEvidence(root, stagedEvidence, evidence);
      await rm(stagedEvidence);
    }
    await rename(staging, join(kindDir, id));
  } catch (e) {
    // After a change, nothing is removed: the staging folder may now be anywhere.
    if (!(await sameIdentity(stagedIds))) {
      throw new LibraryError(IMPORT_CHANGED, [], { cause: e });
    }
    await rm(staging, { recursive: true, force: true });
    if (isErrno(e, "ENOTEMPTY") || isErrno(e, "EEXIST")) {
      throw new LibraryError(`${dir} already exists; entry IDs are never reused`, [], {
        cause: e,
      });
    }
    throw e;
  }
  const added: LibraryEntry = { kind, dir, entry: entry as Entry };
  return { entry: added, issues: await checkEntry(library, added) };
}

// Evidence is stored by content hash. An existing file with that name is reused only if
// it is a regular file inside the library whose bytes match the hash.
async function checkExistingEvidence(root: string, evidence: string): Promise<void> {
  const state = await inspectManagedPath(root, evidence);
  if (state.status === "missing") return;
  if (state.status !== "file")
    throw new LibraryError(pathProblem("Evidence file", evidence, state));
  const expected = EVIDENCE_PATH.exec(evidence)?.[1];
  if ((await hashFile(join(root, evidence))) !== expected) {
    throw new LibraryError(
      `Evidence file ${evidence} already exists with different content; check the library`,
    );
  }
}

// Puts staged evidence at `evidence` without replacing an existing file. A hard link
// fails instead of overwriting; across file systems, an exclusive copy does the same.
async function placeEvidence(root: string, staged: string, evidence: string): Promise<void> {
  const target = join(root, ...evidence.split("/"));
  try {
    try {
      await link(staged, target);
    } catch (e) {
      if (!isErrno(e, "EXDEV") && !isErrno(e, "EPERM")) throw e;
      await copyFile(staged, target, constants.COPYFILE_EXCL);
    }
  } catch (e) {
    if (!isErrno(e, "EEXIST")) throw e;
    // Created since the first check: check it again.
    await checkExistingEvidence(root, evidence);
  }
}

async function requireFile(path: string, what: string): Promise<void> {
  let isFile = false;
  try {
    isFile = (await stat(path)).isFile();
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw e;
  }
  if (!isFile) throw new LibraryError(`${what} ${path} not found`);
}

function safeExtension(path: string): string {
  const ext = extname(path).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

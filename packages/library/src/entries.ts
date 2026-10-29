import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { IdSchema } from "@vd-creator/scenario";
import { Document, parseDocument } from "yaml";
import { checkEntry } from "./check.js";
import {
  exists,
  findEntry,
  hashFile,
  isErrno,
  type Library,
  type LibraryEntry,
  LibraryError,
  type LibraryIssue,
  parseYaml,
  readLibrary,
  writeFileAtomic,
} from "./library.js";
import {
  ENTRY_FILE,
  type Entry,
  type EntryInput,
  EntrySchema,
  EVIDENCE_DIR,
  LIBRARY_KINDS,
  type LibraryKind,
  type Source,
} from "./schema.js";

/** Audio file extensions that an entry may have. */
export const AUDIO_EXTENSIONS = [".wav", ".mp3", ".flac", ".ogg", ".m4a"] as const;

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
 * Marks an entry's license record as confirmed by a human, with today's date. With
 * `approveCommercial`, also approves conditional or unknown terms for commercial use.
 * Refuses while the entry has check errors. Comments in entry.yaml are kept.
 */
export async function verifyEntry(
  root: string,
  id: string,
  options: { kind?: LibraryKind; approveCommercial?: boolean; date?: string } = {},
): Promise<LibraryEntry> {
  const library = await readLibrary(root);
  const found = findEntry(library, id, options.kind);
  const entryFile = `${found.dir}/${ENTRY_FILE}`;
  const errors = [
    ...library.issues.filter((i) => i.file === entryFile),
    ...(await checkEntry(library, found)),
  ].filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw new LibraryError(
      `Cannot verify "${id}" until these are fixed: ${errors.map((i) => i.message).join("; ")}`,
      errors,
    );
  }

  const path = join(root, found.dir, ENTRY_FILE);
  const doc = parseDocument(await readFile(path, "utf8"));
  doc.setIn(["license", "verified"], true);
  doc.setIn(["license", "verifiedAt"], options.date ?? today());
  if (options.approveCommercial) doc.setIn(["license", "approvedFor"], "commercial");
  const text = String(doc);
  const { data, issues } = parseYaml(text, entryFile, EntrySchema);
  if (!data) throw new LibraryError(`Cannot verify "${id}"`, issues);
  await writeFileAtomic(path, text);
  return { ...found, entry: data };
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
  if (!library.licenses[options.license]) {
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

  // Stage the entry in a dot folder, which readLibrary skips, then move it into place.
  const staging = join(root, kind, `.${id}.${randomUUID()}.tmp`);
  try {
    await mkdir(staging, { recursive: true });
    await copyFile(file, join(staging, soundName));
    if ((await hashFile(join(staging, soundName))) !== entry.sha256) {
      throw new LibraryError(`Sound file ${file} changed while it was being imported`);
    }
    if (extra.evidence !== undefined && evidence !== undefined) {
      await copyEvidence(extra.evidence, join(root, evidence));
    }
    await writeFile(join(staging, ENTRY_FILE), text, "utf8");
    await rename(staging, join(root, kind, id));
  } catch (e) {
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

// Evidence is stored by content hash, so an existing file with the same name is the same.
async function copyEvidence(from: string, to: string): Promise<void> {
  await mkdir(join(to, ".."), { recursive: true });
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL);
  } catch (e) {
    if (!isErrno(e, "EEXIST")) throw e;
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

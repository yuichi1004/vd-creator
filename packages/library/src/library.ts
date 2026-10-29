import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Document, parseDocument } from "yaml";
import type { z } from "zod";
import {
  ENTRY_FILE,
  type Entry,
  EntrySchema,
  EVIDENCE_DIR,
  LIBRARY_FILE,
  LIBRARY_KINDS,
  LICENSES_FILE,
  type LibraryKind,
  type LibraryMeta,
  LibraryMetaSchema,
  type LicenseRegistry,
  LicenseRegistrySchema,
} from "./schema.js";
import { STANDARD_LICENSES } from "./standard-licenses.js";

/**
 * A problem found in the library. `file` is relative to the library root and uses "/"
 * separators, so that messages never contain machine-specific paths.
 */
export type LibraryIssue = {
  file: string;
  entryId?: string;
  message: string;
  severity: "error" | "warning";
};

/** Thrown when a library operation is refused. Nothing is written in that case. */
export class LibraryError extends Error {
  readonly issues: LibraryIssue[];

  constructor(message: string, issues: LibraryIssue[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "LibraryError";
    this.issues = issues;
  }
}

/** A valid entry and its folder, relative to the library root, such as `sfx/door-01`. */
export type LibraryEntry = { kind: LibraryKind; dir: string; entry: Entry };

/**
 * The library as read from disk. Entries or a registry that fail validation are left out
 * and reported in `issues`.
 */
export type Library = {
  root: string;
  meta: LibraryMeta;
  licenses: LicenseRegistry;
  entries: LibraryEntry[];
  issues: LibraryIssue[];
};

/**
 * Creates a library at `root`: library.yaml, licenses.yaml with the standard Creative
 * Commons licenses, and the sfx/, bgm/, and evidence/ folders. The folder may exist, but
 * must not already hold a library.
 */
export async function initLibrary(root: string, options: { name?: string } = {}): Promise<Library> {
  const meta = LibraryMetaSchema.parse({ version: 1, name: options.name ?? basename(root) });
  await mkdir(root, { recursive: true });
  const existing = new Set(await readdir(root));
  for (const file of [LIBRARY_FILE, LICENSES_FILE]) {
    if (existing.has(file)) throw new LibraryError(`${root} already has ${file}`);
  }
  const licenses = new Document(STANDARD_LICENSES);
  licenses.commentBefore =
    " License registry. Entries refer to these keys in license.id.\n" +
    " The Creative Commons licenses below have fixed terms. Add site-specific and provider\n" +
    " licenses yourself; any term may be unknown.";
  // "wx" fails instead of overwriting, in case another process created the files meanwhile.
  await writeFile(join(root, LICENSES_FILE), String(licenses), { encoding: "utf8", flag: "wx" });
  for (const dir of [...LIBRARY_KINDS, EVIDENCE_DIR]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await writeFile(join(root, LIBRARY_FILE), String(new Document(meta)), {
    encoding: "utf8",
    flag: "wx",
  });
  return readLibrary(root);
}

/** Reads the library at `root`. Throws a `LibraryError` if library.yaml is missing or invalid. */
export async function readLibrary(root: string): Promise<Library> {
  const metaText = await readOptional(join(root, LIBRARY_FILE));
  if (metaText === undefined) {
    throw new LibraryError(`Not a sound library: ${LIBRARY_FILE} not found in ${root}`);
  }
  const metaResult = parseYaml(metaText, LIBRARY_FILE, LibraryMetaSchema);
  if (!metaResult.data) {
    throw new LibraryError(`Invalid ${LIBRARY_FILE} in ${root}`, metaResult.issues);
  }
  const issues: LibraryIssue[] = [...metaResult.issues];

  let licenses: LicenseRegistry = {};
  const licensesText = await readOptional(join(root, LICENSES_FILE));
  if (licensesText === undefined) {
    issues.push(error(LICENSES_FILE, `${LICENSES_FILE} not found`));
  } else {
    const result = parseYaml(licensesText, LICENSES_FILE, LicenseRegistrySchema);
    issues.push(...result.issues);
    if (result.data) licenses = result.data;
  }

  const entries: LibraryEntry[] = [];
  for (const kind of LIBRARY_KINDS) {
    const seen = new Map<string, string>();
    const kindState = await inspectKindDir(root, kind);
    if (kindState) {
      issues.push(error(kind, kindState));
      continue;
    }
    const { dirs, links } = await listEntryDirs(root, kind);
    for (const name of links) {
      issues.push(
        error(
          `${kind}/${name}`,
          "Entry folder is a symbolic link; the library does not follow links",
        ),
      );
    }
    for (const name of dirs) {
      const dir = `${kind}/${name}`;
      const file = `${dir}/${ENTRY_FILE}`;
      const text = await readOptional(join(root, kind, name, ENTRY_FILE));
      if (text === undefined) {
        issues.push(error(file, `${ENTRY_FILE} not found`));
        continue;
      }
      const result = parseYaml(text, file, EntrySchema);
      issues.push(...result.issues);
      const entry = result.data;
      if (!entry) continue;
      const fail = (message: string) => issues.push({ ...error(file, message), entryId: entry.id });
      if (entry.kind !== kind) {
        fail(`Entry kind "${entry.kind}" does not match its folder ${kind}/`);
      }
      if (entry.id !== name) {
        fail(`Entry id "${entry.id}" does not match its folder name "${name}"`);
      }
      const first = seen.get(entry.id);
      if (first !== undefined) {
        fail(`Duplicate ${kind} id "${entry.id}", first used in ${first}`);
        continue;
      }
      seen.set(entry.id, dir);
      entries.push({ kind, dir, entry });
    }
  }
  return { root, meta: metaResult.data, licenses, entries, issues };
}

/**
 * Finds an entry by ID. With no kind, the ID must be unique across kinds. Throws a
 * `LibraryError` if there is no single match.
 */
export function findEntry(library: Library, id: string, kind?: LibraryKind): LibraryEntry {
  const matches = library.entries.filter(
    (e) => e.entry.id === id && (kind === undefined || e.kind === kind),
  );
  const [match] = matches;
  if (!match) throw new LibraryError(`No ${kind ?? "library"} entry with id "${id}"`);
  if (matches.length > 1) {
    throw new LibraryError(`Both an sfx and a bgm entry have id "${id}"; give the kind`);
  }
  return match;
}

/** SHA-256 of a file, as lowercase hex. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Writes a file by renaming a temporary file over it, so readers never see half a file. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

/** Parses YAML text and validates it. `file` names the file in issues. */
export function parseYaml<S extends z.ZodType>(
  text: string,
  file: string,
  schema: S,
): { data?: z.infer<S>; issues: LibraryIssue[] } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return { issues: doc.errors.map((e) => error(file, `Invalid YAML: ${e.message}`)) };
  }
  let value: unknown;
  try {
    value = doc.toJS();
  } catch (e) {
    return { issues: [error(file, `Invalid YAML: ${e instanceof Error ? e.message : e}`)] };
  }
  const result = schema.safeParse(value);
  if (result.success) return { data: result.data, issues: [] };
  return {
    issues: result.error.issues.map((i) => {
      const path = i.path.map(String).join(".");
      return error(file, path ? `${path}: ${i.message}` : i.message);
    }),
  };
}

export function error(file: string, message: string): LibraryIssue {
  return { file, message, severity: "error" };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if (isErrno(e, "ENOENT")) return undefined;
    throw e;
  }
}

// A problem with the folder of a kind, such as sfx/, or undefined if it is a plain folder
// or does not exist.
async function inspectKindDir(root: string, kind: LibraryKind): Promise<string | undefined> {
  try {
    await assertManagedDir(root, kind);
    return undefined;
  } catch (e) {
    if (e instanceof LibraryError) return e.message;
    throw e;
  }
}

// Entry folders of one kind, and symbolic links where an entry folder would be. Dot
// folders are skipped: imports stage entries in them.
async function listEntryDirs(
  root: string,
  kind: LibraryKind,
): Promise<{ dirs: string[]; links: string[] }> {
  try {
    const dirents = (await readdir(join(root, kind), { withFileTypes: true }))
      .filter((d) => !d.name.startsWith("."))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      dirs: dirents.filter((d) => d.isDirectory()).map((d) => d.name),
      links: dirents.filter((d) => d.isSymbolicLink()).map((d) => d.name),
    };
  } catch (e) {
    if (isErrno(e, "ENOENT")) return { dirs: [], links: [] };
    throw e;
  }
}

/** State of a managed path. See `inspectManagedPath`. */
export type ManagedPathState =
  | { status: "file" }
  | { status: "missing" }
  | { status: "not-file" }
  | { status: "symlink"; at: string }
  | { status: "outside" };

/**
 * Inspects `rel`, a "/"-separated path inside the library, without following symbolic
 * links. A link at the path or at any parent folder below the root is reported as
 * `symlink`, with the library-relative path of the link. As a second line of defense, a
 * regular file whose resolved path is not inside the resolved root is `outside`.
 */
export async function inspectManagedPath(root: string, rel: string): Promise<ManagedPathState> {
  const segments = rel.split("/");
  for (let i = 1; i <= segments.length; i++) {
    let info: Stats;
    try {
      info = await lstat(join(root, ...segments.slice(0, i)));
    } catch (e) {
      if (isErrno(e, "ENOENT") || isErrno(e, "ENOTDIR")) return { status: "missing" };
      throw e;
    }
    if (info.isSymbolicLink()) return { status: "symlink", at: segments.slice(0, i).join("/") };
    if (i === segments.length && !info.isFile()) return { status: "not-file" };
  }
  return (await isInside(root, join(root, ...segments)))
    ? { status: "file" }
    : { status: "outside" };
}

/**
 * Throws a `LibraryError` if a folder of `rel` that exists is a symbolic link, or resolves
 * outside the root. Folders that do not exist yet are fine; the caller creates them.
 */
export async function assertManagedDir(root: string, rel: string): Promise<void> {
  const segments = rel.split("/");
  for (let i = 1; i <= segments.length; i++) {
    const at = segments.slice(0, i).join("/");
    let info: Stats;
    try {
      info = await lstat(join(root, ...segments.slice(0, i)));
    } catch (e) {
      if (isErrno(e, "ENOENT")) return;
      throw e;
    }
    if (info.isSymbolicLink()) {
      throw new LibraryError(`${at} is a symbolic link; the library does not follow links`);
    }
    if (!info.isDirectory()) throw new LibraryError(`${at} is not a folder`);
    if (!(await isInside(root, join(root, ...segments.slice(0, i))))) {
      throw new LibraryError(`${at} resolves outside the library`);
    }
  }
}

async function isInside(root: string, path: string): Promise<boolean> {
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  return realPath.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}

/** True if something, even a dangling symbolic link, exists at `path`. */
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (isErrno(e, "ENOENT")) return false;
    throw e;
  }
}

export function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === code;
}

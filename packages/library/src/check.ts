import {
  error,
  hashManaged,
  inspectManagedPath,
  type Library,
  type LibraryEntry,
  LibraryError,
  type LibraryIssue,
  pathProblem,
  readLibrary,
} from "./library.js";
import { ENTRY_FILE, EVIDENCE_PATH, hasText, lookupLicense } from "./schema.js";

/**
 * Checks the library at `root`: every file matches its hash, every license ID is in the
 * registry, attribution text is present when the license requires it, downloaded entries
 * have evidence that matches its content hash, no managed path is a symbolic link, and no
 * ID is duplicated. Also returns the issues of reading the library, including an invalid or
 * unreadable library.yaml. Rejects only when `root` has no library.yaml at all.
 */
export async function checkLibrary(root: string): Promise<LibraryIssue[]> {
  let library: Library;
  try {
    library = await readLibrary(root);
  } catch (e) {
    if (e instanceof LibraryError && e.issues.length > 0) return e.issues;
    throw e;
  }
  const issues = [...library.issues];
  for (const entry of library.entries) issues.push(...(await checkEntry(library, entry)));
  return issues;
}

/** Checks one entry. See `checkLibrary`. */
export async function checkEntry(library: Library, item: LibraryEntry): Promise<LibraryIssue[]> {
  const { entry, dir } = item;
  const issues: LibraryIssue[] = [];
  const fail = (message: string) =>
    issues.push({ ...error(`${dir}/${ENTRY_FILE}`, message), entryId: entry.id });

  const file = `${dir}/${entry.file}`;
  const sound = await inspectManagedPath(library.root, file);
  if (sound.status === "file") {
    const actual = await hashOrFail(library.root, file, fail);
    if (actual !== undefined && actual !== entry.sha256) {
      fail(`${file} does not match its sha256: expected ${entry.sha256}, found ${actual}`);
    }
  } else {
    fail(pathProblem("Sound file", file, sound));
  }

  const terms = lookupLicense(library.licenses, entry.license.id);
  if (!terms) {
    fail(`License "${entry.license.id}" is not in licenses.yaml`);
  } else if (terms.attribution === "required" && !hasText(entry.license.attribution)) {
    fail(`License "${entry.license.id}" requires attribution, but license.attribution is empty`);
  }

  const evidence = entry.license.evidence;
  if (entry.source.type === "downloaded" && !evidence) {
    fail("Downloaded entry has no license.evidence");
  }
  if (evidence) {
    const state = await inspectManagedPath(library.root, evidence);
    if (state.status !== "file") {
      fail(pathProblem("Evidence file", evidence, state));
    } else {
      const expected = EVIDENCE_PATH.exec(evidence)?.[1];
      const actual = await hashOrFail(library.root, evidence, fail);
      if (actual !== undefined && actual !== expected) {
        fail(`Evidence file ${evidence} does not match the hash in its name: found ${actual}`);
      }
    }
  }
  return issues;
}

// `hashManaged`, with a failure reported through `fail` instead of thrown.
async function hashOrFail(
  root: string,
  rel: string,
  fail: (message: string) => void,
): Promise<string | undefined> {
  try {
    return await hashManaged(root, rel);
  } catch (e) {
    if (!(e instanceof LibraryError)) throw e;
    fail(e.message);
    return undefined;
  }
}

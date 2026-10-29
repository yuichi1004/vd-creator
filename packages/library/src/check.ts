import { join } from "node:path";
import {
  error,
  exists,
  hashFile,
  isErrno,
  type Library,
  type LibraryEntry,
  type LibraryIssue,
  readLibrary,
} from "./library.js";
import { ENTRY_FILE } from "./schema.js";

/**
 * Checks the library at `root`: every file matches its hash, every license ID is in the
 * registry, attribution text is present when the license requires it, downloaded entries
 * have evidence, and no ID is duplicated. Also returns the issues of reading the library.
 */
export async function checkLibrary(root: string): Promise<LibraryIssue[]> {
  const library = await readLibrary(root);
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
  try {
    const actual = await hashFile(join(library.root, dir, entry.file));
    if (actual !== entry.sha256) {
      fail(`${file} does not match its sha256: expected ${entry.sha256}, found ${actual}`);
    }
  } catch (e) {
    if (!isErrno(e, "ENOENT")) throw e;
    fail(`Sound file ${file} not found`);
  }

  const terms = library.licenses[entry.license.id];
  if (!terms) {
    fail(`License "${entry.license.id}" is not in licenses.yaml`);
  } else if (terms.attribution === "required" && !entry.license.attribution) {
    fail(`License "${entry.license.id}" requires attribution, but license.attribution is empty`);
  }

  if (entry.source.type === "downloaded") {
    const evidence = entry.license.evidence;
    if (!evidence) {
      fail("Downloaded entry has no license.evidence");
    } else if (!(await exists(join(library.root, evidence)))) {
      fail(`Evidence file ${evidence} not found`);
    }
  }
  return issues;
}

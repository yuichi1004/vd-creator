// `vd library status` and `vd library sync`: compare a project's library copies with the
// library, and update them on request. See docs/plans/0007-sound-library.md.

import {
  type CreditEntry,
  checkEntry,
  findEntry,
  type Library,
  LibraryError,
  toCreditEntry,
} from "@vd-creator/library";
import { canonicalJson } from "../canonical.js";
import { copyLibraryEntry, type LibraryRef, readCredits } from "./project.js";

/**
 * How a project's copy of an entry compares with the library:
 * - "current": the same sound and records.
 * - "sound-changed": the library has another sound file under the same ID.
 * - "record-changed": the same sound, but the entry or its license terms changed.
 * - "missing": the library has no such entry, or it cannot be looked up.
 */
export type LibraryCopyState = "current" | "sound-changed" | "record-changed" | "missing";

export type LibraryCopyStatus = LibraryRef & {
  state: LibraryCopyState;
  /** Why the entry is missing. */
  message?: string;
};

/** Compares each entry in the project's credits.json with the library. */
export async function libraryStatus(
  projectDir: string,
  library: Library,
): Promise<LibraryCopyStatus[]> {
  const credits = await readCredits(projectDir);
  return credits.entries.map((credit) => compare(credit, library));
}

function compare(credit: CreditEntry, library: Library): LibraryCopyStatus {
  const ref = { kind: credit.kind, id: credit.id };
  let fresh: CreditEntry;
  try {
    fresh = toCreditEntry(
      findEntry(library, credit.id, credit.kind),
      library.licenses,
      credit.file,
    );
  } catch (e) {
    if (!(e instanceof LibraryError)) throw e;
    return { ...ref, state: "missing", message: e.message };
  }
  if (fresh.sha256 !== credit.sha256) return { ...ref, state: "sound-changed" };
  if (canonicalJson(fresh) !== canonicalJson(credit)) return { ...ref, state: "record-changed" };
  return { ...ref, state: "current" };
}

export type LibrarySyncResult = LibraryRef & {
  state: LibraryCopyState;
  /** The copy and its credit were updated. */
  updated: boolean;
  /** Why an entry was not updated. */
  message?: string;
};

/**
 * Updates the project's copies of the entries that changed in the library, as reported by
 * `libraryStatus`. A changed sound is copied to its new file; the old copy stays, so earlier
 * renders keep working. An entry that is missing or fails its checks is left as it is.
 */
export async function syncLibrary(
  projectDir: string,
  library: Library,
): Promise<LibrarySyncResult[]> {
  const results: LibrarySyncResult[] = [];
  for (const status of await libraryStatus(projectDir, library)) {
    if (status.state === "current" || status.state === "missing") {
      results.push({ ...status, updated: false });
      continue;
    }
    const item = findEntry(library, status.id, status.kind);
    const errors = (await checkEntry(library, item)).filter((i) => i.severity === "error");
    if (errors.length > 0) {
      results.push({
        ...status,
        updated: false,
        message: errors.map((i) => i.message).join("; "),
      });
      continue;
    }
    try {
      await copyLibraryEntry(projectDir, library, item);
      results.push({ ...status, updated: true });
    } catch (e) {
      if (!(e instanceof LibraryError)) throw e;
      results.push({ ...status, updated: false, message: e.message });
    }
  }
  return results;
}

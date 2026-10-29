// The project license check of `vd validate`. See "License checks" in
// docs/plans/0007-sound-library.md.

import {
  type CreditEntry,
  checkProjectLicenses,
  findEntry,
  type Library,
  LibraryError,
  type LibraryKind,
  readLibrary,
  toCreditEntry,
} from "@vd-creator/library";
import type { Scenario } from "@vd-creator/scenario";
import {
  findCredit,
  LIBRARY_ASSET_DIR,
  libraryRefs,
  ProjectCreditsError,
  readCredits,
  refLabel,
} from "./project.js";
import { NO_LIBRARY } from "./resolver.js";

/** A license or library problem of a project. Messages hold no absolute paths. */
export type ProjectLicenseIssue = {
  /** The library entry or provider concerned, if any. */
  target?: { type: "entry"; kind: LibraryKind; id: string } | { type: "provider"; id: string };
  message: string;
  severity: "error" | "warning";
};

/**
 * Checks the library sounds and generation providers of a project against its publish.use.
 * An entry the project has copied is checked from its credit in credits.json. An entry not
 * copied yet is checked from the library, with a warning to copy it. Without a library its
 * license is unknown, so it is treated like an unverified entry: a warning for private use
 * and an error otherwise. Providers are checked as recorded in credits.json.
 */
export async function checkLibraryLicenses(
  projectDir: string,
  scenario: Scenario,
  options: { library?: string } = {},
): Promise<ProjectLicenseIssue[]> {
  const issues: ProjectLicenseIssue[] = [];
  let credits: Awaited<ReturnType<typeof readCredits>>;
  try {
    credits = await readCredits(projectDir);
  } catch (e) {
    if (!(e instanceof ProjectCreditsError)) throw e;
    return [{ message: e.message, severity: "error" }];
  }

  let library: Promise<Library> | undefined;
  const entries: CreditEntry[] = [];
  for (const ref of libraryRefs(scenario)) {
    const target = { type: "entry" as const, ...ref };
    const credit = findCredit(credits, ref);
    if (credit) {
      entries.push(credit);
      continue;
    }
    if (options.library === undefined) {
      issues.push({
        target,
        message: `The scenario uses ${refLabel(ref)}, which the project has not copied. ${NO_LIBRARY}`,
        severity: scenario.publish.use === "private" ? "warning" : "error",
      });
      continue;
    }
    try {
      library ??= readLibrary(options.library);
      const lib = await library;
      const item = findEntry(lib, ref.id, ref.kind);
      // Not copied yet, so the file name is only a placeholder for the check.
      entries.push(toCreditEntry(item, lib.licenses, `${LIBRARY_ASSET_DIR}/pending`));
      issues.push({
        target,
        message: `${refLabel(ref)} is not copied into the project yet; run vd generate`,
        severity: "warning",
      });
    } catch (e) {
      if (!(e instanceof LibraryError)) throw e;
      issues.push({ target, message: e.message, severity: "error" });
    }
  }

  for (const issue of checkProjectLicenses(
    { version: 1, entries, providers: credits.providers },
    scenario.publish.use,
  )) {
    issues.push({
      target:
        issue.target === "entry" && issue.kind
          ? { type: "entry", kind: issue.kind, id: issue.id }
          : { type: "provider", id: issue.id },
      message: issue.message,
      severity: issue.severity,
    });
  }
  return issues;
}

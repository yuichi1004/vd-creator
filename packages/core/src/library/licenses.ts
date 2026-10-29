// The project license check of `vd validate`. See "License checks" in
// docs/plans/0007-sound-library.md.

import {
  CREDITS_FILE,
  type CreditEntry,
  checkProjectLicenses,
  findEntry,
  type Library,
  LibraryError,
  type LibraryKind,
  readLibrary,
  toCreditEntry,
  toCreditProvider,
} from "@vd-creator/library";
import type { Scenario } from "@vd-creator/scenario";
import { AssetCache, CACHE_FILE } from "../cache.js";
import {
  findCredit,
  LIBRARY_ASSET_DIR,
  libraryRefs,
  ProjectCreditsError,
  type ProviderUse,
  playedProviders,
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
 * and an error otherwise. Providers are checked as recorded in credits.json; a provider of an
 * asset the scenario plays that credits.json lacks is checked with unknown terms, with a warning.
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
  // Entries checked from their credit, whose record may be older than the library's.
  const copied = new Set<string>();
  for (const ref of libraryRefs(scenario)) {
    const target = { type: "entry" as const, ...ref };
    const credit = findCredit(credits, ref);
    if (credit) {
      entries.push(credit);
      copied.add(refLabel(ref));
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

  // A provider whose assets the scenario plays but credits.json lacks, such as one cached
  // before providers were recorded, is checked with unknown terms.
  const providers = [...credits.providers];
  let played: ProviderUse[] = [];
  let cache: AssetCache | undefined;
  try {
    cache = await AssetCache.load(projectDir);
  } catch {
    issues.push({
      message: `Cannot read ${CACHE_FILE}, so the providers of generated assets are not checked`,
      severity: "error",
    });
  }
  try {
    if (cache) played = await playedProviders(scenario, cache);
  } catch {
    issues.push({
      message: `Cannot find the providers of the generated assets that the scenario plays, so they are not checked`,
      severity: "error",
    });
  }
  for (const { providerId } of played) {
    if (!providers.some((p) => p.id === providerId)) {
      providers.push(toCreditProvider(providerId, {}));
      issues.push({
        target: { type: "provider", id: providerId },
        message: `Provider "${providerId}" made assets that the scenario plays, but ${CREDITS_FILE} has no record of it, so its terms count as unknown`,
        severity: "warning",
      });
    }
  }

  for (const issue of checkProjectLicenses(
    { version: 1, entries, providers },
    scenario.publish.use,
  )) {
    const isCopied =
      issue.target === "entry" &&
      issue.kind !== undefined &&
      copied.has(refLabel({ kind: issue.kind, id: issue.id }));
    issues.push({
      target:
        issue.target === "entry" && issue.kind
          ? { type: "entry", kind: issue.kind, id: issue.id }
          : { type: "provider", id: issue.id },
      message: isCopied ? `${issue.message}; ${STALE_CREDIT_HINT}` : issue.message,
      severity: issue.severity,
    });
  }
  return issues;
}

/**
 * Added to a license issue of a copied entry. The check uses the project's credit, which
 * stays as it was copied, so a fix made in the library later shows only after a sync.
 */
export const STALE_CREDIT_HINT =
  "the project's copy is checked as recorded in credits.json; if the library entry was fixed since, run vd library status and vd library sync";

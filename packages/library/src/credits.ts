import { AssetPathSchema, IdSchema, type PublishUse } from "@vd-creator/scenario";
import { z } from "zod";
import type { LibraryEntry } from "./library.js";
import {
  AttributionTextSchema,
  hasText,
  LIBRARY_KINDS,
  type LibraryKind,
  LicenseIdSchema,
  LicenseRecordSchema,
  type LicenseRegistry,
  type LicenseTerms,
  LicenseTermsSchema,
  lookupLicense,
  PROVIDER_LICENSE_PREFIX,
  SourceSchema,
} from "./schema.js";

/** File name of the credits record, at the project root. */
export const CREDITS_FILE = "credits.json";

/**
 * A library entry used by a project, with copies of its license record and of the
 * registry terms at the time it was copied, so that checks work without the library.
 * Missing `terms` means the license was not in the registry; every term counts as unknown.
 */
export const CreditEntrySchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(LIBRARY_KINDS),
  title: z.string().min(1),
  file: AssetPathSchema.describe("Copy in the project, relative to assets/."),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: SourceSchema,
  license: LicenseRecordSchema,
  terms: LicenseTermsSchema.optional(),
});

/**
 * The license of a generation provider: the registry license `generated-<providerId>`.
 * A provider has no entry.yaml, so the human-made choices that an entry records in its
 * license record (the credit line and a commercial approval) are written on that registry
 * record as `attributionText` and `approvedFor`, and copied here. `terms` is missing when
 * the registry has no such license; every term then counts as unknown, and nothing can be
 * approved until the user records the terms.
 */
export const CreditProviderLicenseSchema = z.strictObject({
  id: LicenseIdSchema,
  terms: LicenseTermsSchema.optional(),
  attribution: AttributionTextSchema.optional(),
  approvedFor: z.literal("commercial").optional(),
});

/** A generation provider used by a project. */
export const CreditProviderSchema = z.strictObject({
  id: z.string().min(1).describe("Provider ID, such as elevenlabs."),
  name: z.string().min(1).optional().describe("Name shown in credits. Defaults to the ID."),
  kinds: z.array(z.enum(["voice", "sfx", "bgm"])).default([]),
  license: CreditProviderLicenseSchema.optional(),
});

/** The mock provider makes test tones, so it is exempt from license checks. */
export const MOCK_PROVIDER_ID = "mock";

/** The registry license ID of a provider, such as generated-elevenlabs. */
export function providerLicenseId(providerId: string): string {
  return `${PROVIDER_LICENSE_PREFIX}${providerId}`;
}

/**
 * Schema of a project's credits.json. A provider's license must be its own
 * `generated-<providerId>` license, so that one provider cannot borrow another license's
 * terms. The mock provider is exempt.
 */
export const CreditsSchema = z
  .strictObject({
    version: z.literal(1),
    entries: z.array(CreditEntrySchema).default([]),
    providers: z.array(CreditProviderSchema).default([]),
  })
  .superRefine((credits, ctx) => {
    credits.providers.forEach((provider, index) => {
      const message = providerLicenseMismatch(provider);
      if (message)
        ctx.addIssue({ code: "custom", path: ["providers", index, "license", "id"], message });
    });
  });

export type CreditEntry = z.infer<typeof CreditEntrySchema>;
export type CreditProviderLicense = z.infer<typeof CreditProviderLicenseSchema>;
export type CreditProvider = z.infer<typeof CreditProviderSchema>;
export type Credits = z.infer<typeof CreditsSchema>;

/** Builds the credits record of a library entry copied to `file` in a project. */
export function toCreditEntry(
  item: LibraryEntry,
  licenses: LicenseRegistry,
  file: string,
): CreditEntry {
  const { entry } = item;
  const terms = lookupLicense(licenses, entry.license.id);
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    file,
    sha256: entry.sha256,
    source: entry.source,
    license: entry.license,
    ...(terms ? { terms } : {}),
  };
}

/** Builds the credits record of a provider, with its `generated-<providerId>` license. */
export function toCreditProvider(
  providerId: string,
  licenses: LicenseRegistry,
  options: { name?: string; kinds?: CreditProvider["kinds"] } = {},
): CreditProvider {
  const licenseId = providerLicenseId(providerId);
  const terms = lookupLicense(licenses, licenseId);
  const license: CreditProviderLicense = { id: licenseId };
  if (terms) {
    license.terms = terms;
    if (terms.attributionText !== undefined) license.attribution = terms.attributionText;
    if (terms.approvedFor !== undefined) license.approvedFor = terms.approvedFor;
  }
  return {
    id: providerId,
    ...(options.name !== undefined ? { name: options.name } : {}),
    kinds: options.kinds ?? [],
    license,
  };
}

export type LicenseCheckCode =
  | "license-mismatch"
  | "unverified"
  | "commercial-forbidden"
  | "commercial-conditional"
  | "attribution-missing";

/**
 * A license problem of a library entry or a generation provider used by a project. `kind`
 * is set for entries.
 */
export type LicenseCheckIssue = {
  target: "entry" | "provider";
  id: string;
  kind?: LibraryKind;
  code: LicenseCheckCode;
  message: string;
  severity: "error" | "warning";
};

type Outcome = "ok" | "warning" | "error";

// The check table of plan 0007, by situation and publish.use.
const CHECK_TABLE: Record<LicenseCheckCode, Record<PublishUse, Outcome>> = {
  // Not in the plan's table: a provider credit with another license is always an error.
  "license-mismatch": { private: "error", "non-commercial": "error", commercial: "error" },
  unverified: { private: "warning", "non-commercial": "error", commercial: "error" },
  "commercial-forbidden": { private: "ok", "non-commercial": "ok", commercial: "error" },
  // A commercial error here is lifted by approvedFor: commercial, set by a human.
  "commercial-conditional": { private: "ok", "non-commercial": "warning", commercial: "error" },
  // Also applies when the attribution term is unknown, or the terms are missing.
  "attribution-missing": { private: "warning", "non-commercial": "error", commercial: "error" },
};

/**
 * Checks the library entries and generation providers of a project against its intended
 * use, following the check table of plan 0007. Missing terms count as unknown on every
 * term. The not-verified row applies only to entries, since a provider's license is
 * written by a human, and the mock provider is exempt. Warnings do not block a render;
 * errors do, and no flag overrides them.
 */
export function checkProjectLicenses(credits: Credits, use: PublishUse): LicenseCheckIssue[] {
  const issues: LicenseCheckIssue[] = [];
  for (const entry of credits.entries) {
    const { license, terms } = entry;
    const subject = `Library entry "${entry.id}"`;
    const report = reporter(issues, use, { target: "entry", id: entry.id, kind: entry.kind });
    if (!license.verified) report("unverified", `${subject} has an unverified license record`);
    checkTerms(report, use, subject, license.id, terms, {
      attribution: license.attribution,
      approved: license.approvedFor === "commercial",
    });
  }
  for (const provider of credits.providers) {
    if (provider.id === MOCK_PROVIDER_ID) continue;
    const license = provider.license ?? { id: providerLicenseId(provider.id) };
    const report = reporter(issues, use, { target: "provider", id: provider.id });
    // Checked again here, for credits that did not go through CreditsSchema.
    const mismatch = providerLicenseMismatch(provider);
    if (mismatch) {
      report("license-mismatch", mismatch);
      continue;
    }
    checkTerms(report, use, `Provider "${provider.id}"`, license.id, license.terms, {
      attribution: license.attribution,
      // With no terms there is nothing to approve.
      approved: license.terms !== undefined && license.approvedFor === "commercial",
    });
  }
  return issues;
}

// A message if `provider` has a license other than its own generated-<providerId>.
function providerLicenseMismatch(provider: CreditProvider): string | undefined {
  if (provider.id === MOCK_PROVIDER_ID || provider.license === undefined) return undefined;
  const expected = providerLicenseId(provider.id);
  if (provider.license.id === expected) return undefined;
  return `Provider "${provider.id}" has license ${provider.license.id}; it must be ${expected}`;
}

type Report = (code: LicenseCheckCode, message: string, outcome?: Outcome) => void;

function reporter(
  issues: LicenseCheckIssue[],
  use: PublishUse,
  target: Pick<LicenseCheckIssue, "target" | "id" | "kind">,
): Report {
  return (code, message, outcome = CHECK_TABLE[code][use]) => {
    if (outcome === "ok") return;
    issues.push({ ...target, code, message, severity: outcome });
  };
}

// The commercialUse and attribution rows of the table.
function checkTerms(
  report: Report,
  use: PublishUse,
  subject: string,
  licenseId: string,
  terms: LicenseTerms | undefined,
  record: { attribution?: string; approved: boolean },
): void {
  const licenseName = terms ? `license ${licenseId}` : `license ${licenseId} (not in the registry)`;
  const commercialUse = terms?.commercialUse ?? "unknown";
  if (commercialUse === "forbidden") {
    report("commercial-forbidden", `${subject} uses ${licenseName}, which forbids commercial use`);
  } else if (commercialUse === "conditional" || commercialUse === "unknown") {
    report(
      "commercial-conditional",
      `${subject} uses ${licenseName}, whose commercial use is ${commercialUse}` +
        (use === "commercial" ? "; a human must approve it for commercial use" : ""),
      use === "commercial" && record.approved ? "ok" : undefined,
    );
  }
  const attribution = terms?.attribution ?? "unknown";
  if ((attribution === "required" || attribution === "unknown") && !hasText(record.attribution)) {
    report(
      "attribution-missing",
      attribution === "required"
        ? `${subject} uses ${licenseName}, which requires attribution, but has none`
        : `${subject} uses ${licenseName}, whose attribution term is unknown, and has no attribution`,
    );
  }
}

/**
 * Default credits template. `{{attributions}}` expands to one line per entry or provider
 * with attribution text, and `{{providers}}` to the generation providers, comma-separated.
 */
export const DEFAULT_CREDITS_TEMPLATE =
  "Sounds:\n{{attributions}}\n\nGenerated with: {{providers}}\n";

/**
 * Builds the text of out/credits.txt from a template. A line whose placeholders all expand
 * to nothing is dropped, and so is a heading-only section left without lines, so that an
 * empty list leaves no stray labels. Attribution lines come from every entry, then every
 * provider, whose license requires or appreciates attribution (or leaves it unknown) and
 * that has the text.
 */
export function buildCreditsText(
  credits: Credits,
  template: string = DEFAULT_CREDITS_TEMPLATE,
): string {
  const credit = (text: string | undefined, terms: LicenseTerms | undefined) =>
    hasText(text) && terms?.attribution !== "none" ? [text.trim()] : [];
  const attributions = unique([
    ...credits.entries.flatMap((e) => credit(e.license.attribution, e.terms)),
    ...credits.providers.flatMap((p) => credit(p.license?.attribution, p.license?.terms)),
  ]);
  const providers = unique(credits.providers.map((p) => p.name ?? p.id));
  const values = new Map([
    ["attributions", attributions],
    ["providers", providers],
  ]);
  const valuesOf = (name: string) => values.get(name) ?? [];

  const lines: string[] = [];
  for (const line of template.replace(/\r\n/g, "\n").split("\n")) {
    const names = [...line.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? "");
    if (names.length === 0) {
      lines.push(line);
      continue;
    }
    if (names.every((n) => valuesOf(n).length === 0)) {
      // Drop a heading such as "Sounds:" that this empty line was meant to follow.
      if (lines.length > 0 && lines.at(-1)?.trim().endsWith(":")) lines.pop();
      continue;
    }
    // A placeholder alone on its line gives one line per value; inline ones join with ", ".
    const alone = names.length === 1 && line.trim() === `{{${names[0]}}}`;
    if (alone) lines.push(...valuesOf(names[0] ?? ""));
    else lines.push(line.replace(/\{\{(\w+)\}\}/g, (_, n: string) => valuesOf(n).join(", ")));
  }
  const text = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length === 0 ? "" : `${text}\n`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

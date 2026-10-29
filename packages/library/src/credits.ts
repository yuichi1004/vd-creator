import { IdSchema, type PublishUse } from "@vd-creator/scenario";
import { z } from "zod";
import type { LibraryEntry } from "./library.js";
import {
  LIBRARY_KINDS,
  type LibraryKind,
  LicenseRecordSchema,
  type LicenseRegistry,
  LicenseTermsSchema,
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
  file: z.string().min(1).describe("Copy in the project, relative to assets/."),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: SourceSchema,
  license: LicenseRecordSchema,
  terms: LicenseTermsSchema.optional(),
});

/** A generation provider used by a project. */
export const CreditProviderSchema = z.strictObject({
  id: z.string().min(1).describe("Provider ID, such as elevenlabs."),
  name: z.string().min(1).optional().describe("Name shown in credits. Defaults to the ID."),
  kinds: z.array(z.enum(["voice", "sfx", "bgm"])).default([]),
});

/** Schema of a project's credits.json. */
export const CreditsSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(CreditEntrySchema).default([]),
  providers: z.array(CreditProviderSchema).default([]),
});

export type CreditEntry = z.infer<typeof CreditEntrySchema>;
export type CreditProvider = z.infer<typeof CreditProviderSchema>;
export type Credits = z.infer<typeof CreditsSchema>;

/** Builds the credits record of a library entry copied to `file` in a project. */
export function toCreditEntry(
  item: LibraryEntry,
  licenses: LicenseRegistry,
  file: string,
): CreditEntry {
  const { entry } = item;
  const terms = licenses[entry.license.id];
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

export type LicenseCheckCode =
  | "unverified"
  | "commercial-forbidden"
  | "commercial-conditional"
  | "attribution-missing";

/** A license problem of one entry used by a project. */
export type LicenseCheckIssue = {
  entryId: string;
  kind: LibraryKind;
  code: LicenseCheckCode;
  message: string;
  severity: "error" | "warning";
};

type Outcome = "ok" | "warning" | "error";

// The check table of plan 0007, by situation and publish.use.
const CHECK_TABLE: Record<LicenseCheckCode, Record<PublishUse, Outcome>> = {
  unverified: { private: "warning", "non-commercial": "error", commercial: "error" },
  "commercial-forbidden": { private: "ok", "non-commercial": "ok", commercial: "error" },
  // A commercial error here is lifted by license.approvedFor: commercial.
  "commercial-conditional": { private: "ok", "non-commercial": "warning", commercial: "error" },
  "attribution-missing": { private: "warning", "non-commercial": "error", commercial: "error" },
};

/**
 * Checks the library entries of a project against its intended use, following the check
 * table of plan 0007. Warnings do not block a render; errors do, and no flag overrides them.
 */
export function checkProjectLicenses(credits: Credits, use: PublishUse): LicenseCheckIssue[] {
  const issues: LicenseCheckIssue[] = [];
  for (const entry of credits.entries) {
    const { license, terms } = entry;
    const licenseName = terms ? `license ${license.id}` : `license ${license.id} (terms unknown)`;
    const report = (code: LicenseCheckCode, message: string, outcome = CHECK_TABLE[code][use]) => {
      if (outcome === "ok") return;
      issues.push({ entryId: entry.id, kind: entry.kind, code, message, severity: outcome });
    };

    if (!license.verified) {
      report("unverified", `Library entry "${entry.id}" has an unverified license record`);
    }
    const commercialUse = terms?.commercialUse ?? "unknown";
    if (commercialUse === "forbidden") {
      report(
        "commercial-forbidden",
        `Library entry "${entry.id}" uses ${licenseName}, which forbids commercial use`,
      );
    } else if (commercialUse === "conditional" || commercialUse === "unknown") {
      const approved = use === "commercial" && license.approvedFor === "commercial";
      report(
        "commercial-conditional",
        `Library entry "${entry.id}" uses ${licenseName}, whose commercial use is ${commercialUse}` +
          (use === "commercial" ? "; a human must approve it for commercial use" : ""),
        approved ? "ok" : undefined,
      );
    }
    if (terms?.attribution === "required" && !license.attribution) {
      report(
        "attribution-missing",
        `Library entry "${entry.id}" uses ${licenseName}, which requires attribution, but has none`,
      );
    }
  }
  return issues;
}

/**
 * Default credits template. `{{attributions}}` expands to one line per entry with
 * attribution text, and `{{providers}}` to the generation providers, comma-separated.
 */
export const DEFAULT_CREDITS_TEMPLATE =
  "Sounds:\n{{attributions}}\n\nGenerated with: {{providers}}\n";

/**
 * Builds the text of out/credits.txt from a template. A line whose placeholders all expand
 * to nothing is dropped, and so is a heading-only section left without lines, so that an
 * empty list leaves no stray labels. Attribution lines come from every entry whose license
 * requires or appreciates attribution (or leaves it unknown) and that has the text.
 */
export function buildCreditsText(
  credits: Credits,
  template: string = DEFAULT_CREDITS_TEMPLATE,
): string {
  const attributions = unique(
    credits.entries.flatMap((e) =>
      e.license.attribution && e.terms?.attribution !== "none" ? [e.license.attribution] : [],
    ),
  );
  const providers = unique(credits.providers.map((p) => p.name ?? p.id));
  const values: Record<string, string[]> = { attributions, providers };

  const lines: string[] = [];
  for (const line of template.replace(/\r\n/g, "\n").split("\n")) {
    const names = [...line.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? "");
    if (names.length === 0) {
      lines.push(line);
      continue;
    }
    if (names.every((n) => (values[n] ?? []).length === 0)) {
      // Drop a heading such as "Sounds:" that this empty line was meant to follow.
      if (lines.length > 0 && lines.at(-1)?.trim().endsWith(":")) lines.pop();
      continue;
    }
    // A placeholder alone on its line gives one line per value; inline ones join with ", ".
    const alone = names.length === 1 && line.trim() === `{{${names[0]}}}`;
    if (alone) lines.push(...(values[names[0] ?? ""] ?? []));
    else lines.push(line.replace(/\{\{(\w+)\}\}/g, (_, n: string) => (values[n] ?? []).join(", ")));
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

import { IdSchema } from "@vd-creator/scenario";
import { z } from "zod";

// File formats of the shared sound library. See docs/plans/0007-sound-library.md.
// Objects are strict, like scenario.yaml, so typos are errors. The generation request
// of a generated entry is the only free-form object.

export const LIBRARY_KINDS = ["sfx", "bgm"] as const;
export const SOURCE_TYPES = ["generated", "downloaded", "recorded", "other"] as const;
export const ATTRIBUTION_TERMS = ["none", "required", "appreciated", "unknown"] as const;
export const COMMERCIAL_USE_TERMS = ["allowed", "forbidden", "conditional", "unknown"] as const;
export const MODIFICATION_TERMS = ["allowed", "forbidden", "unknown"] as const;

/** File name of the library metadata, at the library root. */
export const LIBRARY_FILE = "library.yaml";
/** File name of the license registry, at the library root. */
export const LICENSES_FILE = "licenses.yaml";
/** File name of an entry's metadata, inside the entry folder. */
export const ENTRY_FILE = "entry.yaml";
/** Folder of license evidence, at the library root. */
export const EVIDENCE_DIR = "evidence";

// One path segment: no separators or drive colons, and not "." or "..".
const PATH_SEGMENT = String.raw`(?!\.\.?$)[^/\\:]+`;

export const LicenseIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "License ID must start with a letter or digit and contain only letters, digits, '.', '-', and '_'",
  )
  .describe("Key in licenses.yaml, such as CC-BY-4.0.");

const DateSchema = z.iso.date().describe("Date as YYYY-MM-DD.");

/** An absolute http or https URL. */
export const HttpUrlSchema = z
  .string()
  .refine(isHttpUrl, "URL must be an absolute http:// or https:// URL")
  .describe("Absolute http or https URL.");

/** Credit text: not blank after trimming. */
export const AttributionTextSchema = z
  .string()
  .refine(hasText, "Attribution must not be blank")
  .describe("Credit line, as shown in credits.txt.");

/** True if `value` is a string that is not blank after trimming. */
export function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    return new URL(value).hostname.length > 0;
  } catch {
    return false;
  }
}

export const LibraryMetaSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1),
});

export const LicenseTermsSchema = z.strictObject({
  name: z.string().min(1),
  url: HttpUrlSchema.optional(),
  attribution: z.enum(ATTRIBUTION_TERMS),
  commercialUse: z.enum(COMMERCIAL_USE_TERMS),
  conditions: z.string().min(1).optional(),
  modification: z.enum(MODIFICATION_TERMS),
  shareAlike: z.union([z.boolean(), z.literal("unknown")]),
  // Provider licenses only. A generated sound has no entry.yaml, so the human-made
  // choices that an entry records in its license record live on the registry record.
  attributionText: AttributionTextSchema.optional().describe(
    "generated-* licenses only: credit line for the provider's output.",
  ),
  approvedFor: z
    .literal("commercial")
    .optional()
    .describe("generated-* licenses only: a human approved the terms for commercial use."),
});

/** Prefix of the registry ID of a provider's license, as in generated-elevenlabs. */
export const PROVIDER_LICENSE_PREFIX = "generated-";

// Zod drops an own "__proto__" key from a record without an issue, so reject it first.
const NoProtoKeySchema = z
  .unknown()
  .refine(
    (value) => typeof value !== "object" || value === null || !Object.hasOwn(value, "__proto__"),
    { message: '"__proto__" is not a valid license ID', path: ["__proto__"] },
  );

export const LicenseRegistrySchema = NoProtoKeySchema.pipe(
  z.record(LicenseIdSchema, LicenseTermsSchema),
).superRefine((registry, ctx) => {
  for (const [id, terms] of Object.entries(registry)) {
    if (id.startsWith(PROVIDER_LICENSE_PREFIX)) continue;
    for (const key of ["attributionText", "approvedFor"] as const) {
      if (terms[key] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [id, key],
          message: `${key} is allowed only on ${PROVIDER_LICENSE_PREFIX}* licenses`,
        });
      }
    }
  }
});

export const GeneratedSourceSchema = z.strictObject({
  type: z.literal("generated"),
  provider: z.string().min(1).describe("Provider ID, such as elevenlabs."),
  request: z.record(z.string(), z.unknown()).describe("Generation request, as in cache.json."),
  generatedAt: z.string().min(1).optional(),
  project: z.string().min(1).optional().describe("Project the sound was promoted from."),
  item: IdSchema.optional().describe("Item ID in that project."),
});

export const ExternalSourceSchema = z.strictObject({
  type: z.enum(["downloaded", "recorded", "other"]),
  url: HttpUrlSchema.optional(),
  site: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  retrievedAt: DateSchema.optional(),
});

export const SourceSchema = z.discriminatedUnion("type", [
  GeneratedSourceSchema,
  ExternalSourceSchema,
]);

/** Matches an evidence path; group 1 is the SHA-256 of the file's content. */
export const EVIDENCE_PATH = new RegExp(`^${EVIDENCE_DIR}/([0-9a-f]{64})(?:\\.[a-z0-9]{1,10})?$`);

export const EvidencePathSchema = z
  .string()
  .regex(
    EVIDENCE_PATH,
    `Evidence must be ${EVIDENCE_DIR}/<sha256 of the content>, with an optional extension`,
  );

export const LicenseRecordSchema = z.strictObject({
  id: LicenseIdSchema,
  attribution: AttributionTextSchema.optional().describe(
    "Credit line. Required when the license requires attribution.",
  ),
  evidence: EvidencePathSchema.optional().describe("Copy of the terms as seen at retrievedAt."),
  verified: z.boolean().default(false).describe("A human confirmed this record."),
  verifiedAt: DateSchema.optional(),
  approvedFor: z
    .literal("commercial")
    .optional()
    .describe("A human approved conditional or unknown terms for commercial use."),
});

export const EntrySchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(LIBRARY_KINDS),
  title: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  file: z
    .string()
    .regex(new RegExp(`^${PATH_SEGMENT}$`), "File must be a file name inside the entry folder"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters"),
  durationSec: z.number().positive().optional(),
  loopable: z.boolean().optional(),
  source: SourceSchema,
  license: LicenseRecordSchema,
  notes: z.string().optional(),
  modified: z.boolean().default(false).describe("The file differs from the original download."),
});

/**
 * Looks up a license by ID. Only the registry's own keys count, so IDs such as
 * "constructor" or "toString" never resolve to inherited properties.
 */
export function lookupLicense(registry: LicenseRegistry, id: string): LicenseTerms | undefined {
  return Object.hasOwn(registry, id) ? registry[id] : undefined;
}

export type LibraryKind = (typeof LIBRARY_KINDS)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];
export type LibraryMeta = z.infer<typeof LibraryMetaSchema>;
export type LicenseTerms = z.infer<typeof LicenseTermsSchema>;
export type LicenseRegistry = z.infer<typeof LicenseRegistrySchema>;
export type Source = z.infer<typeof SourceSchema>;
export type LicenseRecord = z.infer<typeof LicenseRecordSchema>;
export type Entry = z.infer<typeof EntrySchema>;
export type EntryInput = z.input<typeof EntrySchema>;

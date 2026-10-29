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

export const LibraryMetaSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1),
});

export const LicenseTermsSchema = z.strictObject({
  name: z.string().min(1),
  url: z.string().min(1).optional(),
  attribution: z.enum(ATTRIBUTION_TERMS),
  commercialUse: z.enum(COMMERCIAL_USE_TERMS),
  conditions: z.string().min(1).optional(),
  modification: z.enum(MODIFICATION_TERMS),
  shareAlike: z.union([z.boolean(), z.literal("unknown")]),
});

export const LicenseRegistrySchema = z.record(LicenseIdSchema, LicenseTermsSchema);

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
  url: z.string().min(1).optional(),
  site: z.string().min(1).optional(),
  author: z.string().min(1).optional(),
  retrievedAt: DateSchema.optional(),
});

export const SourceSchema = z.discriminatedUnion("type", [
  GeneratedSourceSchema,
  ExternalSourceSchema,
]);

export const EvidencePathSchema = z
  .string()
  .regex(
    new RegExp(`^${EVIDENCE_DIR}/${PATH_SEGMENT}$`),
    `Evidence must be a file directly inside ${EVIDENCE_DIR}/`,
  );

export const LicenseRecordSchema = z.strictObject({
  id: LicenseIdSchema,
  attribution: z
    .string()
    .min(1)
    .optional()
    .describe("Credit line. Required when the license requires attribution."),
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

export type LibraryKind = (typeof LIBRARY_KINDS)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];
export type LibraryMeta = z.infer<typeof LibraryMetaSchema>;
export type LicenseTerms = z.infer<typeof LicenseTermsSchema>;
export type LicenseRegistry = z.infer<typeof LicenseRegistrySchema>;
export type Source = z.infer<typeof SourceSchema>;
export type LicenseRecord = z.infer<typeof LicenseRecordSchema>;
export type Entry = z.infer<typeof EntrySchema>;
export type EntryInput = z.input<typeof EntrySchema>;

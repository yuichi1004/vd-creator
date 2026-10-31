import { z } from "zod";

// Schema version 1 of scenario.yaml. See docs/plans/0003-scenario-format.md.
// Every object is strict, so unknown keys (usually typos) are errors. Provider-specific
// voice settings are the only free-form object, and their values must be plain JSON.

export const PUBLISH_USES = ["private", "non-commercial", "commercial"] as const;
export const ITEM_KINDS = ["line", "sfx", "pause", "image"] as const;

/** Default `gapBeforeSec` for lines. Other items default to 0. */
export const DEFAULT_LINE_GAP_SEC = 0.3;
/** Default BGM volume. */
export const DEFAULT_BGM_VOLUME = 0.3;

export const IdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "ID must start with a letter or digit and contain only letters, digits, '-', and '_'",
  )
  .describe("Stable short slug. Keep it unchanged when the text changes.");

const TakeSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Selected generation of the item. Regenerating increments it.");

const gapBeforeSec = (defaultSec: number) =>
  z
    .number()
    .min(-1)
    .default(defaultSec)
    .describe("Silence before the item in seconds. Negative values overlap the previous item.");

export const PublishSchema = z.strictObject({
  use: z
    .enum(PUBLISH_USES)
    .default("private")
    .describe("Intended use of the finished drama, checked against sound licenses."),
});

// Values must be plain JSON, which validateScenarioData checks on the parsed data: the
// record schema copies the mapping, so a check here would miss an alias to the mapping
// itself. json-schema.ts describes the values in the JSON Schema.
export const VoiceSettingsSchema = z
  .record(z.string(), z.unknown())
  .describe("Provider-specific settings, passed through as is. Any keys; plain JSON values.");

export const VoiceSchema = z.strictObject({
  provider: z
    .string()
    .min(1)
    .describe('Provider ID, such as "elevenlabs". "mock" is always available.'),
  voiceId: z.string().min(1).describe("Voice ID at the provider."),
  settings: VoiceSettingsSchema.optional(),
});

export const LineVoiceSchema = z
  .strictObject({
    settings: VoiceSettingsSchema.optional().describe(
      "Settings for this line only, merged over the speaker's voice.settings one key at a time.",
    ),
  })
  .describe("Voice overrides for this line.");

export const SpeakerSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  voice: VoiceSchema,
});

// One path segment: no separators or drive colons, and not "." or "..".
const PATH_SEGMENT = String.raw`(?!\.\.?(?:/|$))[^/\\:]+`;

/** A portable path inside assets/: relative, "/"-separated, and never leaving the folder. */
export const AssetPathSchema = z
  .string()
  .regex(
    new RegExp(`^${PATH_SEGMENT}(?:/${PATH_SEGMENT})*$`),
    "Path must be relative to assets/, use '/' as separator, and contain no '.', '..', ':', or empty segments",
  )
  .describe("File path relative to assets/, with '/' separators.");

export const ImageSchema = z.strictObject({
  id: IdSchema,
  file: AssetPathSchema.describe("Image file path, relative to assets/."),
});

export const LibraryRefSchema = z.strictObject({
  library: IdSchema.describe("Entry ID in the shared sound library."),
});

export const SfxSourceSchema = z
  .union([z.string().min(1).describe("Prompt for a generated sound."), LibraryRefSchema])
  .describe("A prompt string, or { library: <entry-id> } for a library sound.");

const bgmVolume = z.number().min(0).max(1).default(DEFAULT_BGM_VOLUME).describe("Volume, 0 to 1.");

export const BgmSchema = z
  .union([
    z.strictObject({
      prompt: z.string().min(1).describe("Prompt for generated music."),
      volume: bgmVolume,
    }),
    z.strictObject({
      library: IdSchema.describe("Entry ID in the shared sound library."),
      volume: bgmVolume,
    }),
  ])
  .describe("Music that loops under the whole scene. Exactly one of prompt or library.");

export const LineItemSchema = z.strictObject({
  line: z.string().min(1).describe("Spoken text."),
  id: IdSchema,
  speaker: IdSchema.describe("Speaker ID."),
  direction: z.string().optional().describe("Delivery hint for TTS and for humans."),
  voice: LineVoiceSchema.optional(),
  take: TakeSchema,
  gapBeforeSec: gapBeforeSec(DEFAULT_LINE_GAP_SEC),
});

export const SfxItemSchema = z.strictObject({
  sfx: SfxSourceSchema,
  id: IdSchema,
  durationSec: z.number().positive().optional().describe("Requested length in seconds."),
  overlap: z
    .boolean()
    .default(false)
    .describe("Play under the following items instead of before them."),
  take: TakeSchema,
  gapBeforeSec: gapBeforeSec(0),
});

export const PauseItemSchema = z.strictObject({
  pause: z.number().positive().describe("Silence in seconds."),
  id: IdSchema.optional(),
  gapBeforeSec: gapBeforeSec(0),
});

export const ImageItemSchema = z.strictObject({
  image: IdSchema.describe("Image ID. Shows from here until the next image."),
  id: IdSchema.optional(),
  gapBeforeSec: gapBeforeSec(0),
});

// The order matches ITEM_KINDS; validation relies on it to pick the branch to report.
export const ItemSchema = z
  .union([LineItemSchema, SfxItemSchema, PauseItemSchema, ImageItemSchema])
  .describe("Exactly one of line, sfx, pause, or image.");

export const SceneSchema = z.strictObject({
  id: IdSchema,
  title: z.string().optional(),
  bgm: BgmSchema.optional(),
  items: z.array(ItemSchema),
});

export const ScenarioSchema = z
  .strictObject({
    version: z.literal(1),
    title: z.string().min(1),
    publish: PublishSchema.default({ use: "private" }),
    speakers: z.array(SpeakerSchema).default([]),
    images: z.array(ImageSchema).default([]),
    scenes: z.array(SceneSchema),
  })
  .describe("vd-creator scenario, schema version 1.");

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;
export type PublishUse = (typeof PUBLISH_USES)[number];
export type ItemKind = (typeof ITEM_KINDS)[number];
export type Speaker = z.infer<typeof SpeakerSchema>;
export type Voice = z.infer<typeof VoiceSchema>;
export type Image = z.infer<typeof ImageSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Bgm = z.infer<typeof BgmSchema>;
export type LibraryRef = z.infer<typeof LibraryRefSchema>;
export type SfxSource = z.infer<typeof SfxSourceSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type LineItem = z.infer<typeof LineItemSchema>;
export type SfxItem = z.infer<typeof SfxItemSchema>;
export type PauseItem = z.infer<typeof PauseItemSchema>;
export type ImageItem = z.infer<typeof ImageItemSchema>;

type ItemFields = Partial<z.input<typeof LineItemSchema>> &
  Partial<z.input<typeof SfxItemSchema>> &
  Partial<z.input<typeof PauseItemSchema>> &
  Partial<z.input<typeof ImageItemSchema>>;

/** Fields to set on an item. A value of `undefined` removes the key. */
export type ItemPatch = { [K in keyof ItemFields]?: ItemFields[K] | undefined };

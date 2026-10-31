// The entries of the change log, changes.jsonl: their types, JSON Schema, and a checker.
// See "The change log" in docs/plans/0015-change-log-and-draft-audio.md.

/** A plain JSON value, as scenario.yaml holds it. */
export type ChangeJsonValue =
  | null
  | boolean
  | number
  | string
  | ChangeJsonValue[]
  | { [key: string]: ChangeJsonValue };

/** The fields of a target, such as an item, without its `id`. */
export type ChangeFields = { [key: string]: ChangeJsonValue };

export const CHANGE_SOURCES = ["ui", "file", "agent", "review"] as const;
/** `ui` is a change made through the server's API, `file` one found in scenario.yaml. */
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

export const CHANGE_TARGET_KINDS = ["item", "scene", "speaker", "image", "drama"] as const;
export type ChangeTargetKind = (typeof CHANGE_TARGET_KINDS)[number];

/** The ID of the target of top-level changes, such as the title. */
export const DRAMA_TARGET_ID = "drama";

export type ChangeTarget = { kind: ChangeTargetKind; id: string };

/**
 * Where a target is. `scene` is the ID of the scene of an item, and absent for the other
 * kinds. `index` counts from 0 in the scene's items, or in the list of the kind.
 */
export type ChangePosition = { scene?: string; index: number };

/** What happened to the target. A change of several fields is one `edited` change per field. */
export type ChangeDetail =
  | { change: "added"; fields: ChangeFields; to: ChangePosition }
  /** `fields` are the last fields of the target, so the UI can show what went away. */
  | { change: "removed"; fields: ChangeFields; from: ChangePosition }
  | { change: "moved"; from: ChangePosition; to: ChangePosition }
  /**
   * `field` is a path such as `line`, `take`, or `voice.settings.stability`. `old` is absent
   * if the field did not exist, and `new` if it is gone.
   */
  | { change: "edited"; field: string; old?: ChangeJsonValue; new?: ChangeJsonValue };

/** A JSON Schema `date-time` (RFC 3339): a date, a time, and a time zone. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** The maximum length of a reason. */
export const REASON_MAX_LENGTH = 300;

type EntryBase = { id: number; time: string };

/** A change found in scenario.yaml, or made through the server. */
export type TargetChangeEntry = EntryBase & {
  source: "ui" | "file";
  target: ChangeTarget;
  /** From an agent's proposal in the UI. */
  reason?: string;
  /** The session that made a `ui` change. */
  session?: string;
} & ChangeDetail;

/** The reason an agent gave for its work. `refs` are the IDs of the entries it explains. */
export type AgentEntry = EntryBase & { source: "agent"; reason: string; refs: number[] };

/** The user marked everything up to here as reviewed. */
export type ReviewEntry = EntryBase & { source: "review" };

export type ChangeEntry = TargetChangeEntry | AgentEntry | ReviewEntry;

type WithoutStamp<T> = T extends unknown ? Omit<T, "id" | "time"> : never;
/** An entry before the log gives it its `id` and `time`. */
export type ChangeEntryDraft = WithoutStamp<ChangeEntry>;

/** Thrown when changes.jsonl or changes-snapshot.json cannot be used, or an input is wrong. */
export class ChangeLogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChangeLogError";
  }
}

/** A JSON Schema (draft 2020-12) for one line of changes.jsonl. */
export function changeEntryJsonSchema(): Record<string, unknown> {
  const jsonValue = { $ref: "#/$defs/JsonValue" };
  const fields = { type: "object", additionalProperties: jsonValue };
  const position = {
    type: "object",
    properties: { scene: { type: "string" }, index: { type: "integer", minimum: 0 } },
    required: ["index"],
    additionalProperties: false,
  };
  const stamp = {
    id: { type: "integer", minimum: 1, description: "One higher than the entry before it." },
    time: { type: "string", format: "date-time", description: "ISO 8601 with time zone." },
  };
  const reason = { type: "string", minLength: 1, maxLength: REASON_MAX_LENGTH };
  const targetEntry = (
    source: readonly string[],
    change: Record<string, unknown>,
    need: string[],
  ) => ({
    type: "object",
    properties: {
      ...stamp,
      source: { enum: source },
      target: { $ref: "#/$defs/Target" },
      reason,
      session: { type: "string", minLength: 1, description: "Only on a ui entry." },
      ...change,
    },
    if: { required: ["session"] },
    // biome-ignore lint/suspicious/noThenProperty: "then" is a JSON Schema keyword here
    then: { properties: { source: { const: "ui" } } },
    required: ["id", "time", "source", "target", ...need],
    additionalProperties: false,
  });
  const sources = ["ui", "file"];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "vd-creator change log entry",
    description: "One line of changes.jsonl.",
    oneOf: [
      targetEntry(
        sources,
        {
          change: { const: "added" },
          fields: { $ref: "#/$defs/Fields" },
          to: { $ref: "#/$defs/Position" },
        },
        ["change", "fields", "to"],
      ),
      targetEntry(
        sources,
        {
          change: { const: "removed" },
          fields: { $ref: "#/$defs/Fields" },
          from: { $ref: "#/$defs/Position" },
        },
        ["change", "fields", "from"],
      ),
      targetEntry(
        sources,
        {
          change: { const: "moved" },
          from: { $ref: "#/$defs/Position" },
          to: { $ref: "#/$defs/Position" },
        },
        ["change", "from", "to"],
      ),
      targetEntry(
        sources,
        {
          change: { const: "edited" },
          field: { type: "string", minLength: 1 },
          old: jsonValue,
          new: jsonValue,
        },
        ["change", "field"],
      ),
      {
        type: "object",
        properties: {
          ...stamp,
          source: { const: "agent" },
          reason,
          refs: { type: "array", items: { type: "integer", minimum: 1 } },
        },
        required: ["id", "time", "source", "reason", "refs"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { ...stamp, source: { const: "review" } },
        required: ["id", "time", "source"],
        additionalProperties: false,
      },
    ],
    $defs: {
      JsonValue: {
        anyOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
          { type: "array", items: jsonValue },
          { type: "object", additionalProperties: jsonValue },
        ],
      },
      Fields: fields,
      Position: position,
      Target: {
        type: "object",
        properties: {
          kind: { enum: [...CHANGE_TARGET_KINDS] },
          id: { type: "string", minLength: 1 },
        },
        required: ["kind", "id"],
        additionalProperties: false,
      },
    },
  };
}

/** Checks that `value` is one entry of the log. Throws a `ChangeLogError` if it is not. */
export function parseChangeEntry(value: unknown): ChangeEntry {
  const entry = object(value, "entry");
  const source = entry.source;
  if (typeof source !== "string" || !(CHANGE_SOURCES as readonly string[]).includes(source)) {
    throw bad("source must be ui, file, agent, or review");
  }
  const allowed = ["id", "time", "source"];
  if (!Number.isInteger(entry.id) || (entry.id as number) < 1)
    throw bad("id must be an integer, 1 or more");
  if (
    typeof entry.time !== "string" ||
    !DATE_TIME.test(entry.time) ||
    Number.isNaN(Date.parse(entry.time))
  ) {
    throw bad("time must be an ISO 8601 time with a time zone, such as 2026-10-31T09:00:00.000Z");
  }
  if (source === "review") {
    noExtra(entry, allowed);
    return value as ReviewEntry;
  }
  if (source === "agent") {
    noExtra(entry, [...allowed, "reason", "refs"]);
    checkReason(entry.reason, true);
    if (
      !Array.isArray(entry.refs) ||
      !entry.refs.every((r) => Number.isInteger(r) && (r as number) >= 1)
    ) {
      throw bad("refs must be a list of entry IDs");
    }
    return value as AgentEntry;
  }
  noExtra(entry, [
    ...allowed,
    "target",
    "reason",
    "session",
    "change",
    "fields",
    "from",
    "to",
    "field",
    "old",
    "new",
  ]);
  const target = object(entry.target, "target");
  noExtra(target, ["kind", "id"]);
  if (!(CHANGE_TARGET_KINDS as readonly string[]).includes(target.kind as string)) {
    throw bad("target.kind is not a known kind");
  }
  if (typeof target.id !== "string" || target.id === "") throw bad("target.id must be a text");
  checkReason(entry.reason, false);
  if (entry.session !== undefined) {
    if (source !== "ui") throw bad("only a ui entry has a session");
    if (typeof entry.session !== "string" || entry.session === "")
      throw bad("session must be a text");
  }
  const keys: Record<string, string[]> = {
    added: ["fields", "to"],
    removed: ["fields", "from"],
    moved: ["from", "to"],
    edited: ["field", "old", "new"],
  };
  const need = typeof entry.change === "string" ? keys[entry.change] : undefined;
  if (!need) throw bad("change must be added, removed, moved, or edited");
  for (const key of ["fields", "from", "to", "field", "old", "new"]) {
    if (entry[key] !== undefined && !need.includes(key))
      throw bad(`${key} does not belong to a ${entry.change} change`);
  }
  for (const key of need) {
    if (key === "old" || key === "new") continue;
    const v = entry[key];
    if (key === "field") {
      if (typeof v !== "string" || v === "") throw bad("field must be a text");
    } else if (key === "fields") {
      object(v, "fields");
    } else {
      const position = object(v, key);
      noExtra(position, ["scene", "index"]);
      if (!Number.isInteger(position.index) || (position.index as number) < 0) {
        throw bad(`${key}.index must be an integer, 0 or more`);
      }
      if (position.scene !== undefined && typeof position.scene !== "string") {
        throw bad(`${key}.scene must be a text`);
      }
    }
  }
  return value as TargetChangeEntry;
}

function checkReason(reason: unknown, required: boolean): void {
  if (reason === undefined && !required) return;
  if (typeof reason !== "string" || reason.trim() === "") throw bad("reason must be a text");
  if ([...reason].length > REASON_MAX_LENGTH) {
    throw bad(`reason must be ${REASON_MAX_LENGTH} characters or fewer`);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw bad(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function noExtra(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw bad(`unknown field "${extra}"`);
}

function bad(message: string): ChangeLogError {
  return new ChangeLogError(`Invalid change log entry: ${message}`);
}

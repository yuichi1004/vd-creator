// takes.jsonl: the take history of the lines of a project. See "Take history" in
// docs/plans/0013-voice-retake-with-agent.md.

import { appendFile, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { Scenario } from "@vd-creator/scenario";
import { canonicalJson } from "../canonical.js";
import type { ScenarioItem } from "../items.js";

/** File name of the take history inside a project folder. */
export const TAKES_FILE = "takes.jsonl";

/**
 * One TTS asset generated for a line, with the line's own fields that made the request. Entries
 * are appended and never changed. `voiceSettings` is the line's `voice.settings` override as it
 * was, not merged over the speaker's, and `speakerSettings` is the speaker's own.
 */
export type TakeEntry = {
  /** ISO 8601 time the asset was generated. */
  time: string;
  /** The ID of the line. */
  item: string;
  /** The cache key of the asset. */
  key: string;
  /** The ID of the provider that made the asset. */
  provider: string;
  line: string;
  direction?: string;
  voiceSettings?: Record<string, unknown>;
  voiceId: string;
  speakerSettings?: Record<string, unknown>;
  take: number;
  /** True for a trial take, made to be heard before anything in the scenario changed. */
  trial?: true;
  /** The proposal a trial came from, if any (plan 0013, the agent task). */
  proposalId?: string;
  /** The reason of that proposal, up to 300 characters, kept so that a later "Keep" can log it. */
  reason?: string;
};

/** What a generation run adds to the entries of the lines it generates. */
export type TakeContext = {
  trial?: boolean;
  proposalId?: string;
  reason?: string;
};

/**
 * The history entry of a line's asset. Throws if the line names an unknown speaker, as
 * `generationRequest` does.
 */
export function takeEntryFor(
  scenario: Scenario,
  target: Extract<ScenarioItem, { kind: "line" }>,
  made: { key: string; provider: string; time: string },
  context: TakeContext = {},
): TakeEntry {
  const { item } = target;
  const speaker = scenario.speakers.find((s) => s.id === item.speaker);
  if (!speaker) throw new Error(`Line "${item.id}" names an unknown speaker`);
  const entry: TakeEntry = {
    time: made.time,
    item: item.id,
    key: made.key,
    provider: made.provider,
    line: item.line,
    voiceId: speaker.voice.voiceId,
    take: item.take,
  };
  if (item.direction !== undefined) entry.direction = item.direction;
  const override = item.voice?.settings;
  if (override !== undefined) entry.voiceSettings = override;
  const speakerSettings = speaker.voice.settings;
  if (speakerSettings !== undefined) entry.speakerSettings = speakerSettings;
  if (context.trial) entry.trial = true;
  if (context.proposalId !== undefined) entry.proposalId = context.proposalId;
  if (context.reason !== undefined) entry.reason = context.reason;
  return entry;
}

/** The text of the history up to its last newline; a cut-off last line is left out. */
async function readComplete(projectDir: string): Promise<{ text: string; cutOff: boolean }> {
  let data: Buffer;
  try {
    data = await readFile(join(projectDir, TAKES_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { text: "", cutOff: false };
    throw e;
  }
  const bytes = data.lastIndexOf(0x0a) + 1;
  return { text: data.subarray(0, bytes).toString("utf8"), cutOff: bytes < data.length };
}

/**
 * Reads `<projectDir>/takes.jsonl`, oldest first. Returns nothing if the file does not exist.
 * A last line without its newline was cut off by a stopped writer, and a line that is not an
 * entry cannot say what it made, so both are skipped.
 */
export async function readTakes(projectDir: string): Promise<TakeEntry[]> {
  const entries: TakeEntry[] = [];
  for (const line of (await readComplete(projectDir)).text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = parseTakeEntry(value);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** The history of one line, oldest first. */
export function takesOfItem(entries: readonly TakeEntry[], itemId: string): TakeEntry[] {
  return entries.filter((e) => e.item === itemId);
}

/**
 * Appends one entry, in one write ending in a newline. A cut-off last line of an earlier writer
 * is removed first. The entry must be plain JSON, which `canonicalJson` checks.
 */
export async function appendTake(projectDir: string, entry: TakeEntry): Promise<void> {
  canonicalJson(entry);
  const { cutOff } = await readComplete(projectDir);
  if (cutOff) {
    const data = await readFile(join(projectDir, TAKES_FILE));
    await truncate(join(projectDir, TAKES_FILE), data.lastIndexOf(0x0a) + 1);
  }
  await appendFile(join(projectDir, TAKES_FILE), `${JSON.stringify(entry)}\n`);
}

function parseTakeEntry(value: unknown): TakeEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { time, item, key, provider, line, voiceId, take } = value;
  if (
    typeof time !== "string" ||
    typeof item !== "string" ||
    typeof key !== "string" ||
    !/^[0-9a-f]{64}$/.test(key) ||
    typeof provider !== "string" ||
    typeof line !== "string" ||
    typeof voiceId !== "string" ||
    typeof take !== "number" ||
    !Number.isSafeInteger(take) ||
    take < 0
  ) {
    return undefined;
  }
  const entry: TakeEntry = { time, item, key, provider, line, voiceId, take };
  for (const field of ["direction", "proposalId", "reason"] as const) {
    const v = value[field];
    if (v === undefined) continue;
    if (typeof v !== "string") return undefined;
    entry[field] = v;
  }
  for (const field of ["voiceSettings", "speakerSettings"] as const) {
    const v = value[field];
    if (v === undefined) continue;
    if (!isRecord(v)) return undefined;
    entry[field] = v;
  }
  if (value.trial === true) entry.trial = true;
  else if (value.trial !== undefined) return undefined;
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

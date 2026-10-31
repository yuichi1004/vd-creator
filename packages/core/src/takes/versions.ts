// The versions of a line: its history, which of them can be used again, and the line's fields
// for a trial or a restore. See "Take history" in docs/plans/0013-voice-retake-with-agent.md.

import type { LineItem, Scenario } from "@vd-creator/scenario";
import type { AssetCache } from "../cache.js";
import { cacheKey, canonicalJson, isCanonicalJsonError } from "../canonical.js";
import { generationRequest, type ScenarioItem, scenarioItems } from "../items.js";
import { type TakeEntry, takeEntryFor, takesOfItem } from "./history.js";

/** The fields of a line that make up its request, apart from the speaker's voice. */
export type LineFields = {
  speaker: string;
  line: string;
  direction?: string;
  /** The line's `voice.settings` override, not merged with the speaker's. */
  voiceSettings?: Record<string, unknown>;
  take: number;
};

/**
 * A change of a line's fields, as the API takes it. `direction: ""` removes the direction. In
 * `voiceSettings`, a value sets one key of the line's override and `null` removes one.
 */
export type LineEdit = {
  line?: string;
  direction?: string;
  voiceSettings?: Record<string, unknown>;
};

type LineTarget = Extract<ScenarioItem, { kind: "line" }>;

function lineTarget(scenario: Scenario, itemId: string): LineTarget | undefined {
  return scenarioItems(scenario).find((t): t is LineTarget => t.kind === "line" && t.id === itemId);
}

/** The fields of the line with this ID, or `undefined` if the scenario has no such line. */
export function lineFieldsOf(scenario: Scenario, itemId: string): LineFields | undefined {
  const target = lineTarget(scenario, itemId);
  if (!target) return undefined;
  const { item } = target;
  const fields: LineFields = { speaker: item.speaker, line: item.line, take: item.take };
  if (item.direction !== undefined) fields.direction = item.direction;
  if (item.voice?.settings !== undefined) fields.voiceSettings = item.voice.settings;
  return fields;
}

/** True if the fields are equal. A line with an empty override equals one without. */
export function sameLineFields(a: LineFields, b: LineFields): boolean {
  return canonicalJson(normalized(a)) === canonicalJson(normalized(b));
}

function normalized(fields: LineFields): LineFields {
  const { voiceSettings, ...rest } = fields;
  return voiceSettings && Object.keys(voiceSettings).length > 0 ? fields : rest;
}

/**
 * The override with `edit` applied one key at a time: a value sets the key, `null` removes it.
 * `undefined` if no key is left, because a line without an override is written without `voice`.
 */
export function mergeVoiceSettings(
  current: Record<string, unknown> | undefined,
  edit: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(edit)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** The fields with `edit` applied. */
export function applyLineEdit(fields: LineFields, edit: LineEdit): LineFields {
  const out: LineFields = {
    speaker: fields.speaker,
    line: edit.line ?? fields.line,
    take: fields.take,
  };
  const direction = edit.direction === undefined ? fields.direction : edit.direction;
  if (direction !== undefined && direction !== "") out.direction = direction;
  const settings =
    edit.voiceSettings === undefined
      ? fields.voiceSettings
      : mergeVoiceSettings(fields.voiceSettings, edit.voiceSettings);
  if (settings !== undefined) out.voiceSettings = settings;
  return out;
}

/**
 * A copy of the scenario in which the line has these fields. The speaker is kept. Throws if the
 * scenario has no such line.
 */
export function withLineFields(
  scenario: Scenario,
  itemId: string,
  fields: Omit<LineFields, "speaker">,
): Scenario {
  const copy = structuredClone(scenario);
  const target = lineTarget(copy, itemId);
  if (!target) throw new Error(`No line has the ID "${itemId}"`);
  const item: LineItem = target.item;
  item.line = fields.line;
  item.take = fields.take;
  if (fields.direction === undefined) delete item.direction;
  else item.direction = fields.direction;
  if (fields.voiceSettings === undefined) delete item.voice;
  else item.voice = { settings: fields.voiceSettings };
  return copy;
}

/** A take number one higher than any in the line's history and in the scenario. */
export function nextTakeNumber(
  scenario: Scenario,
  itemId: string,
  history: readonly TakeEntry[],
): number {
  const current = lineFieldsOf(scenario, itemId)?.take ?? 0;
  return Math.max(current, ...takesOfItem(history, itemId).map((e) => e.take)) + 1;
}

/** Why a version cannot be used again. */
export type TakeUnavailable =
  /** The asset file is gone, such as after `vd clean`. */
  | "missing-file"
  /** The drama's provider is not the one that made the asset. */
  | "other-provider"
  | "other-voice"
  | "other-speaker-settings"
  /** The line's fields no longer make the request of the asset. */
  | "request-changed"
  /** Playback picks a newer asset of another provider for the same request. */
  | "shadowed";

export type TakeVersion = {
  entry: TakeEntry;
  /** True if the line's request now has this version's cache key. */
  current: boolean;
  /** The asset file under `assets/`, and its length, if the file exists. */
  file?: string;
  durationSec?: number;
  /** Absent if "Use this take" is possible. */
  unavailable?: TakeUnavailable;
};

/**
 * The versions of a line, newest first: its history, plus its current asset if the history
 * does not have it, such as for a line generated before the history existed. `providerId` is
 * the provider of the drama now. A version can be used again only if the line can point at
 * exactly that asset, by the rules of `TakeUnavailable`. Returns `undefined` if the scenario
 * has no such line.
 */
export async function listTakes(
  scenario: Scenario,
  cache: AssetCache,
  history: readonly TakeEntry[],
  itemId: string,
  providerId: string,
): Promise<TakeVersion[] | undefined> {
  const target = lineTarget(scenario, itemId);
  if (!target) return undefined;
  const currentKey = requestKey(scenario, target, providerId);

  // One version per cache key: the latest entry, as an asset made again after `vd clean` is.
  const own = takesOfItem(history, itemId);
  const entries = own.filter((e, i) => !own.slice(i + 1).some((later) => later.key === e.key));
  const cached = currentKey === undefined ? undefined : cache.get(currentKey);
  if (currentKey !== undefined && cached && !entries.some((e) => e.key === currentKey)) {
    entries.push(
      takeEntryFor(scenario, target, {
        key: currentKey,
        provider: cached.providerId,
        time: cached.createdAt,
      }),
    );
  }

  const versions: TakeVersion[] = [];
  for (const entry of entries) {
    versions.push(await versionOf(scenario, cache, target, entry, providerId, currentKey));
  }
  // Newest first; entries made in the same millisecond keep their history order, newest last.
  const time = (e: TakeEntry) => Date.parse(e.time) || Number.NEGATIVE_INFINITY;
  return versions
    .map((v, i) => ({ v, i }))
    .sort((a, b) => time(b.v.entry) - time(a.v.entry) || b.i - a.i)
    .map(({ v }) => v);
}

function requestKey(
  scenario: Scenario,
  target: LineTarget,
  providerId: string,
): string | undefined {
  try {
    const gen = generationRequest(scenario, target);
    return gen && cacheKey(gen.kind, providerId, gen.request);
  } catch (e) {
    if (isCanonicalJsonError(e)) return undefined;
    throw e;
  }
}

/**
 * The cache key of the request a line makes now, or undefined if the item is not a line or makes
 * no valid request. The server uses it to check a saved restore, as `listTakes` does.
 */
export function lineCacheKey(
  scenario: Scenario,
  itemId: string,
  providerId: string,
): string | undefined {
  const target = lineTarget(scenario, itemId);
  return target && requestKey(scenario, target, providerId);
}

async function versionOf(
  scenario: Scenario,
  cache: AssetCache,
  target: LineTarget,
  entry: TakeEntry,
  providerId: string,
  currentKey: string | undefined,
): Promise<TakeVersion> {
  const asset = await cache.cachedAsset(entry.key);
  const version: TakeVersion = { entry, current: entry.key === currentKey };
  if (asset) {
    version.file = asset.file;
    version.durationSec = asset.durationSec;
  }
  const unavailable = await whyUnavailable(scenario, cache, target, entry, providerId, asset);
  if (unavailable) version.unavailable = unavailable;
  return version;
}

async function whyUnavailable(
  scenario: Scenario,
  cache: AssetCache,
  target: LineTarget,
  entry: TakeEntry,
  providerId: string,
  asset: Awaited<ReturnType<AssetCache["cachedAsset"]>>,
): Promise<TakeUnavailable | undefined> {
  if (!asset) return "missing-file";
  if (entry.provider !== providerId || asset.providerId !== providerId) return "other-provider";
  const speaker = scenario.speakers.find((s) => s.id === target.item.speaker);
  if (!speaker || entry.voiceId !== speaker.voice.voiceId) return "other-voice";
  if (canonicalOrNull(entry.speakerSettings) !== canonicalOrNull(speaker.voice.settings)) {
    return "other-speaker-settings";
  }
  // The line with the version's fields must make exactly the version's request.
  const candidate = withLineFields(scenario, target.id, restoreFields(entry));
  const candidateTarget = lineTarget(candidate, target.id);
  if (!candidateTarget || requestKey(candidate, candidateTarget, providerId) !== entry.key) {
    return "request-changed";
  }
  // Playback picks the newest asset of a request from any provider.
  const picked = await cache.playbackAsset(asset.kind, asset.request);
  if (picked && picked.key !== entry.key) return "shadowed";
  return undefined;
}

function canonicalOrNull(value: unknown): string {
  return canonicalJson(value ?? null);
}

/** The fields a restore sets: the version's text, direction, override, and take. */
export function restoreFields(entry: TakeEntry): Omit<LineFields, "speaker"> {
  const fields: Omit<LineFields, "speaker"> = { line: entry.line, take: entry.take };
  if (entry.direction !== undefined) fields.direction = entry.direction;
  if (entry.voiceSettings !== undefined) fields.voiceSettings = entry.voiceSettings;
  return fields;
}

/**
 * The version with this cache key if it can be used again, by the same rule as `listTakes`, so
 * that the list and a restore agree. Otherwise why not: `unknown` if the line has no such version.
 */
export async function findRestorable(
  scenario: Scenario,
  cache: AssetCache,
  history: readonly TakeEntry[],
  itemId: string,
  providerId: string,
  key: string,
): Promise<{ version: TakeVersion } | { unavailable: TakeUnavailable | "unknown" }> {
  const versions = await listTakes(scenario, cache, history, itemId, providerId);
  const version = versions?.find((v) => v.entry.key === key);
  if (!version) return { unavailable: "unknown" };
  return version.unavailable ? { unavailable: version.unavailable } : { version };
}

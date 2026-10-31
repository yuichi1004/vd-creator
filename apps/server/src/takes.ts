// Parsing and views for the take routes: voice settings, restore, trials, and the take list.

import type { LineFields, TakeUnavailable, TakeVersion } from "@vd-creator/core";
import type { TakeInfo, TakeUnavailableInfo, TrialBase } from "./api.js";

/** Fixed text for each reason a version cannot be used. It never holds request text. */
export const UNAVAILABLE_MESSAGES: Record<TakeUnavailable, string> = {
  "missing-file": "The audio file of this take is gone",
  "other-provider": "This take was made with another provider than the one in use",
  "other-voice": "This take was made with another voice than the speaker has now",
  "other-speaker-settings": "This take was made with other settings of the speaker's voice",
  "request-changed": "The line would no longer make the request of this take",
  shadowed: "A newer take from another provider would play instead of this one",
};

/** True if `value` is plain JSON: finite numbers, strings, booleans, null, lists, and objects. */
export function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isPlainJson(v, depth + 1));
  if (typeof value !== "object") return false;
  return Object.values(value).every((v) => isPlainJson(v, depth + 1));
}

/** The base of a request as the line fields it compares with. */
export function baseFields(base: TrialBase): LineFields {
  const fields: LineFields = { speaker: base.speaker, line: base.text, take: base.take };
  if (base.direction !== undefined && base.direction !== "") fields.direction = base.direction;
  if (base.voiceSettings !== undefined) fields.voiceSettings = base.voiceSettings;
  return fields;
}

/** The version as the take list shows it. */
export function takeInfo(version: TakeVersion): TakeInfo {
  const { entry } = version;
  const info: TakeInfo = {
    key: entry.key,
    time: entry.time,
    take: entry.take,
    trial: entry.trial === true,
    provider: entry.provider,
    current: version.current,
    text: entry.line,
    canUse: version.unavailable === undefined,
  };
  if (entry.direction !== undefined) info.direction = entry.direction;
  if (entry.voiceSettings !== undefined) info.voiceSettings = entry.voiceSettings;
  if (entry.proposalId !== undefined) info.proposalId = entry.proposalId;
  if (entry.reason !== undefined) info.reason = entry.reason;
  if (version.file !== undefined) info.url = `/assets/${version.file}`;
  if (version.durationSec !== undefined) info.durationSec = version.durationSec;
  if (version.unavailable !== undefined) {
    const why: TakeUnavailableInfo = {
      code: version.unavailable,
      message: UNAVAILABLE_MESSAGES[version.unavailable],
    };
    info.why = why;
  }
  return info;
}

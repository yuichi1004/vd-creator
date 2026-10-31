// What the agent answers: the JSON envelope of the agent's command, then the proposal inside it.
// Nothing the agent wrote is ever passed on in an error: a refusal says only that the answer
// could not be used. See "Agent proposals" in docs/plans/0013-voice-retake-with-agent.md.

import type { ServerProviders } from "../app.js";

/** One voice setting the provider reads, with its range (see `TtsProvider.voiceParameters`). */
export type VoiceParameter = ReturnType<
  NonNullable<ServerProviders["tts"]["voiceParameters"]>
>[number];

export const MAX_TEXT = 500;
export const MAX_DIRECTION = 300;
export const MAX_REASON = 300;

/** What the agent proposes for a line. At least one of `text`, `direction`, and `settings`. */
export type Proposal = {
  text?: string;
  direction?: string;
  settings?: Record<string, number | boolean>;
  reason: string;
};

export type AnswerResult = { ok: true; proposal: Proposal } | { ok: false };

const KEYS = new Set(["direction", "text", "settings", "reason"]);

/**
 * The text that claude prints with `--output-format json`: the `result` string of its JSON
 * envelope. `undefined` unless the output is a successful result envelope: `type` "result", `subtype`
 * "success", `is_error` false.
 */
export function unwrapClaude(stdout: string): string | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (
    !isRecord(envelope) ||
    envelope.type !== "result" ||
    envelope.subtype !== "success" ||
    envelope.is_error !== false
  ) {
    return undefined;
  }
  return typeof envelope.result === "string" ? envelope.result : undefined;
}

/**
 * Checks the answer against the strict schema `{direction?, text?, settings?, reason}`. The
 * answer must be the JSON object and nothing else: text around it, a code fence included, is
 * refused. `settings` may hold only keys of `parameters`, with values the parameter allows.
 */
export function parseAnswer(answer: string, parameters: readonly VoiceParameter[]): AnswerResult {
  let value: unknown;
  try {
    value = JSON.parse(answer);
  } catch {
    return { ok: false };
  }
  if (!isRecord(value)) return { ok: false };
  if (Object.keys(value).some((key) => !KEYS.has(key))) return { ok: false };

  const proposal: Proposal = { reason: "" };
  if (!limited(value.reason, MAX_REASON)) return { ok: false };
  proposal.reason = value.reason as string;
  if (value.text !== undefined) {
    if (!limited(value.text, MAX_TEXT)) return { ok: false };
    proposal.text = value.text as string;
  }
  if (value.direction !== undefined) {
    if (!limited(value.direction, MAX_DIRECTION)) return { ok: false };
    proposal.direction = value.direction as string;
  }
  if (value.settings !== undefined) {
    const settings = checkSettings(value.settings, parameters);
    if (!settings) return { ok: false };
    proposal.settings = settings;
  }
  if (
    proposal.text === undefined &&
    proposal.direction === undefined &&
    proposal.settings === undefined
  ) {
    return { ok: false };
  }
  return { ok: true, proposal };
}

/** A text of 1 to `max` characters that is not only blanks. */
function limited(value: unknown, max: number): boolean {
  return typeof value === "string" && value.trim() !== "" && [...value].length <= max;
}

function checkSettings(
  value: unknown,
  parameters: readonly VoiceParameter[],
): Record<string, number | boolean> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  const settings: Record<string, number | boolean> = {};
  for (const [key, setting] of entries) {
    const parameter = parameters.find((p) => p.key === key);
    if (!parameter || !allowed(parameter, setting)) return undefined;
    settings[key] = setting as number | boolean;
  }
  return settings;
}

function allowed(parameter: VoiceParameter, value: unknown): boolean {
  if (parameter.kind === "on-off") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if ("values" in parameter) return parameter.values.includes(value);
  if (value < parameter.min || value > parameter.max) return false;
  // On a step from `min`, with room for the rounding of a decimal step.
  const steps = (value - parameter.min) / parameter.step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

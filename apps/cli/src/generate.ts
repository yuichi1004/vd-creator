// vd generate: the plan report and failure reasons.
// See "vd generate" in docs/plans/0004-providers-and-generation.md.

import { type GenerationError, type GenerationPlan, itemLabel } from "@vd-creator/core";
import { ElevenLabsError } from "@vd-creator/providers";

/** The provider used when --provider is not given, whatever the scenario's speakers name. */
export const DEFAULT_PROVIDER = "mock";

const STATUS_LABELS = {
  "to-generate": "generate",
  cached: "cached",
  unresolved: "unresolved",
  invalid: "invalid",
} as const;

/**
 * The plan as lines of text: one line per item with its status, kind, and ID, then the counts
 * and the estimated cost. It never contains an item's text or prompt.
 */
export function formatPlan(plan: GenerationPlan, providerId: string): string[] {
  const width = Math.max(...Object.values(STATUS_LABELS).map((s) => s.length));
  const lines = [`Plan with provider ${providerId}:`];
  const counts = { "to-generate": 0, cached: 0, unresolved: 0, invalid: 0 };
  for (const item of plan.items) {
    counts[item.status]++;
    lines.push(`  ${STATUS_LABELS[item.status].padEnd(width)}  ${itemLabel(item)}`);
  }
  if (plan.items.length === 0) lines.push("  (no items)");
  lines.push(
    `${counts["to-generate"]} to generate, ${counts.cached} cached, ${counts.unresolved} unresolved, ${counts.invalid} invalid`,
  );
  lines.push(
    `Estimated cost: ${plural(plan.cost.characters, "character")}, ${plural(plan.cost.requests, "request")}`,
  );
  return lines;
}

/**
 * A short reason for a failed item, from a fixed set: an ElevenLabs error code and HTTP
 * status, a file system error code, or "invalid request". The error messages themselves are
 * never used, because they can hold the item's text.
 */
export function failureReason(
  error: GenerationError,
  invalid: boolean,
  fsErrorCode: (e: unknown) => string | undefined,
): string {
  if (invalid) return "invalid request";
  const cause = error.cause;
  if (cause instanceof ElevenLabsError) {
    return cause.status === undefined ? cause.code : `${cause.code}, HTTP ${cause.status}`;
  }
  return fsErrorCode(cause) ?? "error";
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

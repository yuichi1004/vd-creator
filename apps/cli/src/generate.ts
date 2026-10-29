// vd generate: the plan report and failure reasons.
// See "vd generate" in docs/plans/0004-providers-and-generation.md.

import { type GenerationError, type GenerationPlan, itemLabel } from "@vd-creator/core";
import { LibraryError } from "@vd-creator/library";
import {
  createElevenLabsProviders,
  createProviders,
  ELEVENLABS_PROVIDER_ID,
  ElevenLabsError,
  type MusicProvider,
  type ProviderSet,
  type SfxProvider,
  type TtsProvider,
} from "@vd-creator/providers";

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
    // A library sound is copied, not generated, and costs nothing.
    const label =
      item.status === "to-generate" && item.resolver === "library"
        ? "copy"
        : STATUS_LABELS[item.status];
    lines.push(`  ${label.padEnd(width)}  ${itemLabel(item)}`);
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

/** Thrown when a paid provider is called without the --yes authorization. */
export class PaidCallRefusedError extends Error {
  constructor() {
    super("A paid provider was called without --yes");
    this.name = "PaidCallRefusedError";
  }
}

/** A fetch that never reaches the network, for providers built without authorization. */
const refusedFetch: typeof fetch = () => Promise.reject(new PaidCallRefusedError());

/**
 * The providers for an ID. Without `authorized`, which only `--yes` gives, the ElevenLabs
 * providers are built with a fetch that refuses every call, so they cannot reach the network
 * and can only estimate. In both cases every paid provider is wrapped by `gateProviders`.
 */
export function providersFor(id: string, authorized: boolean): ProviderSet {
  const providers =
    id === ELEVENLABS_PROVIDER_ID
      ? createElevenLabsProviders(authorized ? {} : { fetch: refusedFetch })
      : createProviders(id);
  return gateProviders(providers, authorized);
}

/** True if any provider of the set costs money per call. */
export function isPaid(providers: ProviderSet): boolean {
  return providers.tts.paid || providers.sfx.paid || providers.music.paid;
}

/**
 * Wraps each paid provider so that, without `authorized`, a call throws a
 * `PaidCallRefusedError` before the provider runs. Estimates always pass through.
 */
export function gateProviders(providers: ProviderSet, authorized: boolean): ProviderSet {
  if (authorized) return providers;
  const refuse = async (): Promise<never> => {
    throw new PaidCallRefusedError();
  };
  const { tts, sfx, music } = providers;
  const gatedTts: TtsProvider = {
    id: tts.id,
    paid: tts.paid,
    estimate: (req) => tts.estimate(req),
    synthesize: (req) => (tts.paid ? refuse() : tts.synthesize(req)),
  };
  const gatedSfx: SfxProvider = {
    id: sfx.id,
    paid: sfx.paid,
    estimate: (req) => sfx.estimate(req),
    generate: (req) => (sfx.paid ? refuse() : sfx.generate(req)),
  };
  const gatedMusic: MusicProvider = {
    id: music.id,
    paid: music.paid,
    estimate: (req) => music.estimate(req),
    generate: (req) => (music.paid ? refuse() : music.generate(req)),
  };
  return { tts: gatedTts, sfx: gatedSfx, music: gatedMusic };
}

/**
 * A short reason for a failed item, from a fixed set: an ElevenLabs error code and HTTP
 * status, a refused paid call, or a file system error code. The error messages themselves
 * are never used, because they can hold the item's text. A library error is the exception:
 * its message names only library files, relative to the library, so it is returned for the
 * caller to make safe to print.
 */
export function failureReason(
  error: GenerationError,
  fsErrorCode: (e: unknown) => string | undefined,
): string {
  const cause = error.cause;
  if (cause instanceof PaidCallRefusedError) return "paid call refused without --yes";
  if (cause instanceof LibraryError) return cause.message;
  if (cause instanceof ElevenLabsError) {
    return cause.status === undefined ? cause.code : `${cause.code}, HTTP ${cause.status}`;
  }
  return fsErrorCode(cause) ?? "error";
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

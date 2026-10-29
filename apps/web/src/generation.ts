// The generation flow of the UI. See "Paid generation from the UI" in
// docs/plans/0005-review-ui.md and the rules on `GenerateRequest` in apps/server/src/api.ts.
//
// A free provider runs with one request. A paid provider first gets the plan, the UI shows
// "Generate (N characters)", and only when the user presses it is the same request sent
// with `confirm: true`.

import type { GeneratePlanResponse, GenerateRunResponse, ProviderInfo } from "@vd-creator/server";
import { type ApiClient, ApiRequestError, isConfirmRequired } from "./client.js";

/** The outcome of starting a generation. */
export type GenerationStart =
  /** The generation ran. */
  | { kind: "done"; run: GenerateRunResponse }
  /**
   * The provider is paid and nothing ran yet. Show `plan` and call `confirm` only after the
   * user pressed "Generate (N characters)".
   */
  | { kind: "confirm"; plan: GeneratePlanResponse; confirm: () => Promise<GenerateRunResponse> }
  /**
   * The plan has no item to generate, so there is nothing to confirm and nothing was sent
   * with `confirm`. Refresh the project instead.
   */
  | { kind: "nothing"; plan: GeneratePlanResponse };

/** Label of the confirm button, from the plan's estimated characters. */
export function confirmLabel(plan: GeneratePlanResponse): string {
  return `Generate (${plan.plan.cost.characters} characters)`;
}

/**
 * Starts a generation of `ids`, or of every item when absent. With a paid provider this
 * only asks for the plan (`dryRun: true`) and never generates; the caller runs it with
 * `confirm`. With a free provider it sends one request. If a free provider's request is
 * refused with 409 `confirm-required`, the plan from that body is used instead.
 */
export async function startGeneration(
  client: ApiClient,
  provider: ProviderInfo,
  ids?: string[],
): Promise<GenerationStart> {
  const base = ids ? { ids } : {};
  const confirm = async (): Promise<GenerateRunResponse> => {
    const response = await client.generate({ ...base, confirm: true });
    if (response.kind !== "run") throw new ApiRequestError("Unexpected response.", 200);
    return response;
  };

  const fromPlan = (plan: GeneratePlanResponse): GenerationStart =>
    hasWork(plan) ? { kind: "confirm", plan, confirm } : { kind: "nothing", plan };

  if (provider.paid) {
    const response = await client.generate({ ...base, dryRun: true });
    if (response.kind !== "plan") throw new ApiRequestError("Unexpected response.", 200);
    return fromPlan(response);
  }

  try {
    const response = await client.generate(base);
    if (response.kind === "run") return { kind: "done", run: response };
    return fromPlan(response);
  } catch (error) {
    if (error instanceof ApiRequestError && isConfirmRequired(error.body)) {
      return fromPlan(error.body.plan);
    }
    throw error;
  }
}

/** Whether a plan has any item that a confirmed run would generate. */
function hasWork(plan: GeneratePlanResponse): boolean {
  return plan.plan.items.some((item) => item.status === "to-generate");
}

/**
 * The status message when a plan has nothing to generate, naming the items that cannot be
 * generated, if any.
 */
export function nothingSummary(plan: GeneratePlanResponse): string {
  const unresolved = plan.plan.items.filter((i) => i.status === "unresolved").length;
  const invalid = plan.plan.items.filter((i) => i.status === "invalid").length;
  const parts: string[] = [];
  if (unresolved > 0) parts.push(`${unresolved} unresolved`);
  if (invalid > 0) parts.push(`${invalid} invalid`);
  return parts.length > 0 ? `Nothing to generate: ${parts.join(", ")}.` : "Nothing to generate.";
}

/** A short summary of a generation run, for a status message. */
export function runSummary(run: GenerateRunResponse): string {
  const generated = run.items.filter((i) => i.status === "generated").length;
  const unresolved = run.items.filter((i) => i.status === "unresolved").length;
  const parts = [`${generated} generated`];
  if (run.failed > 0) parts.push(`${run.failed} failed`);
  if (unresolved > 0) parts.push(`${unresolved} unresolved`);
  return parts.join(", ");
}

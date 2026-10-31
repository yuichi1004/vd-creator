// Trial takes: a line generated with a proposed change, without writing the scenario. See
// "Trial takes" in docs/plans/0013-voice-retake-with-agent.md.

import type { Scenario } from "@vd-creator/scenario";
import type { AssetCache } from "../cache.js";
import {
  type GenerationPlan,
  type ItemResult,
  planGeneration,
  type RunGenerationOptions,
  runGeneration,
} from "../generate.js";
import type { AssetResolver } from "../resolver.js";
import { readTakes } from "./history.js";
import {
  applyLineEdit,
  type LineEdit,
  lineFieldsOf,
  nextTakeNumber,
  withLineFields,
} from "./versions.js";

export type TrialOptions = {
  /** Which proposal the trial tries; kept in the history entry. */
  proposalId?: string;
  /** Why the proposal was made, up to 300 characters; kept in the history entry. */
  reason?: string;
  /** The most the trial may send to paid providers. */
  budget?: RunGenerationOptions["budget"];
};

/**
 * The scenario as the trial sees it: a copy with the edit applied to the line and a take number
 * one higher than any in the history and the scenario, so that a trial is always a new request.
 * The scenario itself is never changed. Throws if the scenario has no such line.
 */
export async function trialScenario(
  scenario: Scenario,
  cache: AssetCache,
  itemId: string,
  edit: LineEdit,
): Promise<Scenario> {
  const fields = lineFieldsOf(scenario, itemId);
  if (!fields) throw new Error(`No line has the ID "${itemId}"`);
  const history = await readTakes(cache.projectDir);
  const edited = applyLineEdit(fields, edit);
  const take = nextTakeNumber(scenario, itemId, history);
  return withLineFields(scenario, itemId, { ...edited, take });
}

/** What a trial would do, and cost. Makes no provider calls and writes nothing. */
export async function planTrial(
  scenario: Scenario,
  cache: AssetCache,
  resolvers: readonly AssetResolver[],
  itemId: string,
  edit: LineEdit,
): Promise<GenerationPlan> {
  const trial = await trialScenario(scenario, cache, itemId, edit);
  return planGeneration(trial, cache, resolvers, { only: [itemId] });
}

/**
 * Generates one trial take of a line. The asset and the cache entry are written, and a history
 * entry with `trial: true`, but never `scenario.yaml`. A failed generation changes nothing the
 * user can see. Returns the item's result and the take number tried.
 */
export async function runTrial(
  scenario: Scenario,
  cache: AssetCache,
  resolvers: readonly AssetResolver[],
  itemId: string,
  edit: LineEdit,
  options: TrialOptions = {},
): Promise<{ result: ItemResult; take: number }> {
  const trial = await trialScenario(scenario, cache, itemId, edit);
  const take = lineFieldsOf(trial, itemId)?.take ?? 0;
  const takes: NonNullable<RunGenerationOptions["takes"]> = { trial: true };
  if (options.proposalId !== undefined) takes.proposalId = options.proposalId;
  if (options.reason !== undefined) takes.reason = options.reason;
  const run: RunGenerationOptions = { only: [itemId], takes };
  if (options.budget) run.budget = options.budget;
  const { items } = await runGeneration(trial, cache, resolvers, run);
  const result = items[0];
  if (!result) throw new Error(`The trial of "${itemId}" returned no result`);
  return { result, take };
}

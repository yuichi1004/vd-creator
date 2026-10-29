// planGeneration and runGeneration. See "vd generate" in docs/plans/0004-providers-and-generation.md.

import { type LicenseRegistry, MOCK_PROVIDER_ID } from "@vd-creator/library";
import type { Cost } from "@vd-creator/providers";
import type { Scenario } from "@vd-creator/scenario";
import { AssetCache } from "./cache.js";
import { isCanonicalJsonError } from "./canonical.js";
import { itemLabel, type ScenarioItem, type ScenarioItemKind, scenarioItems } from "./items.js";
import { type ProviderUse, playedProviders, recordProvider } from "./library/project.js";
import {
  type AssetResolver,
  GenerationBudget,
  type PlannedAsset,
  type ResolveContext,
} from "./resolver.js";

/** At most this many requests run at once. */
export const GENERATION_CONCURRENCY = 4;

/**
 * A failure to plan or generate one item. The message names only the item's kind and ID,
 * never its text, prompt, or any environment value. The original error is the `cause`.
 */
export class GenerationError extends Error {
  readonly itemId: string;
  readonly kind: ScenarioItemKind;

  constructor(
    item: { kind: ScenarioItemKind; id: string },
    step: "plan" | "generate",
    cause: unknown,
  ) {
    super(`Failed to ${step} ${itemLabel(item)}`, { cause });
    this.name = "GenerationError";
    this.itemId = item.id;
    this.kind = item.kind;
  }
}

export type PlannedItem = PlannedAsset & {
  id: string;
  kind: ScenarioItemKind;
  sceneId: string;
  /** The resolver that handles the item. Absent for unresolved items that no resolver handles. */
  resolver?: string;
};

export type GenerationPlan = {
  items: PlannedItem[];
  /** Total estimated cost of the to-generate items. Identical requests count once. */
  cost: Cost;
};

export type GenerationOptions = {
  /** Only these item IDs. A BGM uses its scene's ID. Throws if an ID matches no item. */
  only?: readonly string[];
};

const NO_RESOLVER = "No resolver handles this item";

/** The reason of an `invalid` item. It names only the item, never its request. */
function invalidReason(item: ScenarioItem): string {
  return `The request of ${itemLabel(item)} is not plain JSON, such as a non-finite number or a cycle in its settings`;
}

/**
 * Plans the generation of a scenario: which items are cached, which would be generated, and
 * which no resolver can supply, with the total cost. Makes no provider calls. An item whose
 * request is not plain JSON is `invalid`, with no cost, and the other items still plan.
 * Throws a `GenerationError` if planning an item fails in any other way.
 */
export async function planGeneration(
  scenario: Scenario,
  cache: AssetCache,
  resolvers: readonly AssetResolver[],
  options: GenerationOptions = {},
): Promise<GenerationPlan> {
  const ctx: ResolveContext = { scenario, cache, purpose: "generate" };
  const items: PlannedItem[] = [];
  const cost: Cost = { characters: 0, requests: 0 };
  const counted = new Set<string>();
  for (const item of selectItems(scenario, options)) {
    const planned = await planItem(item, ctx, resolvers);
    if (planned.status === "to-generate" && !(planned.key && counted.has(planned.key))) {
      if (planned.key) counted.add(planned.key);
      cost.characters += planned.cost.characters;
      cost.requests += planned.cost.requests;
    }
    items.push(planned);
  }
  return { items, cost };
}

/**
 * Plans every item for playback: like `planGeneration`, but a generated asset for the same
 * request counts whichever provider made it, so a project generated with one provider plays
 * with the resolvers of another. Used by the timeline. Throws a `GenerationError` if planning
 * an item fails.
 */
export async function planPlayback(
  scenario: Scenario,
  cache: AssetCache,
  resolvers: readonly AssetResolver[],
): Promise<PlannedItem[]> {
  const ctx: ResolveContext = { scenario, cache, purpose: "playback" };
  const items: PlannedItem[] = [];
  for (const item of scenarioItems(scenario)) items.push(await planItem(item, ctx, resolvers));
  return items;
}

export type ItemResult = {
  id: string;
  kind: ScenarioItemKind;
  sceneId: string;
  resolver?: string;
} & (
  | { status: "cached" | "generated"; file: string; durationSec: number }
  | { status: "unresolved"; reason: string }
  | { status: "failed"; error: GenerationError }
);

export type GenerationResult = {
  /** One result per item, in scenario order. */
  items: ItemResult[];
  /** Number of items that failed. */
  failed: number;
};

export type RunGenerationOptions = GenerationOptions & {
  /** Maximum number of requests at once. Defaults to and is capped at 4. */
  concurrency?: number;
  /** Called as each item finishes, in completion order. */
  onItem?: (result: ItemResult) => void;
  /**
   * The most the run may send to paid providers, by their estimates. Every paid call reserves
   * its cost before it is sent, retries included (see `GenerationBudget`). An item whose call
   * would exceed what is left fails with a `BudgetExceededError` as the cause, and no call is
   * made. Calls to free providers are not counted. Without it, there is no limit.
   */
  budget?: Cost;
};

/**
 * Generates every item that is not cached, running at most 4 requests at once. Each asset and
 * the cache are written as soon as the asset is ready, so an interrupted run keeps its
 * progress. The provider of each generated or cached asset the run visits is recorded in
 * credits.json as soon as the item is done, and at the end so is the provider of every
 * asset the scenario plays, with its license from the first resolver that has a license
 * registry (see `recordProvider`). A failed item does not stop the others: it is reported in
 * its result with a `GenerationError`. With a `budget`, paid calls stop at it: the run plans
 * each item again as it goes, so the budget, not an earlier plan, is what limits the spending.
 * Throws only for invalid options.
 */
export async function runGeneration(
  scenario: Scenario,
  cache: AssetCache,
  resolvers: readonly AssetResolver[],
  options: RunGenerationOptions = {},
): Promise<GenerationResult> {
  const ctx: ResolveContext = { scenario, cache, purpose: "generate" };
  if (options.budget) ctx.budget = new GenerationBudget(options.budget);
  const targets = selectItems(scenario, options);
  const requested = Math.floor(options.concurrency ?? GENERATION_CONCURRENCY);
  const concurrency = Number.isNaN(requested)
    ? GENERATION_CONCURRENCY
    : Math.max(1, Math.min(GENERATION_CONCURRENCY, requested));
  const results: ItemResult[] = new Array(targets.length);
  let next = 0;
  let registry: Promise<LicenseRegistry | undefined> | undefined;
  const licenses = () => {
    registry ??= licenseRegistry(resolvers, ctx);
    return registry;
  };

  const worker = async () => {
    while (next < targets.length) {
      const index = next++;
      const item = targets[index] as ScenarioItem;
      const result = await runItem(item, ctx, resolvers, licenses);
      results[index] = result;
      options.onItem?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  // The run may not visit every item, such as with `only`, so the providers of every asset
  // the scenario plays are credited too, including ones cached before.
  try {
    await recordPlayedProviders(cache.projectDir, scenario, cache, licenses);
  } catch {
    // Left to the license check, which counts an unrecorded provider's terms as unknown.
  }
  return { items: results, failed: results.filter((r) => r.status === "failed").length };
}

export type RecordCachedProvidersOptions = {
  scenario: Scenario;
  /** The project's cache, if already loaded. Defaults to `<projectDir>/cache.json`. */
  cache?: AssetCache;
  /** The license of each provider comes from the first of these that has a license registry. */
  resolvers?: readonly AssetResolver[];
};

/**
 * Records in credits.json the provider of every generated asset the scenario plays, read from
 * cache.json, as `runGeneration` does at the end of a run, but without generating anything.
 * For a run with nothing to generate. Returns the providers recorded, as `playedProviders`
 * lists them. Throws if cache.json or credits.json cannot be read or written.
 */
export async function recordCachedProviders(
  projectDir: string,
  options: RecordCachedProvidersOptions,
): Promise<ProviderUse[]> {
  const { scenario, resolvers = [] } = options;
  const cache = options.cache ?? (await AssetCache.load(projectDir));
  const ctx: ResolveContext = { scenario, cache, purpose: "generate" };
  let registry: Promise<LicenseRegistry | undefined> | undefined;
  return recordPlayedProviders(projectDir, scenario, cache, () => {
    registry ??= licenseRegistry(resolvers, ctx);
    return registry;
  });
}

async function recordPlayedProviders(
  projectDir: string,
  scenario: Scenario,
  cache: AssetCache,
  licenses: () => Promise<LicenseRegistry | undefined>,
): Promise<ProviderUse[]> {
  const uses = await playedProviders(scenario, cache);
  for (const use of uses) {
    await recordProvider(projectDir, use.providerId, use.kind, await licenses());
  }
  return uses;
}

/**
 * The license registry of the first resolver that has one. A resolver whose registry cannot be
 * read, such as from a broken library, is skipped for the next one. If none has one, provider
 * records keep their licenses.
 */
async function licenseRegistry(
  resolvers: readonly AssetResolver[],
  ctx: ResolveContext,
): Promise<LicenseRegistry | undefined> {
  for (const resolver of resolvers) {
    try {
      const registry = await resolver.licenseRegistry?.(ctx);
      if (registry) return registry;
    } catch {
      // Try the next resolver.
    }
  }
  return undefined;
}

/**
 * Records in credits.json the provider of the generated asset with cache key `key`, if any, so
 * that the license check and the credits cover it. Library copies have no key.
 */
async function creditProvider(
  key: string | undefined,
  ctx: ResolveContext,
  licenses: () => Promise<LicenseRegistry | undefined>,
): Promise<void> {
  const entry = key === undefined ? undefined : ctx.cache.get(key);
  if (!entry || entry.providerId === MOCK_PROVIDER_ID) return;
  await recordProvider(ctx.cache.projectDir, entry.providerId, entry.kind, await licenses());
}

async function runItem(
  item: ScenarioItem,
  ctx: ResolveContext,
  resolvers: readonly AssetResolver[],
  licenses: () => Promise<LicenseRegistry | undefined>,
): Promise<ItemResult> {
  const base = { id: item.id, kind: item.kind, sceneId: item.scene.id };
  const resolver = resolvers.find((r) => r.handles(item));
  if (!resolver) return { ...base, status: "unresolved", reason: NO_RESOLVER };
  const withResolver = { ...base, resolver: resolver.id };
  let planned: PlannedAsset;
  try {
    planned = checkedPlan(item, await resolver.plan(item, ctx));
  } catch (e) {
    return { ...withResolver, status: "failed", error: new GenerationError(item, "plan", e) };
  }
  // Only a to-generate item is generated; every other status returns here.
  switch (planned.status) {
    case "to-generate":
      break;
    case "cached":
      try {
        await creditProvider(planned.key, ctx, licenses);
      } catch (e) {
        return {
          ...withResolver,
          status: "failed",
          error: new GenerationError(item, "generate", e),
        };
      }
      return {
        ...withResolver,
        status: "cached",
        file: planned.file,
        durationSec: planned.durationSec,
      };
    case "unresolved":
      return { ...withResolver, status: "unresolved", reason: planned.reason };
    // "invalid", and any status checkedPlan missed, so that nothing unknown is generated.
    default:
      // The cause is the fixed text, not the resolver's reason, which may hold request text.
      return {
        ...withResolver,
        status: "failed",
        error: new GenerationError(item, "plan", new Error(invalidReason(item))),
      };
  }
  try {
    const asset = await resolver.resolve(item, ctx);
    // A failed record fails the item, so that a paid asset never goes uncredited unnoticed.
    await creditProvider(asset.key, ctx, licenses);
    return {
      ...withResolver,
      status: asset.generated ? "generated" : "cached",
      file: asset.file,
      durationSec: asset.durationSec,
    };
  } catch (e) {
    return { ...withResolver, status: "failed", error: new GenerationError(item, "generate", e) };
  }
}

async function planItem(
  item: ScenarioItem,
  ctx: ResolveContext,
  resolvers: readonly AssetResolver[],
): Promise<PlannedItem> {
  const base = { id: item.id, kind: item.kind, sceneId: item.scene.id };
  const resolver = resolvers.find((r) => r.handles(item));
  if (!resolver) return { ...base, status: "unresolved", reason: NO_RESOLVER };
  try {
    return { ...base, resolver: resolver.id, ...checkedPlan(item, await resolver.plan(item, ctx)) };
  } catch (e) {
    // A request that cannot be keyed affects only its own item.
    if (isCanonicalJsonError(e)) {
      return { ...base, resolver: resolver.id, status: "invalid", reason: invalidReason(item) };
    }
    throw new GenerationError(item, "plan", e);
  }
}

const PLAN_STATUSES = new Set<string>(["cached", "to-generate", "unresolved", "invalid"]);

/**
 * The plan a resolver returned, or `invalid` with the fixed reason if its status is not one
 * this package knows, such as a status a resolver outside the package added later.
 */
function checkedPlan(item: ScenarioItem, planned: PlannedAsset): PlannedAsset {
  return PLAN_STATUSES.has(planned?.status)
    ? planned
    : { status: "invalid", reason: invalidReason(item) };
}

function selectItems(scenario: Scenario, options: GenerationOptions): ScenarioItem[] {
  const items = scenarioItems(scenario);
  if (!options.only) return items;
  const only = new Set(options.only);
  const unknown = [...only].filter((id) => !items.some((item) => item.id === id));
  if (unknown.length > 0) {
    throw new Error(`No item to generate has the ID ${unknown.map((id) => `"${id}"`).join(", ")}`);
  }
  return items.filter((item) => only.has(item.id));
}

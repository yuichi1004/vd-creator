// planGeneration and runGeneration. See "vd generate" in docs/plans/0004-providers-and-generation.md.

import type { Cost } from "@vd-creator/providers";
import type { Scenario } from "@vd-creator/scenario";
import type { AssetCache } from "./cache.js";
import { itemLabel, type ScenarioItem, type ScenarioItemKind, scenarioItems } from "./items.js";
import type { AssetResolver, PlannedAsset, ResolveContext } from "./resolver.js";

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

/**
 * Plans the generation of a scenario: which items are cached, which would be generated, and
 * which no resolver can supply, with the total cost. Makes no provider calls.
 * Throws a `GenerationError` if planning an item fails.
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
};

/**
 * Generates every item that is not cached, running at most 4 requests at once. Each asset and
 * the cache are written as soon as the asset is ready, so an interrupted run keeps its
 * progress. A failed item does not stop the others: it is reported in its result with a
 * `GenerationError`. Throws only for invalid options.
 */
export async function runGeneration(
  scenario: Scenario,
  cache: AssetCache,
  resolvers: readonly AssetResolver[],
  options: RunGenerationOptions = {},
): Promise<GenerationResult> {
  const ctx: ResolveContext = { scenario, cache, purpose: "generate" };
  const targets = selectItems(scenario, options);
  const requested = Math.floor(options.concurrency ?? GENERATION_CONCURRENCY);
  const concurrency = Number.isNaN(requested)
    ? GENERATION_CONCURRENCY
    : Math.max(1, Math.min(GENERATION_CONCURRENCY, requested));
  const results: ItemResult[] = new Array(targets.length);
  let next = 0;

  const worker = async () => {
    while (next < targets.length) {
      const index = next++;
      const item = targets[index] as ScenarioItem;
      const result = await runItem(item, ctx, resolvers);
      results[index] = result;
      options.onItem?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return { items: results, failed: results.filter((r) => r.status === "failed").length };
}

async function runItem(
  item: ScenarioItem,
  ctx: ResolveContext,
  resolvers: readonly AssetResolver[],
): Promise<ItemResult> {
  const base = { id: item.id, kind: item.kind, sceneId: item.scene.id };
  const resolver = resolvers.find((r) => r.handles(item));
  if (!resolver) return { ...base, status: "unresolved", reason: NO_RESOLVER };
  const withResolver = { ...base, resolver: resolver.id };
  let planned: PlannedAsset;
  try {
    planned = await resolver.plan(item, ctx);
  } catch (e) {
    return { ...withResolver, status: "failed", error: new GenerationError(item, "plan", e) };
  }
  if (planned.status === "unresolved") {
    return { ...withResolver, status: "unresolved", reason: planned.reason };
  }
  if (planned.status === "cached") {
    return {
      ...withResolver,
      status: "cached",
      file: planned.file,
      durationSec: planned.durationSec,
    };
  }
  try {
    const asset = await resolver.resolve(item, ctx);
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
    return { ...base, resolver: resolver.id, ...(await resolver.plan(item, ctx)) };
  } catch (e) {
    throw new GenerationError(item, "plan", e);
  }
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

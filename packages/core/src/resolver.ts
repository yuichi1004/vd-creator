// Asset resolvers: the pipeline asks them for each item's asset. This file has the hook and
// the resolver for generated items. See "Asset resolvers" in
// docs/plans/0004-providers-and-generation.md.

import type { LicenseRegistry } from "@vd-creator/library";
import type { AudioResult, Cost, ProviderSet } from "@vd-creator/providers";
import type { Scenario } from "@vd-creator/scenario";
import { type AssetCache, assetFileFor } from "./cache.js";
import { cacheKey } from "./canonical.js";
import { type GenerationRequest, generationRequest, type ScenarioItem } from "./items.js";

export type ResolveContext = {
  scenario: Scenario;
  cache: AssetCache;
  /**
   * Why the asset is wanted. "generate" (the default) is for `planGeneration` and
   * `runGeneration`: a generated asset counts only if it comes from the chosen provider.
   * "playback" is for the timeline and anything else that plays assets: an asset for the same
   * request from any provider counts. Resolvers whose assets do not depend on a provider,
   * such as a library resolver, can ignore it.
   */
  purpose?: "generate" | "playback";
  /**
   * What the run may still spend on paid providers, if it has a limit. A resolver must
   * `reserve` the cost of each call to a paid provider just before it sends the call, and send
   * nothing if that throws. Calls to free providers reserve nothing.
   */
  budget?: GenerationBudget;
};

/** Thrown by `GenerationBudget.reserve` when a call would go over the budget. */
export class BudgetExceededError extends Error {
  constructor() {
    super("The call would exceed the approved cost, so it was not sent");
    this.name = "BudgetExceededError";
  }
}

/**
 * The characters and requests a generation run may still spend on paid providers. Every call
 * reserves its estimated cost before it is sent, including a second call for a request whose
 * first call failed, so that the run never sends more than the budget allows. Reserving is
 * synchronous, so calls that run at once cannot both take the last of the budget.
 */
export class GenerationBudget {
  #left: Cost;

  constructor(budget: Cost) {
    const count = (n: number) => Number.isFinite(n) && n >= 0;
    if (!count(budget.characters) || !count(budget.requests)) {
      throw new Error("A generation budget must be two numbers, 0 or more");
    }
    this.#left = { characters: budget.characters, requests: budget.requests };
  }

  /** Takes `cost` from the budget, or throws a `BudgetExceededError` and takes nothing. */
  reserve(cost: Cost): void {
    if (cost.characters > this.#left.characters || cost.requests > this.#left.requests) {
      throw new BudgetExceededError();
    }
    this.#left.characters -= cost.characters;
    this.#left.requests -= cost.requests;
  }
}

export type PlannedAsset =
  | { status: "cached"; key?: string; file: string; durationSec: number }
  | { status: "to-generate"; key?: string; cost: Cost }
  | { status: "unresolved"; reason: string }
  /**
   * The item's request cannot be keyed, such as a line whose speaker settings hold a
   * non-finite number or a cycle. The pipeline sets this status when `plan` throws the
   * `canonicalJson` error, and a resolver may also return it. The item is never generated: a
   * generation run reports it as failed. The reason names only the item, never its request.
   */
  | { status: "invalid"; reason: string };

export type ResolvedAsset = {
  key?: string;
  file: string;
  durationSec: number;
  /** True if this call generated the asset, false if it was already there. */
  generated: boolean;
};

export interface AssetResolver {
  /** A short name for reports, such as "generated". */
  readonly id: string;
  handles(item: ScenarioItem): boolean;
  plan(item: ScenarioItem, ctx: ResolveContext): Promise<PlannedAsset>;
  resolve(item: ScenarioItem, ctx: ResolveContext): Promise<ResolvedAsset>;
  /**
   * The license registry that `runGeneration` copies provider licenses from into credits.json,
   * if this resolver knows one, such as the library resolver. Optional.
   */
  licenseRegistry?(ctx: ResolveContext): Promise<LicenseRegistry | undefined>;
}

/**
 * Resolves lines, prompt SFX, and prompt BGM by generating them with one provider set, and
 * caches them by content. Identical requests that run at the same time share one call. A
 * request whose call failed is called again by the next item that asks for it, and with a
 * budget in the context that call reserves its cost again.
 */
export class GeneratedItemResolver implements AssetResolver {
  readonly id = "generated";
  readonly providers: ProviderSet;
  #inFlight = new Map<string, Promise<ResolvedAsset>>();

  constructor(providers: ProviderSet) {
    this.providers = providers;
  }

  handles(item: ScenarioItem): boolean {
    switch (item.kind) {
      case "line":
        return true;
      case "sfx":
        return typeof item.item.sfx === "string";
      case "bgm":
        return "prompt" in item.bgm;
    }
  }

  async plan(item: ScenarioItem, ctx: ResolveContext): Promise<PlannedAsset> {
    const { gen, providerId } = this.#request(item, ctx);
    const strictKey = cacheKey(gen.kind, providerId, gen.request);
    // For playback, the key is that of the entry found, which may be another provider's.
    const found =
      ctx.purpose === "playback"
        ? await ctx.cache.playbackAsset(gen.kind, gen.request)
        : await ctx.cache
            .cachedAsset(strictKey)
            .then((entry) => entry && { key: strictKey, entry });
    if (found) {
      const { key, entry } = found;
      return { status: "cached", key, file: entry.file, durationSec: entry.durationSec };
    }
    return { status: "to-generate", key: strictKey, cost: this.#estimate(gen) };
  }

  async resolve(item: ScenarioItem, ctx: ResolveContext): Promise<ResolvedAsset> {
    const { gen, providerId } = this.#request(item, ctx);
    const key = cacheKey(gen.kind, providerId, gen.request);
    const running = this.#inFlight.get(key);
    if (running) return { ...(await running), generated: false };
    const run = this.#generate(key, gen, providerId, ctx);
    this.#inFlight.set(key, run);
    try {
      return await run;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #generate(
    key: string,
    gen: GenerationRequest,
    providerId: string,
    ctx: ResolveContext,
  ): Promise<ResolvedAsset> {
    const existing = await ctx.cache.cachedAsset(key);
    if (existing) {
      return { key, file: existing.file, durationSec: existing.durationSec, generated: false };
    }
    // Reserved after the cache check and right before the call, so that a call is never sent
    // without its cost taken from the budget.
    if (this.#provider(gen).paid) ctx.budget?.reserve(this.#estimate(gen));
    const audio = await this.#call(gen);
    const file = assetFileFor(gen.kind, key, audio.format);
    await ctx.cache.writeAsset(file, audio.data);
    ctx.cache.set(key, {
      kind: gen.kind,
      file,
      providerId,
      request: gen.request,
      durationSec: audio.durationSec,
      createdAt: new Date().toISOString(),
    });
    await ctx.cache.save();
    return { key, file, durationSec: audio.durationSec, generated: true };
  }

  #request(
    item: ScenarioItem,
    ctx: ResolveContext,
  ): { gen: GenerationRequest; providerId: string } {
    const gen = generationRequest(ctx.scenario, item);
    if (!gen)
      throw new Error(`The generated-item resolver does not handle ${item.kind} "${item.id}"`);
    return { gen, providerId: this.#provider(gen).id };
  }

  #provider(gen: GenerationRequest) {
    return gen.kind === "tts"
      ? this.providers.tts
      : gen.kind === "sfx"
        ? this.providers.sfx
        : this.providers.music;
  }

  #estimate(gen: GenerationRequest): Cost {
    switch (gen.kind) {
      case "tts":
        return this.providers.tts.estimate(gen.request);
      case "sfx":
        return this.providers.sfx.estimate(gen.request);
      case "music":
        return this.providers.music.estimate(gen.request);
    }
  }

  #call(gen: GenerationRequest): Promise<AudioResult> {
    switch (gen.kind) {
      case "tts":
        return this.providers.tts.synthesize(gen.request);
      case "sfx":
        return this.providers.sfx.generate(gen.request);
      case "music":
        return this.providers.music.generate(gen.request);
    }
  }
}

/** The resolvers this plan ships: only the generated-item resolver. */
export function defaultResolvers(providers: ProviderSet): AssetResolver[] {
  return [new GeneratedItemResolver(providers)];
}

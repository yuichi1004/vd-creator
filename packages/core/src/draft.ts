// Whether the audio of an item is draft or final. See "Draft audio" in
// docs/plans/0015-change-log-and-draft-audio.md.

import { MOCK_PROVIDER_ID } from "@vd-creator/library";
import type { Scenario } from "@vd-creator/scenario";
import type { AssetCache } from "./cache.js";
import { isCanonicalJsonError } from "./canonical.js";
import {
  generationRequest,
  type ScenarioItem,
  type ScenarioItemKind,
  scenarioItems,
  UnknownSpeakerError,
} from "./items.js";
import { libraryRef } from "./library/project.js";

/**
 * Draft audio comes from the free provider, `mock`, and is a test tone. Final audio is anything
 * else.
 */
export type AudioKind = "draft" | "final";

/** The kind of an asset made by a provider. */
export function audioKindOf(providerId: string): AudioKind {
  return providerId === MOCK_PROVIDER_ID ? "draft" : "final";
}

/**
 * The kind of the audio an item plays: a library sound is final, and a generated item takes the
 * kind of the asset that playback picks for it, from any provider. `null` if the item has no
 * asset yet, or its request cannot be built, because a line names an unknown speaker, or cannot
 * be keyed, because it is not plain JSON.
 */
export async function itemAudioKind(
  scenario: Scenario,
  cache: AssetCache,
  item: ScenarioItem,
): Promise<AudioKind | null> {
  if (libraryRef(item)) return "final";
  try {
    const gen = generationRequest(scenario, item);
    const found = gen && (await cache.playbackAsset(gen.kind, gen.request));
    return found ? audioKindOf(found.entry.providerId) : null;
  } catch (e) {
    if (e instanceof UnknownSpeakerError || isCanonicalJsonError(e)) return null;
    throw e;
  }
}

export type ItemAudioKind = {
  kind: ScenarioItemKind;
  /** A BGM uses the ID of its scene. */
  id: string;
  sceneId: string;
  audio: AudioKind | null;
};

/** The audio kind of every item that needs an asset, in scenario order. */
export async function scenarioAudioKinds(
  scenario: Scenario,
  cache: AssetCache,
): Promise<ItemAudioKind[]> {
  const out: ItemAudioKind[] = [];
  for (const item of scenarioItems(scenario)) {
    out.push({
      kind: item.kind,
      id: item.id,
      sceneId: item.scene.id,
      audio: await itemAudioKind(scenario, cache, item),
    });
  }
  return out;
}

/** The items whose audio is draft, in scenario order. */
export async function draftItems(scenario: Scenario, cache: AssetCache): Promise<ItemAudioKind[]> {
  return (await scenarioAudioKinds(scenario, cache)).filter((i) => i.audio === "draft");
}

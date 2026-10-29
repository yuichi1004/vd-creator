// Timeline computation: the start time and duration of every item.
// See "Timeline" in docs/plans/0004-providers-and-generation.md.

import type { ItemKind, Scenario } from "@vd-creator/scenario";
import type { AssetCache } from "./cache.js";
import { type PlannedItem, planPlayback } from "./generate.js";
import type { AssetResolver } from "./resolver.js";

/** Speaking rate used to estimate the length of a line that has no asset yet. */
export const ESTIMATED_CHARS_PER_SEC = 15;
export const ESTIMATED_LINE_MIN_SEC = 0.5;
/** Estimated length of an SFX without an asset or a requested duration. */
export const ESTIMATED_SFX_SEC = 1.5;

export type TimelineItem = {
  /** Absent for pauses and images without an ID. */
  id?: string;
  kind: ItemKind;
  sceneId: string;
  /** Position of the item in its scene's `items`. */
  index: number;
  startSec: number;
  durationSec: number;
  /** Asset file relative to assets/: the audio of a line or SFX, or the image file. */
  assetFile?: string;
  /** True if the audio has no asset yet; `durationSec` is then an estimate. */
  missing?: true;
  /** True if no resolver can supply the audio, such as a library sound without a library resolver. */
  unresolved?: true;
};

export type ImageSpan = {
  imageId: string;
  file?: string;
  startSec: number;
  endSec: number;
};

export type BgmSpan = {
  sceneId: string;
  volume: number;
  startSec: number;
  endSec: number;
  assetFile?: string;
  /** Length of the asset, which loops over the span. Absent when it is missing. */
  assetDurationSec?: number;
  missing?: true;
  unresolved?: true;
};

export type SceneSpan = { sceneId: string; startSec: number; endSec: number };

export type Timeline = {
  items: TimelineItem[];
  images: ImageSpan[];
  bgm: BgmSpan[];
  scenes: SceneSpan[];
  durationSec: number;
};

/**
 * Lays the scenario out in time. Items play in order, each after the previous one ends plus
 * its `gapBeforeSec`, which may be negative to overlap. An SFX with `overlap: true` plays
 * from its start time but does not move the next item. The order continues across scenes.
 * Items without an asset get an estimated duration and `missing: true`.
 *
 * Assets come from `planPlayback` with the given resolvers. A generated asset counts whichever
 * provider made it, so a project generated with one provider still plays when the resolvers
 * use another, such as the mock. Throws a `GenerationError` if planning fails.
 */
export async function computeTimeline(
  scenario: Scenario,
  cache: AssetCache,
  resolvers: readonly AssetResolver[],
): Promise<Timeline> {
  // A BGM uses its scene's ID, and IDs are unique in a scenario, so one map holds both.
  const plans = new Map<string, PlannedItem>();
  for (const planned of await planPlayback(scenario, cache, resolvers)) {
    plans.set(planned.id, planned);
  }
  const lookup = (
    id: string,
  ): { asset?: { file: string; durationSec: number }; unresolved?: true } => {
    const planned = plans.get(id);
    if (planned?.status === "cached") {
      return { asset: { file: planned.file, durationSec: planned.durationSec } };
    }
    return planned?.status === "to-generate" ? {} : { unresolved: true };
  };

  const items: TimelineItem[] = [];
  const images: ImageSpan[] = [];
  const bgm: BgmSpan[] = [];
  const scenes: SceneSpan[] = [];
  let cursor = 0;
  let end = 0;

  for (const scene of scenario.scenes) {
    const sceneStart = cursor;
    let sceneFirst = cursor;
    let sceneEnd = cursor;
    scene.items.forEach((item, index) => {
      const startSec = Math.max(0, cursor + item.gapBeforeSec);
      const base = { sceneId: scene.id, index, startSec };
      let entry: TimelineItem;
      if ("line" in item || "sfx" in item) {
        const { asset, unresolved } = lookup(item.id);
        entry = { ...base, id: item.id, kind: "line" in item ? "line" : "sfx", durationSec: 0 };
        if (asset) {
          entry.durationSec = asset.durationSec;
          entry.assetFile = asset.file;
        } else {
          entry.durationSec =
            "line" in item ? estimateLine(item.line) : (item.durationSec ?? ESTIMATED_SFX_SEC);
          entry.missing = true;
          if (unresolved) entry.unresolved = true;
        }
      } else if ("pause" in item) {
        entry = { ...base, id: item.id, kind: "pause", durationSec: item.pause };
      } else {
        // An image takes no time. A negative gap may place it before the previous image, so
        // its start is clamped to the previous image's start, which keeps every span from
        // ending before it starts. A span left with zero length is dropped below. The clamp
        // changes only the image, not the start of the items after it.
        const previous = images.at(-1);
        const imageStart = previous ? Math.max(startSec, previous.startSec) : startSec;
        if (previous) previous.endSec = imageStart;
        const file = scenario.images.find((i) => i.id === item.image)?.file;
        entry = {
          ...base,
          startSec: imageStart,
          id: item.id,
          kind: "image",
          durationSec: 0,
          assetFile: file,
        };
        images.push({ imageId: item.image, file, startSec: imageStart, endSec: imageStart });
      }
      if (entry.id === undefined) delete entry.id;
      if (entry.assetFile === undefined) delete entry.assetFile;
      items.push(entry);

      // The cursor follows the unclamped start, so an image clamp never moves later items.
      if (!("sfx" in item && item.overlap)) cursor = startSec + entry.durationSec;
      sceneFirst = Math.min(sceneFirst, entry.startSec);
      sceneEnd = Math.max(sceneEnd, entry.startSec + entry.durationSec, cursor);
    });
    const span = {
      sceneId: scene.id,
      startSec: Math.min(sceneStart, sceneFirst),
      endSec: sceneEnd,
    };
    scenes.push(span);
    end = Math.max(end, sceneEnd);

    if (scene.bgm) {
      const { asset, unresolved } = lookup(scene.id);
      const bgmSpan: BgmSpan = {
        sceneId: scene.id,
        volume: scene.bgm.volume,
        startSec: span.startSec,
        endSec: span.endSec,
      };
      if (asset) {
        bgmSpan.assetFile = asset.file;
        bgmSpan.assetDurationSec = asset.durationSec;
      } else {
        bgmSpan.missing = true;
        if (unresolved) bgmSpan.unresolved = true;
      }
      bgm.push(bgmSpan);
    }
  }

  const lastImage = images.at(-1);
  if (lastImage) lastImage.endSec = Math.max(lastImage.startSec, end);
  return {
    items,
    images: images.filter((span) => span.endSec > span.startSec),
    bgm,
    scenes,
    durationSec: end,
  };
}

function estimateLine(text: string): number {
  return Math.max(ESTIMATED_LINE_MIN_SEC, [...text].length / ESTIMATED_CHARS_PER_SEC);
}

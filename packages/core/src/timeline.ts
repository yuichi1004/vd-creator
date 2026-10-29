// Timeline computation: the start time and duration of every item.
// See "Timeline" in docs/plans/0004-providers-and-generation.md.

import type { ItemKind, Scenario } from "@vd-creator/scenario";
import type { AssetCache } from "./cache.js";
import { generationRequest, type ScenarioItem } from "./items.js";

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
  /** True if no resolver can supply the audio, such as a library sound before 0007. */
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

export type TimelineOptions = {
  /** Use only assets from this provider. By default the newest asset from any provider is used. */
  providerId?: string;
};

/**
 * Lays the scenario out in time. Items play in order, each after the previous one ends plus
 * its `gapBeforeSec`, which may be negative to overlap. An SFX with `overlap: true` plays
 * from its start time but does not move the next item. The order continues across scenes.
 * Items without an asset get an estimated duration and `missing: true`.
 */
export function computeTimeline(
  scenario: Scenario,
  cache: AssetCache,
  options: TimelineOptions = {},
): Timeline {
  const lookup = (
    target: ScenarioItem,
  ): { asset?: { file: string; durationSec: number }; unresolved?: true } => {
    const gen = generationRequest(scenario, target);
    if (!gen) return { unresolved: true };
    const entry = cache.findByRequest(gen.kind, gen.request, options.providerId);
    return entry ? { asset: { file: entry.file, durationSec: entry.durationSec } } : {};
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
        const target: ScenarioItem =
          "line" in item
            ? { kind: "line", id: item.id, scene, item }
            : { kind: "sfx", id: item.id, scene, item };
        const { asset, unresolved } = lookup(target);
        entry = { ...base, id: item.id, kind: target.kind, durationSec: 0 };
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
        const file = scenario.images.find((i) => i.id === item.image)?.file;
        entry = { ...base, id: item.id, kind: "image", durationSec: 0, assetFile: file };
        const previous = images.at(-1);
        if (previous) previous.endSec = startSec;
        images.push({ imageId: item.image, file, startSec, endSec: startSec });
      }
      if (entry.id === undefined) delete entry.id;
      if (entry.assetFile === undefined) delete entry.assetFile;
      items.push(entry);

      const itemEnd = startSec + entry.durationSec;
      if (!("sfx" in item && item.overlap)) cursor = itemEnd;
      sceneFirst = Math.min(sceneFirst, startSec);
      sceneEnd = Math.max(sceneEnd, itemEnd, cursor);
    });
    const span = {
      sceneId: scene.id,
      startSec: Math.min(sceneStart, sceneFirst),
      endSec: sceneEnd,
    };
    scenes.push(span);
    end = Math.max(end, sceneEnd);

    if (scene.bgm) {
      const { asset, unresolved } = lookup({ kind: "bgm", id: scene.id, scene, bgm: scene.bgm });
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
  return { items, images, bgm, scenes, durationSec: end };
}

function estimateLine(text: string): number {
  return Math.max(ESTIMATED_LINE_MIN_SEC, [...text].length / ESTIMATED_CHARS_PER_SEC);
}

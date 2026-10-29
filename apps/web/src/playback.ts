// Playback scheduling from a timeline, without any audio API, so that it can be tested.
// See "UI" in docs/plans/0005-review-ui.md: play all, play from an item, and stop, with BGM
// looping under its scene.

import type { ImageSpan, Timeline, TimelineItem } from "./types.js";

/** One sound to start, in timeline seconds. */
export type ScheduledSound = {
  /** Stable key of the sound, unique in one schedule. */
  key: string;
  /** Asset file, relative to `assets/`. */
  file: string;
  /** Timeline time at which the sound starts, at or after the playback start. */
  atSec: number;
  /** Where to start inside the audio file. */
  offsetSec: number;
  /** How long to play from `offsetSec`. */
  durationSec: number;
  /** Loop the file, for BGM. `offsetSec` is then within one loop. */
  loop: boolean;
  /** Volume, 0 to 1. */
  gain: number;
};

/**
 * The sounds to play when playback starts at `fromSec`, sorted by start time. A sound that
 * started before `fromSec` and is still playing starts at `fromSec`, part way in. Items
 * without an asset are skipped, so a missing line plays as silence of its estimated length.
 */
export function scheduleFrom(timeline: Timeline, fromSec: number): ScheduledSound[] {
  const sounds: ScheduledSound[] = [];
  for (const item of timeline.items) {
    if (item.kind !== "line" && item.kind !== "sfx") continue;
    if (!item.assetFile || item.missing) continue;
    const endSec = item.startSec + item.durationSec;
    if (endSec <= fromSec) continue;
    const atSec = Math.max(item.startSec, fromSec);
    sounds.push({
      key: `item:${item.id ?? `${item.sceneId}/${item.index}`}`,
      file: item.assetFile,
      atSec,
      offsetSec: atSec - item.startSec,
      durationSec: endSec - atSec,
      loop: false,
      gain: 1,
    });
  }
  for (const span of timeline.bgm) {
    if (!span.assetFile || span.missing || !span.assetDurationSec) continue;
    if (span.endSec <= fromSec) continue;
    const atSec = Math.max(span.startSec, fromSec);
    sounds.push({
      key: `bgm:${span.sceneId}`,
      file: span.assetFile,
      atSec,
      offsetSec: (atSec - span.startSec) % span.assetDurationSec,
      durationSec: span.endSec - atSec,
      loop: true,
      gain: span.volume,
    });
  }
  return sounds.sort((a, b) => a.atSec - b.atSec || a.key.localeCompare(b.key));
}

/** The files to have decoded when the playback position is `atSec`: those playing or due soon. */
export function filesAround(
  sounds: readonly ScheduledSound[],
  atSec: number,
  aheadSec: number,
): string[] {
  const files = new Set<string>();
  for (const sound of sounds) {
    if (sound.atSec + sound.durationSec <= atSec) continue;
    if (sound.atSec > atSec + aheadSec) continue;
    files.add(sound.file);
  }
  return [...files];
}

/**
 * The image on screen at `atSec`, or undefined before the first image. Image spans follow
 * each other, and the last one stays on screen to the end.
 */
export function imageAt(timeline: Timeline, atSec: number): ImageSpan | undefined {
  let found: ImageSpan | undefined;
  for (const span of timeline.images) {
    if (span.startSec > atSec) break;
    found = span;
  }
  return found;
}

/**
 * The line, SFX, or pause playing at `atSec`, for highlighting. The one with the greatest
 * start wins, and on a tie the later one in scenario order.
 */
export function itemAt(timeline: Timeline, atSec: number): TimelineItem | undefined {
  let found: TimelineItem | undefined;
  for (const item of timeline.items) {
    if (item.kind !== "line" && item.kind !== "sfx" && item.kind !== "pause") continue;
    if (item.startSec > atSec || atSec >= item.startSec + item.durationSec) continue;
    if (!found || item.startSec >= found.startSec) found = item;
  }
  return found;
}

/** Start time of an item, for "play from here". */
export function startOf(timeline: Timeline, id: string): number | undefined {
  return timeline.items.find((item) => item.id === id)?.startSec;
}

/** Clamps a kept playback position to a (possibly changed) timeline. */
export function clampPosition(timeline: Timeline, positionSec: number): number {
  if (!Number.isFinite(positionSec) || positionSec < 0) return 0;
  return Math.min(positionSec, timeline.durationSec);
}

/** Formats seconds as m:ss. */
export function formatTime(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

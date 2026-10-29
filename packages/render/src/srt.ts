// Subtitles: one SRT cue per line. See "Subtitles" in docs/plans/0006-rendering.md.

import type { Timeline } from "@vd-creator/core";
import type { Scenario } from "@vd-creator/scenario";

/**
 * The SRT text of a timeline: one cue per line, in timeline order, from its `startSec` to the
 * end of its audio. A line without an asset keeps its place, with its estimated length. If the
 * lines have more than one speaker, every cue starts with the speaker's name. Blank lines in a
 * line's text are removed, because a blank line ends an SRT cue, and a line with only
 * whitespace has no cue.
 */
export function buildSrt(timeline: Timeline, scenario: Scenario): string {
  const names = new Map(scenario.speakers.map((s) => [s.id, s.name]));
  const cues: { startSec: number; endSec: number; speaker: string; text: string }[] = [];
  for (const item of timeline.items) {
    if (item.kind !== "line") continue;
    const source = scenario.scenes.find((s) => s.id === item.sceneId)?.items[item.index];
    if (!source || !("line" in source)) continue;
    const text = source.line
      .split(/\r?\n|\r/)
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .join("\n");
    // A cue with no text is malformed SRT.
    if (text === "") continue;
    cues.push({
      startSec: item.startSec,
      endSec: item.startSec + item.durationSec,
      speaker: source.speaker,
      text,
    });
  }
  const named = new Set(cues.map((c) => c.speaker)).size > 1;
  return cues
    .map((cue, i) => {
      const name = names.get(cue.speaker) ?? cue.speaker;
      const text = named ? `${name}: ${cue.text}` : cue.text;
      return `${i + 1}\n${srtTime(cue.startSec)} --> ${srtTime(cue.endSec)}\n${text}\n`;
    })
    .join("\n");
}

/** A time as `HH:MM:SS,mmm`. */
function srtTime(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(total % 1000, 3)}`;
}

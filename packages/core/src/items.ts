// The scenario items that need an audio asset, and the generation request for each.

import type { MusicRequest, SfxRequest, TtsRequest } from "@vd-creator/providers";
import type { Bgm, LineItem, Scenario, Scene, SfxItem } from "@vd-creator/scenario";

/** Length of generated BGM. It loops under the whole scene, so it does not follow the scene. */
export const BGM_DURATION_SEC = 30;

/**
 * A scenario item that needs an audio asset: a line, an SFX, or a scene's BGM. A BGM uses
 * the ID of its scene.
 */
export type ScenarioItem =
  | { kind: "line"; id: string; scene: Scene; item: LineItem }
  | { kind: "sfx"; id: string; scene: Scene; item: SfxItem }
  | { kind: "bgm"; id: string; scene: Scene; bgm: Bgm };

export type ScenarioItemKind = ScenarioItem["kind"];

/** The items that need an asset, in scenario order, each scene's BGM first. */
export function scenarioItems(scenario: Scenario): ScenarioItem[] {
  const out: ScenarioItem[] = [];
  for (const scene of scenario.scenes) {
    if (scene.bgm) out.push({ kind: "bgm", id: scene.id, scene, bgm: scene.bgm });
    for (const item of scene.items) {
      if ("line" in item) out.push({ kind: "line", id: item.id, scene, item });
      else if ("sfx" in item) out.push({ kind: "sfx", id: item.id, scene, item });
    }
  }
  return out;
}

export type GenerationRequest =
  | { kind: "tts"; request: TtsRequest }
  | { kind: "sfx"; request: SfxRequest }
  | { kind: "music"; request: MusicRequest };

/** Thrown by `generationRequest` when a line names a speaker the scenario does not have. */
export class UnknownSpeakerError extends Error {
  constructor(lineId: string) {
    super(`Line "${lineId}" names an unknown speaker`);
    this.name = "UnknownSpeakerError";
  }
}

/**
 * The provider request that generates an item, or `undefined` if the item is not generated,
 * such as a library sound. Throws an `UnknownSpeakerError` if a line names an unknown speaker.
 */
export function generationRequest(
  scenario: Scenario,
  target: ScenarioItem,
): GenerationRequest | undefined {
  switch (target.kind) {
    case "line": {
      const { item } = target;
      const speaker = scenario.speakers.find((s) => s.id === item.speaker);
      if (!speaker) throw new UnknownSpeakerError(item.id);
      return {
        kind: "tts",
        request: withoutUndefined({
          text: item.line,
          voiceId: speaker.voice.voiceId,
          direction: item.direction,
          settings: speaker.voice.settings,
          take: item.take,
        }),
      };
    }
    case "sfx": {
      const { item } = target;
      if (typeof item.sfx !== "string") return undefined;
      return {
        kind: "sfx",
        request: withoutUndefined({
          prompt: item.sfx,
          durationSec: item.durationSec,
          take: item.take,
        }),
      };
    }
    case "bgm": {
      if (!("prompt" in target.bgm)) return undefined;
      return {
        kind: "music",
        request: { prompt: target.bgm.prompt, durationSec: BGM_DURATION_SEC, take: 0 },
      };
    }
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** A label for messages, such as `line "s1-l1"`. It never contains the item's text. */
export function itemLabel(target: { kind: ScenarioItemKind; id: string }): string {
  return `${target.kind} "${target.id}"`;
}

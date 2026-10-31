import { expect, test } from "vitest";
import { ttsCall } from "./elevenlabs/api.js";
import { ElevenLabsTtsProvider } from "./elevenlabs/index.js";
import { MockTtsProvider } from "./mock.js";
import type { VoiceParameter } from "./types.js";

const elevenlabs = new ElevenLabsTtsProvider();
const mock = new MockTtsProvider();

const KEYS = ["stability", "similarityBoost", "style", "speed", "useSpeakerBoost"];

function byKey(parameters: VoiceParameter[] | undefined, key: string): VoiceParameter | undefined {
  return parameters?.find((p) => p.key === key);
}

test("ElevenLabs lists the five parameters it sends, with their ranges", () => {
  const parameters = elevenlabs.voiceParameters(undefined);
  expect(parameters.map((p) => p.key)).toEqual(KEYS);
  for (const key of ["stability", "similarityBoost", "style"]) {
    expect(byKey(parameters, key)).toMatchObject({ kind: "number", min: 0, max: 1, step: 0.05 });
  }
  expect(byKey(parameters, "speed")).toMatchObject({
    kind: "number",
    min: 0.7,
    max: 1.2,
    step: 0.05,
  });
  expect(byKey(parameters, "useSpeakerBoost")).toMatchObject({ kind: "on-off" });
});

test("every listed key is one that the ElevenLabs request sends", () => {
  const settings = {
    stability: 0.5,
    similarityBoost: 0.5,
    style: 0.5,
    speed: 1,
    useSpeakerBoost: true,
  };
  const sent = ttsCall({ text: "t", voiceId: "v", take: 0, settings }).body.voice_settings;
  expect(Object.keys(sent as object)).toHaveLength(KEYS.length);
});

test("eleven_v3 limits stability to 0, 0.5, and 1, and the other keys stay", () => {
  const parameters = elevenlabs.voiceParameters({ modelId: "eleven_v3" });
  expect(parameters.map((p) => p.key)).toEqual(KEYS);
  expect(byKey(parameters, "stability")).toMatchObject({ kind: "number", values: [0, 0.5, 1] });
  expect(byKey(parameters, "style")).toMatchObject({ min: 0, max: 1, step: 0.05 });
});

test("other models, and no model, keep the full stability range", () => {
  for (const settings of [{ modelId: "eleven_multilingual_v2" }, { modelId: "" }, {}]) {
    expect(byKey(elevenlabs.voiceParameters(settings), "stability")).toMatchObject({
      min: 0,
      max: 1,
      step: 0.05,
    });
  }
});

test("the mock lists the same five keys", () => {
  expect(mock.voiceParameters().map((p) => p.key)).toEqual(KEYS);
});

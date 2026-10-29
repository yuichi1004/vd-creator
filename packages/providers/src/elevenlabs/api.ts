// The ElevenLabs REST API shapes: endpoints, headers, and request bodies.
//
// Every field name and default that depends on the ElevenLabs API lives in this file, so that a
// change on their side, or a field that turns out to be wrong, is fixed in one place. These shapes
// follow the public API documentation and have not been checked against the live API yet.

import type { MusicRequest, SfxRequest, TtsRequest } from "../types.js";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";
export const ELEVENLABS_API_KEY_HEADER = "xi-api-key";
/** The response header with the request ID, kept in the result meta for support requests. */
export const ELEVENLABS_REQUEST_ID_HEADER = "request-id";

/** MP3 at 44.1 kHz and 128 kbps, which every plan supports. */
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";
export const ELEVENLABS_DEFAULT_TTS_MODEL = "eleven_multilingual_v2";
export const ELEVENLABS_DEFAULT_MUSIC_MODEL = "music_v1";

export type ApiCall = {
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
};

/**
 * TTS settings that a scenario may set, in camelCase, mapped to the API's voice_settings fields.
 * Other keys in TtsRequest.settings are ignored, except `modelId`.
 */
const VOICE_SETTINGS_FIELDS: Record<string, string> = {
  stability: "stability",
  similarityBoost: "similarity_boost",
  style: "style",
  useSpeakerBoost: "use_speaker_boost",
  speed: "speed",
};

/** POST /v1/text-to-speech/{voice_id} */
export function ttsCall(req: TtsRequest): ApiCall {
  const modelId = ttsModelId(req);
  const voiceSettings: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(VOICE_SETTINGS_FIELDS)) {
    const value = req.settings?.[key];
    if (value !== undefined) voiceSettings[field] = value;
  }
  const body: Record<string, unknown> = { text: ttsText(req), model_id: modelId };
  if (Object.keys(voiceSettings).length > 0) body.voice_settings = voiceSettings;
  return {
    path: `/v1/text-to-speech/${encodeURIComponent(req.voiceId)}`,
    query: { output_format: ELEVENLABS_OUTPUT_FORMAT },
    body,
  };
}

/** POST /v1/sound-generation */
export function sfxCall(req: SfxRequest): ApiCall {
  const body: Record<string, unknown> = { text: req.prompt };
  // Without a duration, ElevenLabs picks one from the prompt.
  if (req.durationSec !== undefined) body.duration_seconds = req.durationSec;
  return { path: "/v1/sound-generation", query: { output_format: ELEVENLABS_OUTPUT_FORMAT }, body };
}

/** POST /v1/music */
export function musicCall(req: MusicRequest): ApiCall {
  return {
    path: "/v1/music",
    query: { output_format: ELEVENLABS_OUTPUT_FORMAT },
    body: {
      prompt: req.prompt,
      music_length_ms: Math.round(req.durationSec * 1000),
      model_id: ELEVENLABS_DEFAULT_MUSIC_MODEL,
    },
  };
}

export function ttsModelId(req: TtsRequest): string {
  const modelId = req.settings?.modelId;
  return typeof modelId === "string" && modelId !== "" ? modelId : ELEVENLABS_DEFAULT_TTS_MODEL;
}

/**
 * The text sent for a line. Models that read inline audio tags (eleven_v3) get the stage
 * direction as a leading tag, such as "[whispers] ...". Other models get the text only.
 */
export function ttsText(req: TtsRequest): string {
  const direction = req.direction?.trim();
  if (direction && ttsModelId(req).startsWith("eleven_v3")) return `[${direction}] ${req.text}`;
  return req.text;
}

/**
 * The human-readable message of an error response body, or undefined if the body has none of
 * the known shapes: `{ detail: { message } }`, `{ detail: "..." }`, or, for validation errors,
 * `{ detail: [{ msg }] }`. Raw bodies are never returned, because they are untrusted.
 */
export function errorDetail(body: string): string | undefined {
  let detail: unknown;
  try {
    detail = (JSON.parse(body) as { detail?: unknown } | null)?.detail;
  } catch {
    return undefined;
  }
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail.flatMap((d) =>
      typeof d === "object" && d !== null && "msg" in d && typeof d.msg === "string" ? [d.msg] : [],
    );
    return messages.length > 0 ? messages.join("; ") : undefined;
  }
  if (typeof detail === "object" && detail !== null && "message" in detail) {
    return typeof detail.message === "string" ? detail.message : undefined;
  }
  return undefined;
}

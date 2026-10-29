// The ElevenLabs REST API shapes: endpoints, headers, and request bodies.
//
// Every field name and default that depends on the ElevenLabs API lives in this file, so that a
// change on their side, or a field that turns out to be wrong, is fixed in one place. These shapes
// follow the public API documentation and have not been checked against the live API yet.

import type { MusicRequest, SfxRequest, TtsRequest } from "../types.js";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";
export const ELEVENLABS_API_KEY_HEADER = "xi-api-key";
/** Voice and model IDs are plain tokens. Anything else is rejected before a request is sent. */
export const ELEVENLABS_ID_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

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
 * The model ID prefixes of the models that read inline audio tags, such as "[whispers]". This is
 * the only list of them. Nothing in this repository says which models read tags beyond
 * eleven_v3, so eleven_v4 is listed on the assumption that newer models keep reading them.
 * Check the list against the ElevenLabs documentation on audio tags when a model is added.
 */
export const ELEVENLABS_AUDIO_TAG_MODELS: readonly string[] = ["eleven_v3", "eleven_v4"];

/** True if the model reads inline audio tags, so a line's direction is sent as a tag. */
export function readsAudioTags(modelId: string): boolean {
  return ELEVENLABS_AUDIO_TAG_MODELS.some((prefix) => modelId.startsWith(prefix));
}

/**
 * The text sent for a line. Models that read inline audio tags get the stage direction as a
 * leading tag, such as "[whispers] ...". Other models get the text only.
 */
export function ttsText(req: TtsRequest): string {
  const direction = req.direction?.trim();
  if (direction && readsAudioTags(ttsModelId(req))) return `[${direction}] ${req.text}`;
  return req.text;
}

/** True if the request has a direction that its model cannot read, so it is not sent. */
export function dropsDirection(req: TtsRequest): boolean {
  return Boolean(req.direction?.trim()) && !readsAudioTags(ttsModelId(req));
}

/**
 * The error codes we recognize, with fixed English text. Only these reach an error message:
 * the response text itself is never shown.
 */
export const ELEVENLABS_API_ERRORS = {
  quota_exceeded: "quota exceeded",
  invalid_api_key: "invalid API key",
  missing_permissions: "the API key lacks a permission",
  voice_not_found: "voice not found",
  rate_limited: "rate limited",
  system_busy: "service busy",
  text_too_long: "text too long",
  unusual_activity: "unusual activity detected",
  validation_error: "request rejected as invalid",
  unknown: "unknown API error",
} as const;

export type ElevenLabsApiErrorCode = keyof typeof ELEVENLABS_API_ERRORS;

/** The `detail.status` values that ElevenLabs sends, mapped to our codes. */
const API_STATUS_CODES: Record<string, ElevenLabsApiErrorCode> = {
  quota_exceeded: "quota_exceeded",
  invalid_api_key: "invalid_api_key",
  missing_permissions: "missing_permissions",
  voice_not_found: "voice_not_found",
  too_many_concurrent_requests: "rate_limited",
  rate_limit_exceeded: "rate_limited",
  system_busy: "system_busy",
  max_character_limit_exceeded: "text_too_long",
  detected_unusual_activity: "unusual_activity",
};

/**
 * The code of an error response. ElevenLabs sends `{ detail: { status, message } }`, or, for
 * validation errors, `{ detail: [...] }`. Only an exact match from the list counts. A 429 with
 * no known code counts as rate limited. Anything else is "unknown".
 */
export function errorCode(body: string, httpStatus: number | undefined): ElevenLabsApiErrorCode {
  let detail: unknown;
  try {
    detail = (JSON.parse(body) as { detail?: unknown } | null)?.detail;
  } catch {
    detail = undefined;
  }
  if (typeof detail === "object" && detail !== null && !Array.isArray(detail)) {
    const status: unknown = (detail as { status?: unknown }).status;
    if (typeof status === "string" && Object.hasOwn(API_STATUS_CODES, status)) {
      return API_STATUS_CODES[status] ?? "unknown";
    }
  }
  if (Array.isArray(detail) && httpStatus === 422) return "validation_error";
  return httpStatus === 429 ? "rate_limited" : "unknown";
}

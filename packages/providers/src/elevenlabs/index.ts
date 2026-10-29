// ElevenLabs providers over the REST API with the built-in fetch. Each call costs real money,
// so these run only behind the cost gate of `vd generate`. Tests replace fetch.

import { registerProviders } from "../registry.js";
import type {
  AudioResult,
  Cost,
  MusicProvider,
  MusicRequest,
  ProviderSet,
  SfxProvider,
  SfxRequest,
  TtsProvider,
  TtsRequest,
} from "../types.js";
import {
  type ApiCall,
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_API_KEY_HEADER,
  ELEVENLABS_BASE_URL,
  ELEVENLABS_REQUEST_ID_HEADER,
  errorDetail,
  musicCall,
  sfxCall,
  ttsCall,
  ttsModelId,
  ttsText,
} from "./api.js";
import { mp3DurationSec } from "./mp3.js";

export const ELEVENLABS_PROVIDER_ID = "elevenlabs";

export type ElevenLabsOptions = {
  /** Where the API key is read from, at call time. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to the global fetch, looked up at call time. */
  fetch?: typeof fetch;
  baseUrl?: string;
};

const MAX_DETAIL_LENGTH = 300;
const MAX_LABEL_TEXT_LENGTH = 40;

export type ElevenLabsKind = "tts" | "sfx" | "music";

/**
 * A failed ElevenLabs call. It carries only safe data: the message names the item and the
 * reason with the API key redacted, and there is no cause, so the original error, Request,
 * or Response (and their headers) never travel with it.
 */
export class ElevenLabsError extends Error {
  override readonly name = "ElevenLabsError";

  constructor(
    message: string,
    readonly kind: ElevenLabsKind,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

class ElevenLabsClient {
  constructor(private readonly options: ElevenLabsOptions) {}

  /** Sends a call and returns the MP3 result. Errors start with `label`, which names the item. */
  async request(
    kind: ElevenLabsKind,
    label: string,
    call: ApiCall,
    meta: Record<string, unknown>,
  ): Promise<AudioResult> {
    const env = this.options.env ?? process.env;
    const apiKey = env[ELEVENLABS_API_KEY_ENV];
    const fail = (reason: string, status?: number, requestId?: string) =>
      new ElevenLabsError(redactSecrets(`${label}: ${reason}`, apiKey), kind, status, requestId);
    if (!apiKey) {
      throw fail(`${ELEVENLABS_API_KEY_ENV} is not set`);
    }
    const url = new URL(call.path, this.options.baseUrl ?? ELEVENLABS_BASE_URL);
    for (const [key, value] of Object.entries(call.query)) url.searchParams.set(key, value);
    const fetchFn = this.options.fetch ?? globalThis.fetch;

    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: {
          [ELEVENLABS_API_KEY_HEADER]: apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(call.body),
      });
    } catch (error) {
      throw fail(`network error: ${errorMessage(error)}`);
    }

    const requestId = response.headers.get(ELEVENLABS_REQUEST_ID_HEADER) ?? undefined;
    const requestIdNote = requestId ? ` (request ${requestId})` : "";
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Redact before truncating, so that a key cut in half cannot slip through.
      const detail = truncate(redactSecrets(errorDetail(body), apiKey).trim(), MAX_DETAIL_LENGTH);
      const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      throw fail(
        `${status}${requestIdNote}${detail ? `: ${detail}` : ""}`,
        response.status,
        requestId,
      );
    }

    let data: Uint8Array;
    try {
      data = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw fail(
        `network error while reading the audio${requestIdNote}: ${errorMessage(error)}`,
        response.status,
        requestId,
      );
    }
    let durationSec: number;
    try {
      durationSec = mp3DurationSec(data);
    } catch (error) {
      throw fail(
        `bad audio in the response${requestIdNote} (${data.length} bytes): ${errorMessage(error)}`,
        response.status,
        requestId,
      );
    }
    return {
      data,
      format: "mp3",
      durationSec,
      meta: { ...meta, provider: ELEVENLABS_PROVIDER_ID, ...(requestId ? { requestId } : {}) },
    };
  }
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly id = ELEVENLABS_PROVIDER_ID;
  readonly paid = true;
  private readonly client: ElevenLabsClient;

  constructor(options: ElevenLabsOptions = {}) {
    this.client = new ElevenLabsClient(options);
  }

  synthesize(req: TtsRequest): Promise<AudioResult> {
    const label = `ElevenLabs TTS failed for voice "${req.voiceId}", take ${req.take}, text ${quote(req.text)}`;
    return this.client.request("tts", label, ttsCall(req), {
      voiceId: req.voiceId,
      modelId: ttsModelId(req),
      take: req.take,
    });
  }

  /** ElevenLabs bills TTS by the characters sent, including a direction tag. */
  estimate(req: TtsRequest): Cost {
    return { characters: [...ttsText(req)].length, requests: 1 };
  }
}

export class ElevenLabsSfxProvider implements SfxProvider {
  readonly id = ELEVENLABS_PROVIDER_ID;
  readonly paid = true;
  private readonly client: ElevenLabsClient;

  constructor(options: ElevenLabsOptions = {}) {
    this.client = new ElevenLabsClient(options);
  }

  generate(req: SfxRequest): Promise<AudioResult> {
    const label = `ElevenLabs SFX failed for take ${req.take}, prompt ${quote(req.prompt)}`;
    return this.client.request("sfx", label, sfxCall(req), { take: req.take });
  }

  /** ElevenLabs bills SFX by duration or generation, not by prompt characters, so only the request counts. */
  estimate(_req: SfxRequest): Cost {
    return { characters: 0, requests: 1 };
  }
}

export class ElevenLabsMusicProvider implements MusicProvider {
  readonly id = ELEVENLABS_PROVIDER_ID;
  readonly paid = true;
  private readonly client: ElevenLabsClient;

  constructor(options: ElevenLabsOptions = {}) {
    this.client = new ElevenLabsClient(options);
  }

  generate(req: MusicRequest): Promise<AudioResult> {
    const label = `ElevenLabs music failed for take ${req.take}, prompt ${quote(req.prompt)}`;
    return this.client.request("music", label, musicCall(req), { take: req.take });
  }

  /** ElevenLabs bills music by duration or generation, not by prompt characters, so only the request counts. */
  estimate(_req: MusicRequest): Cost {
    return { characters: 0, requests: 1 };
  }
}

export function createElevenLabsProviders(options: ElevenLabsOptions = {}): ProviderSet {
  return {
    tts: new ElevenLabsTtsProvider(options),
    sfx: new ElevenLabsSfxProvider(options),
    music: new ElevenLabsMusicProvider(options),
  };
}

registerProviders(ELEVENLABS_PROVIDER_ID, () => createElevenLabsProviders());

function quote(text: string): string {
  return JSON.stringify(truncate(text, MAX_LABEL_TEXT_LENGTH));
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

const REDACTED = "[redacted]";
/** An xi-api-key header or field and its value, as it may appear in a message or echoed body. */
const API_KEY_VALUE = new RegExp(
  // The lookahead skips a value that is already redacted, so that redacting twice is harmless.
  `(${ELEVENLABS_API_KEY_HEADER}["']?\\s*[:=]\\s*["']?)(?!\\[redacted\\])[^\\s"',;}\\]]+`,
  "gi",
);

/** Removes the API key, and any value that follows an xi-api-key name, from a text. */
function redactSecrets(text: string, apiKey: string | undefined): string {
  const withoutKey = apiKey ? text.split(apiKey).join(REDACTED) : text;
  return withoutKey.replace(API_KEY_VALUE, `$1${REDACTED}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

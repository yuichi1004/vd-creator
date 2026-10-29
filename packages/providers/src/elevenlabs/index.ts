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

class ElevenLabsClient {
  constructor(private readonly options: ElevenLabsOptions) {}

  /** Sends a call and returns the MP3 result. Errors start with `label`, which names the item. */
  async request(label: string, call: ApiCall, meta: Record<string, unknown>): Promise<AudioResult> {
    const env = this.options.env ?? process.env;
    const apiKey = env[ELEVENLABS_API_KEY_ENV];
    if (!apiKey) {
      throw new Error(`${label}: ${ELEVENLABS_API_KEY_ENV} is not set`);
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
      throw new Error(`${label}: network error: ${errorMessage(error)}`, { cause: error });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = truncate(errorDetail(body).trim(), MAX_DETAIL_LENGTH);
      const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      throw new Error(`${label}: ${status}${detail ? `: ${detail}` : ""}`);
    }

    let data: Uint8Array;
    try {
      data = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new Error(`${label}: network error while reading the audio: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    let durationSec: number;
    try {
      durationSec = mp3DurationSec(data);
    } catch (error) {
      throw new Error(
        `${label}: bad audio in the response (${data.length} bytes): ${errorMessage(error)}`,
      );
    }
    const requestId = response.headers.get(ELEVENLABS_REQUEST_ID_HEADER);
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
    return this.client.request(label, ttsCall(req), {
      voiceId: req.voiceId,
      modelId: ttsModelId(req),
      take: req.take,
    });
  }

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
    return this.client.request(label, sfxCall(req), { take: req.take });
  }

  estimate(req: SfxRequest): Cost {
    return { characters: [...req.prompt].length, requests: 1 };
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
    return this.client.request(label, musicCall(req), { take: req.take });
  }

  estimate(req: MusicRequest): Cost {
    return { characters: [...req.prompt].length, requests: 1 };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
import {
  containsSecret,
  printable,
  redactSecrets,
  safeRequestId,
  safeStatusText,
  truncate,
} from "./redact.js";

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
 * reason, and there is no cause, so the original error, Request, or Response (and their
 * headers) never travel with it. A final guard checks every observable part for the API key.
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

/** The item a request is for, as raw values. The label is built from them after redaction. */
type Item = { what: string; fields: Array<[name: string, value: string | number]> };

class ElevenLabsClient {
  constructor(private readonly options: ElevenLabsOptions) {}

  /** Sends a call and returns the MP3 result. Errors name the item. */
  async request(
    kind: ElevenLabsKind,
    item: Item,
    call: ApiCall,
    meta: Record<string, unknown>,
  ): Promise<AudioResult> {
    const env = this.options.env ?? process.env;
    const apiKey = env[ELEVENLABS_API_KEY_ENV];
    const label = itemLabel(item, apiKey);
    /** Untrusted text, redacted first and then reduced to bounded printable text. */
    const clean = (text: string, max = MAX_DETAIL_LENGTH) =>
      printable(redactSecrets(text, apiKey, ELEVENLABS_API_KEY_HEADER), max);
    /** `category` is a fixed phrase, the only part of `reason` kept if the guard trips. */
    const fail = (category: string, reason: string, status?: number, requestId?: string) =>
      guardError(
        new ElevenLabsError(`${label}: ${reason}`, kind, status, requestId),
        apiKey,
        item,
        category,
      );
    if (!apiKey) {
      throw fail("missing key", `${ELEVENLABS_API_KEY_ENV} is not set`);
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
      throw fail("network error", `network error: ${clean(errorMessage(error))}`);
    }

    // Everything below comes from the response and is untrusted.
    const requestId = safeRequestId(response.headers.get(ELEVENLABS_REQUEST_ID_HEADER), apiKey);
    const requestIdNote = requestId ? ` (request ${requestId})` : "";
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const raw = errorDetail(body);
      const detail = raw === undefined ? "" : clean(raw);
      const statusText = safeStatusText(response.statusText, apiKey);
      const status = `HTTP ${response.status}${statusText ? ` ${statusText}` : ""}`;
      throw fail(
        "HTTP error",
        `${status}${requestIdNote}: ${detail || "response body not shown"}`,
        response.status,
        requestId,
      );
    }

    let data: Uint8Array;
    try {
      data = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw fail(
        "network error while reading the audio",
        `network error while reading the audio${requestIdNote}: ${clean(errorMessage(error))}`,
        response.status,
        requestId,
      );
    }
    let durationSec: number;
    try {
      durationSec = mp3DurationSec(data);
    } catch (error) {
      throw fail(
        "bad audio in the response",
        `bad audio in the response${requestIdNote} (${data.length} bytes): ${clean(errorMessage(error))}`,
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
    const item: Item = {
      what: "TTS",
      fields: [
        ["voice", req.voiceId],
        ["take", req.take],
        ["text", req.text],
      ],
    };
    return this.client.request("tts", item, ttsCall(req), {
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
    const item: Item = {
      what: "SFX",
      fields: [
        ["take", req.take],
        ["prompt", req.prompt],
      ],
    };
    return this.client.request("sfx", item, sfxCall(req), { take: req.take });
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
    const item: Item = {
      what: "music",
      fields: [
        ["take", req.take],
        ["prompt", req.prompt],
      ],
    };
    return this.client.request("music", item, musicCall(req), { take: req.take });
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

/**
 * "ElevenLabs TTS failed for voice "v", take 0, text "..."". Each text is redacted before it is
 * truncated and quoted, so that neither step can cut or escape the key out of reach.
 */
function itemLabel(item: Item, apiKey: string | undefined): string {
  const fields = item.fields.map(([name, value]) => {
    if (typeof value === "number") return `${name} ${value}`;
    const redacted = redactSecrets(value, apiKey, ELEVENLABS_API_KEY_HEADER);
    return `${name} ${JSON.stringify(truncate(redacted, MAX_LABEL_TEXT_LENGTH))}`;
  });
  return `ElevenLabs ${item.what} failed for ${fields.join(", ")}`;
}

/** Everything an error exposes: message, stack, String(), JSON, and every own property. */
function observable(error: ElevenLabsError): string {
  const parts = [error.message, String(error.stack), String(error), JSON.stringify(error)];
  for (const name of Object.getOwnPropertyNames(error)) {
    parts.push(String((error as unknown as Record<string, unknown>)[name]));
  }
  return parts.join("\n");
}

/**
 * The final guard. If any observable part of the error still holds the key in a known form,
 * the error is rebuilt from the kind, the item label (checked again), and the HTTP status only.
 */
function guardError(
  error: ElevenLabsError,
  apiKey: string | undefined,
  item: Item,
  category: string,
): ElevenLabsError {
  if (!containsSecret(observable(error), apiKey)) return error;
  const label = itemLabel(item, apiKey);
  const status = error.status === undefined ? "" : ` (HTTP ${error.status})`;
  const safeLabel = containsSecret(label, apiKey) ? `ElevenLabs ${item.what} failed` : label;
  const hidden = new ElevenLabsError(
    `${safeLabel}: ${category}${status}: details hidden because they may contain the API key`,
    error.kind,
    error.status,
  );
  if (!containsSecret(observable(hidden), apiKey)) return hidden;
  return new ElevenLabsError("ElevenLabs request failed", error.kind, error.status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

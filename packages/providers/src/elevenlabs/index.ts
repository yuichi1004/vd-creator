// ElevenLabs providers over the REST API with the built-in fetch. Each call costs real money,
// so these run only behind the cost gate of `vd generate`. Tests replace fetch.
//
// Errors follow the threat model in ./redact.ts: they hold only the kind, a label built from our
// own request, the HTTP status, and a code from a fixed list. No text from a response or from a
// caught exception is ever kept, and the provider never rethrows an object it did not build.

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
  ELEVENLABS_API_ERRORS,
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_API_KEY_HEADER,
  ELEVENLABS_BASE_URL,
  ELEVENLABS_ID_TOKEN,
  type ElevenLabsApiErrorCode,
  errorCode,
  musicCall,
  sfxCall,
  ttsCall,
  ttsModelId,
  ttsText,
} from "./api.js";
import { type Mp3Frames, mp3Frames } from "./mp3.js";
import { containsSecret, redactKey, truncate } from "./redact.js";

export const ELEVENLABS_PROVIDER_ID = "elevenlabs";

export type ElevenLabsOptions = {
  /** Where the API key is read from, at call time. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to the global fetch, looked up at call time. */
  fetch?: typeof fetch;
  /** Must be https, with no credentials, query, or fragment. Never shown in errors. */
  baseUrl?: string;
};

const MAX_LABEL_TEXT_LENGTH = 24;
/** Printable ASCII with no spaces, so whitespace, control, and non-ASCII characters are rejected. */
const API_KEY_TOKEN = /^[\x21-\x7e]+$/;
/** Real keys are much longer. A shorter key could match our fixed texts, so it is rejected. */
const MIN_API_KEY_LENGTH = 20;

export type ElevenLabsKind = "tts" | "sfx" | "music";

/** Failures on our side, with fixed English text. */
const LOCAL_ERRORS = {
  missing_api_key: `${ELEVENLABS_API_KEY_ENV} is not set`,
  malformed_api_key: `${ELEVENLABS_API_KEY_ENV} must be at least ${MIN_API_KEY_LENGTH} printable ASCII characters with no whitespace`,
  invalid_voice_id: "the voice ID is not a plain token",
  invalid_model_id: "the model ID is not a plain token",
  invalid_base_url: "the base URL must be https with no credentials, query, or fragment",
  network_error: "network error",
  unexpected_redirect: "the API answered with a redirect, which is not followed",
  body_read_failed: "response body read failed",
  bad_audio: "the response is not MP3 audio",
  audio_holds_key: "the audio holds the API key, so it is not returned",
  internal_error: "internal error",
} as const;

export type ElevenLabsErrorCode = ElevenLabsApiErrorCode | keyof typeof LOCAL_ERRORS;

const ERROR_TEXT: Record<ElevenLabsErrorCode, string> = {
  ...ELEVENLABS_API_ERRORS,
  ...LOCAL_ERRORS,
};

/** A failed ElevenLabs call. Its message is built only from its fields, with fixed templates. */
export class ElevenLabsError extends Error {
  override readonly name = "ElevenLabsError";

  constructor(
    readonly kind: ElevenLabsKind,
    readonly label: string,
    readonly code: ElevenLabsErrorCode,
    readonly status?: number,
  ) {
    const http = status === undefined ? "" : `HTTP ${status}, `;
    super(`${label}: ${http}${ERROR_TEXT[code]} (${code})`);
  }
}

/** The errors this module built. Anything else that is caught is replaced, never rethrown. */
const ownErrors = new WeakSet<object>();

/** Raw label parts from our own request. A string field of undefined is shown as invalid. */
type Item = { what: string; fields: Array<[name: string, value: string | number | undefined]> };

type Prepared = {
  item: Item;
  /** Set when our own input is not acceptable. No request is sent then. */
  invalid?: ElevenLabsErrorCode;
  call: () => ApiCall;
  meta: Record<string, unknown>;
};

class ElevenLabsClient {
  constructor(private readonly options: ElevenLabsOptions) {}

  /** Sends a call and returns the MP3 result. Every error it throws is an ElevenLabsError. */
  async request(
    kind: ElevenLabsKind,
    what: string,
    prepare: (apiKey: string | undefined) => Prepared,
  ): Promise<AudioResult> {
    let label = `ElevenLabs ${what} failed`;
    const fail = (code: ElevenLabsErrorCode, status?: number) => {
      const error = new ElevenLabsError(kind, label, code, status);
      ownErrors.add(error);
      return error;
    };
    try {
      // The key is read and validated first. Nothing else happens before, so a failed check
      // throws its fixed error with the fixed label.
      const env = this.options.env ?? process.env;
      const rawKey = env[ELEVENLABS_API_KEY_ENV];
      if (typeof rawKey !== "string" || rawKey.trim() === "") throw fail("missing_api_key");
      if (!API_KEY_TOKEN.test(rawKey) || rawKey.length < MIN_API_KEY_LENGTH) {
        throw fail("malformed_api_key");
      }
      const apiKey = rawKey;
      const prepared = prepare(apiKey);
      // The label is the only text from outside the code in an error. It is redacted as it is
      // built, and the check here is defense in depth on that label only.
      label = itemLabel(prepared.item, apiKey) ?? label;
      if (prepared.invalid) throw fail(prepared.invalid);
      const base = safeBaseUrl(this.options.baseUrl ?? ELEVENLABS_BASE_URL);
      if (!base) throw fail("invalid_base_url");
      const call = prepared.call();
      const url = new URL(call.path, base);
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
          // A followed redirect would send the key header to wherever the response points.
          redirect: "manual",
        });
      } catch {
        // The rejection is untrusted, so none of its properties are read.
        throw fail("network_error");
      }

      const status = httpStatus(response.status);
      if (
        response.type === "opaqueredirect" ||
        (status !== undefined && status >= 300 && status < 400)
      ) {
        throw fail("unexpected_redirect", status);
      }
      if (!response.ok) {
        let body: string;
        try {
          body = await response.text();
        } catch {
          throw fail("body_read_failed", status);
        }
        throw fail(errorCode(body, status), status);
      }

      let body: Uint8Array;
      try {
        body = new Uint8Array(await response.arrayBuffer());
      } catch {
        throw fail("body_read_failed", status);
      }
      // Only the chained MPEG frames are kept. This trims tags and trailing bytes for clean audio
      // and an accurate duration, but it cannot tell trailing bytes from frame data.
      let frames: Mp3Frames;
      try {
        frames = mp3Frames(body);
      } catch {
        throw fail("bad_audio", status);
      }
      const data = body.slice(frames.start, frames.end);
      // The guard that keeps the key out of the asset file, for every TTS, SFX, and music result.
      if (containsSecret(Buffer.from(data).toString("latin1"), apiKey)) {
        throw fail("audio_holds_key", status);
      }
      return {
        data,
        format: "mp3",
        durationSec: frames.durationSec,
        meta: { ...prepared.meta, provider: ELEVENLABS_PROVIDER_ID },
      };
    } catch (error) {
      const own = ownErrors.has(error as object) ? (error as ElevenLabsError) : undefined;
      throw sealed(own ?? fail("internal_error"));
    }
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
    return this.client.request("tts", "TTS", (apiKey) => {
      const modelId = ttsModelId(req);
      const voiceOk = isSafeToken(req.voiceId, apiKey);
      const modelOk = isSafeToken(modelId, apiKey);
      return {
        item: {
          what: "TTS",
          fields: [
            ["voice", voiceOk ? req.voiceId : undefined],
            ["take", req.take],
            ["text", req.text],
          ],
        },
        invalid: !voiceOk ? "invalid_voice_id" : !modelOk ? "invalid_model_id" : undefined,
        call: () => ttsCall(req),
        meta: { voiceId: req.voiceId, modelId, take: req.take },
      };
    });
  }

  /** ElevenLabs bills TTS by the characters sent, including a direction tag. */
  estimate(req: TtsRequest): Cost {
    return estimated("tts", "TTS", () => ({ characters: [...ttsText(req)].length, requests: 1 }));
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
    return this.client.request("sfx", "SFX", () => ({
      item: {
        what: "SFX",
        fields: [
          ["take", req.take],
          ["prompt", req.prompt],
        ],
      },
      call: () => sfxCall(req),
      meta: { take: req.take },
    }));
  }

  /** ElevenLabs bills SFX by duration or generation, not by prompt characters, so only the request counts. */
  estimate(_req: SfxRequest): Cost {
    return estimated("sfx", "SFX", () => ({ characters: 0, requests: 1 }));
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
    return this.client.request("music", "music", () => ({
      item: {
        what: "music",
        fields: [
          ["take", req.take],
          ["prompt", req.prompt],
        ],
      },
      call: () => musicCall(req),
      meta: { take: req.take },
    }));
  }

  /** ElevenLabs bills music by duration or generation, not by prompt characters, so only the request counts. */
  estimate(_req: MusicRequest): Cost {
    return estimated("music", "music", () => ({ characters: 0, requests: 1 }));
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
 * `ElevenLabs TTS failed for voice "v", take 0, text "..."`. Each text is redacted before it is
 * truncated and quoted, so that neither step can cut or escape the key out of reach. Returns
 * undefined if the fields still hold the key. Only the fields are checked: the rest is fixed text.
 */
function itemLabel(item: Item, apiKey: string): string | undefined {
  const fields = item.fields.map(([name, value]) => {
    if (typeof value === "number") return `${name} ${Number.isFinite(value) ? value : "?"}`;
    if (typeof value !== "string") return `${name} (invalid)`;
    return `${name} ${JSON.stringify(truncate(redactKey(value, apiKey), MAX_LABEL_TEXT_LENGTH))}`;
  });
  const text = fields.join(", ");
  return containsSecret(text, apiKey) ? undefined : `ElevenLabs ${item.what} failed for ${text}`;
}

/** A voice or model ID: a plain token that does not hold the key. */
function isSafeToken(value: unknown, apiKey: string | undefined): value is string {
  return (
    typeof value === "string" && ELEVENLABS_ID_TOKEN.test(value) && !containsSecret(value, apiKey)
  );
}

/** The base URL if it is https with no credentials, query, or fragment. */
function safeBaseUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const ok =
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    !raw.includes("?") &&
    !raw.includes("#");
  return ok ? url : undefined;
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/**
 * The synchronous boundary of every estimate. It needs no key, so it can run in a dry run. Any
 * error while reading the request is untrusted and leaves as a fixed, sealed internal_error.
 */
function estimated(kind: ElevenLabsKind, what: string, compute: () => Cost): Cost {
  try {
    return compute();
  } catch {
    throw sealed(new ElevenLabsError(kind, `ElevenLabs ${what} estimate failed`, "internal_error"));
  }
}

/**
 * Run on every error the provider throws, where it leaves the provider. The stack is set to
 * exactly the name and message, so that a stack hook such as Error.prepareStackTrace cannot put
 * text into it, and any cause is removed.
 */
function sealed(error: ElevenLabsError): ElevenLabsError {
  delete (error as { cause?: unknown }).cause;
  Object.defineProperty(error, "stack", {
    value: `${error.name}: ${error.message}`,
    writable: true,
    configurable: true,
  });
  return error;
}

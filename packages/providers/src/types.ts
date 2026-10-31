// Provider interfaces from plan 0004. Changing them needs a decision gate.
// Plan 0009 added the optional TtsProvider.dropsDirection, approved at a decision gate.
// Plan 0013 added the optional TtsProvider.voiceParameters, approved with that plan.

export type AudioFormat = "mp3" | "wav";

export type AudioResult = {
  data: Uint8Array;
  format: AudioFormat;
  durationSec: number;
  meta: Record<string, unknown>;
};

export type Cost = { characters: number; requests: number };

export interface Provider {
  /** "mock", "elevenlabs", ... */
  readonly id: string;
  /** True means each call costs real money. */
  readonly paid: boolean;
}

export type TtsRequest = {
  text: string;
  voiceId: string;
  /** The line's stage direction. */
  direction?: string;
  settings?: Record<string, unknown>;
  take: number;
};

export type SfxRequest = { prompt: string; durationSec?: number; take: number };

export type MusicRequest = { prompt: string; durationSec: number; take: number };

export interface TtsProvider extends Provider {
  synthesize(req: TtsRequest): Promise<AudioResult>;
  estimate(req: TtsRequest): Cost;
  /**
   * True if the request has a direction that the provider does not send, such as with a model
   * that does not read audio tags. Used only for the plan's notes. Optional: a provider without
   * it counts as sending every direction.
   */
  dropsDirection?(req: TtsRequest): boolean;
  /**
   * The voice settings the provider reads, with their ranges, for the given merged settings
   * (the speaker's settings with the line's over them). The settings matter because a model can
   * limit a value. An agent may propose only these keys, inside these ranges. Optional: a
   * provider without it gets no settings in proposals.
   */
  voiceParameters?(settings: Record<string, unknown> | undefined): VoiceParameter[];
}

/**
 * One voice setting a provider reads. A `number` is within `min` to `max` in steps of `step`
 * from `min`, or one of `values` when the provider allows only a few. An `on-off` is a boolean.
 */
export type VoiceParameter = { key: string; label: string } & (
  | { kind: "number"; min: number; max: number; step: number }
  | { kind: "number"; values: readonly number[] }
  | { kind: "on-off" }
);

export interface SfxProvider extends Provider {
  generate(req: SfxRequest): Promise<AudioResult>;
  estimate(req: SfxRequest): Cost;
}

export interface MusicProvider extends Provider {
  generate(req: MusicRequest): Promise<AudioResult>;
  estimate(req: MusicRequest): Cost;
}

/** The three providers that one provider ID supplies. */
export type ProviderSet = { tts: TtsProvider; sfx: SfxProvider; music: MusicProvider };

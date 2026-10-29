// Provider interfaces from plan 0004. Changing them needs a decision gate.

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
}

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

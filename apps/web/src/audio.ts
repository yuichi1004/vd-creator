// Audio unlock and the Web Audio player. See "PC and smartphone" in
// docs/plans/0005-review-ui.md. Mobile browsers, iOS Safari in particular, start Web Audio
// only from a user gesture, so no AudioContext is created or resumed before the first tap
// on play. Audio files are decoded on demand around the playback position.

import { clampPosition, filesAround, type ScheduledSound, scheduleFrom } from "./playback.js";
import type { Timeline } from "./types.js";

/** The parts of the Web Audio API the player uses, so tests can replace them. */
export type AudioBufferLike = { readonly duration: number };

export type AudioParamLike = { value: number };

export type AudioNodeLike = { connect(destination: unknown): unknown; disconnect(): void };

export type GainNodeLike = AudioNodeLike & { gain: AudioParamLike };

export type BufferSourceLike = AudioNodeLike & {
  buffer: AudioBufferLike | null;
  loop: boolean;
  start(when: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
};

export type AudioContextLike = {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  createGain(): GainNodeLike;
  createBufferSource(): BufferSourceLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
};

/**
 * - `locked`: no AudioContext yet. The UI shows "tap to enable sound".
 * - `unlocking`: created or resumed inside a gesture, waiting for `resume` to settle.
 * - `ready`: running.
 * - `unsupported`: the browser has no Web Audio.
 */
export type UnlockState = "locked" | "unlocking" | "ready" | "unsupported";

/**
 * Owns the AudioContext. It is created only by `unlock`, which must be called inside a
 * user gesture such as the tap on play.
 */
export class AudioUnlock {
  private context?: AudioContextLike;
  private current: UnlockState;
  private readonly listeners = new Set<(state: UnlockState) => void>();

  /** @param createContext Creates the AudioContext, or is absent without Web Audio. */
  constructor(private readonly createContext?: () => AudioContextLike) {
    this.current = createContext ? "locked" : "unsupported";
  }

  get state(): UnlockState {
    return this.current;
  }

  /** The context, once `unlock` created it. */
  get audioContext(): AudioContextLike | undefined {
    return this.context;
  }

  subscribe(listener: (state: UnlockState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Creates or resumes the context. Call it synchronously inside the gesture handler: the
   * `resume` call has to happen in the gesture, so this starts it before any await.
   */
  unlock(): Promise<AudioContextLike | undefined> {
    if (!this.createContext) return Promise.resolve(undefined);
    if (!this.context) {
      try {
        this.context = this.createContext();
      } catch {
        this.set("unsupported");
        return Promise.resolve(undefined);
      }
    }
    const context = this.context;
    if (context.state === "running") {
      this.set("ready");
      return Promise.resolve(context);
    }
    this.set("unlocking");
    return context.resume().then(
      () => {
        this.set(context.state === "running" ? "ready" : "locked");
        return context.state === "running" ? context : undefined;
      },
      () => {
        this.set("locked");
        return undefined;
      },
    );
  }

  /** Marks the context as needing a new gesture, as after the phone was locked. */
  relock(): void {
    if (this.context && this.context.state !== "running" && this.current === "ready") {
      this.set("locked");
    }
  }

  private set(state: UnlockState): void {
    if (state === this.current) return;
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }
}

/** How far ahead of the position sounds are started on the audio clock. */
export const SCHEDULE_AHEAD_SEC = 2;
/** How far ahead of the position files are fetched and decoded. */
export const DECODE_AHEAD_SEC = 8;
const TICK_MS = 250;

export type PlayerOptions = {
  unlock: AudioUnlock;
  /** Fetches the bytes of an asset file, given relative to `assets/`. */
  load: (file: string) => Promise<ArrayBuffer>;
  /** Called on start, stop, and the end of the timeline. */
  onChange?: () => void;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

type Started = { sound: ScheduledSound; source: BufferSourceLike; gain: GainNodeLike };

/**
 * Plays a timeline with Web Audio. Sounds are started a little ahead of time on the audio
 * clock, and only the files around the position are decoded and kept.
 */
export class Player {
  private timeline?: Timeline;
  private playing = false;
  private positionSec = 0;
  /** Audio clock time that matches timeline time `startSec`. */
  private clockStart = 0;
  private startSec = 0;
  private sounds: ScheduledSound[] = [];
  private readonly started = new Map<string, Started>();
  private readonly buffers = new Map<string, Promise<AudioBufferLike | undefined>>();
  /**
   * Files that failed to load. They play as silence until the next `play`, which retries
   * them. A failed load is never kept in `buffers`.
   */
  private readonly failed = new Set<string>();
  private timer?: unknown;
  private generation = 0;

  constructor(private readonly options: PlayerOptions) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  /** The playback position in timeline seconds. */
  get position(): number {
    const context = this.options.unlock.audioContext;
    if (!this.playing || !context) return this.positionSec;
    return this.startSec + Math.max(0, context.currentTime - this.clockStart);
  }

  /** Sets the timeline. If playing, playback restarts at the same position in the new one. */
  setTimeline(timeline: Timeline | undefined): void {
    const wasPlaying = this.playing;
    const position = this.position;
    if (wasPlaying) this.halt();
    this.timeline = timeline;
    // Files of the old timeline that are still used keep their decoded buffers.
    const files = new Set(timeline ? scheduleFrom(timeline, 0).map((s) => s.file) : []);
    for (const file of this.buffers.keys()) if (!files.has(file)) this.buffers.delete(file);
    this.positionSec = timeline ? clampPosition(timeline, position) : 0;
    if (wasPlaying && timeline) void this.play(this.positionSec);
    else this.options.onChange?.();
  }

  /** Moves the position without playing. */
  seek(sec: number): void {
    if (this.playing) {
      void this.play(sec);
      return;
    }
    this.positionSec = Math.max(0, sec);
    this.options.onChange?.();
  }

  /**
   * Starts playback at `fromSec`, or at the kept position. Call it inside the tap on play,
   * since it unlocks audio first.
   */
  async play(fromSec?: number): Promise<boolean> {
    const start = fromSec ?? this.positionSec;
    if (this.playing) this.halt();
    const run = ++this.generation;
    const context = await this.options.unlock.unlock();
    if (!context || !this.timeline || run !== this.generation) return false;
    const timeline = this.timeline;
    this.failed.clear();
    this.startSec = start >= timeline.durationSec ? 0 : Math.max(0, start);
    this.sounds = scheduleFrom(timeline, this.startSec);
    this.clockStart = context.currentTime + 0.05;
    this.playing = true;
    this.positionSec = this.startSec;
    const setTimer = this.options.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms));
    this.timer = setTimer(() => this.tick(), TICK_MS);
    this.tick();
    this.options.onChange?.();
    return true;
  }

  /** Stops playback and keeps the position. Also cancels a play still waiting to start. */
  stop(): void {
    this.generation++;
    if (!this.playing) return;
    this.halt();
    this.options.onChange?.();
  }

  private halt(): void {
    this.positionSec = this.position;
    this.playing = false;
    this.generation++;
    if (this.timer !== undefined) {
      const clear =
        this.options.clearInterval ??
        ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
      clear(this.timer);
    }
    this.timer = undefined;
    for (const { source, gain } of this.started.values()) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
      gain.disconnect();
    }
    this.started.clear();
  }

  private tick(): void {
    const context = this.options.unlock.audioContext;
    const timeline = this.timeline;
    if (!this.playing || !context || !timeline) return;
    const now = this.position;
    if (now >= timeline.durationSec) {
      this.halt();
      this.positionSec = 0;
      this.options.onChange?.();
      return;
    }
    for (const [key, { sound, source, gain }] of this.started) {
      if (sound.atSec + sound.durationSec > now) continue;
      source.disconnect();
      gain.disconnect();
      this.started.delete(key);
    }
    const wanted = new Set(filesAround(this.sounds, now, DECODE_AHEAD_SEC));
    for (const file of wanted) this.decode(context, file);
    // Free buffers that are behind the position and not needed again soon.
    for (const file of this.buffers.keys()) {
      if (!wanted.has(file) && !this.isStartedFile(file)) this.buffers.delete(file);
    }
    const run = this.generation;
    for (const sound of this.sounds) {
      if (sound.atSec > now + SCHEDULE_AHEAD_SEC) break;
      if (this.started.has(sound.key) || sound.atSec + sound.durationSec <= now) continue;
      const buffer = this.buffers.get(sound.file);
      if (!buffer) continue;
      // Reserve the key, so a later tick does not start it twice while it decodes.
      void buffer.then((decoded) => {
        if (decoded && run === this.generation) this.startSound(context, sound, decoded);
      });
      this.started.set(sound.key, { sound, source: nullSource, gain: nullGain });
    }
  }

  private startSound(context: AudioContextLike, sound: ScheduledSound, buffer: AudioBufferLike) {
    // If decoding was late, start part way in rather than out of sync.
    const lateSec = Math.max(0, this.position - sound.atSec);
    const durationSec = sound.durationSec - lateSec;
    if (durationSec <= 0) return;
    const when = this.clockStart + (sound.atSec - this.startSec) + lateSec;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = sound.loop;
    const gain = context.createGain();
    gain.gain.value = sound.gain;
    source.connect(gain);
    gain.connect(context.destination);
    let offset = sound.offsetSec + lateSec;
    if (sound.loop && buffer.duration > 0) offset %= buffer.duration;
    source.start(Math.max(when, context.currentTime), offset, durationSec);
    this.started.set(sound.key, { sound, source, gain });
  }

  private isStartedFile(file: string): boolean {
    for (const { sound } of this.started.values()) {
      if (sound.file === file && sound.atSec + sound.durationSec > this.position) return true;
    }
    return false;
  }

  private decode(context: AudioContextLike, file: string): void {
    if (this.buffers.has(file) || this.failed.has(file)) return;
    const promise = this.options
      .load(file)
      .then((bytes) => context.decodeAudioData(bytes))
      .catch(() => {
        this.failed.add(file);
        if (this.buffers.get(file) === promise) this.buffers.delete(file);
        return undefined;
      });
    this.buffers.set(file, promise);
  }
}

const nullNode: AudioNodeLike = { connect: () => undefined, disconnect: () => undefined };
const nullGain: GainNodeLike = { ...nullNode, gain: { value: 0 } };
const nullSource: BufferSourceLike = {
  ...nullNode,
  buffer: null,
  loop: false,
  start: () => undefined,
  stop: () => undefined,
};

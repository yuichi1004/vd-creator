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
  playbackRate: AudioParamLike;
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
/** How far ahead of the position files are fetched and decoded, in drama time. */
export const DECODE_AHEAD_SEC = 8;
const TICK_MS = 250;

export type PlayerOptions = {
  unlock: AudioUnlock;
  /**
   * Fetches the bytes of an asset file, given relative to `assets/`. A `tempo` other than 1 asks
   * for a copy stretched to `1 / tempo` of the length with the pitch kept.
   */
  load: (file: string, tempo: number) => Promise<ArrayBuffer>;
  /** Called on start, stop, and the end of the timeline. */
  onChange?: () => void;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

type Started = { sound: ScheduledSound; source: BufferSourceLike; gain: GainNodeLike };

/** A decoded buffer, and the tempo it was stretched to (1 for the original). */
type Decoded = { buffer: AudioBufferLike; tempo: number };

/** How the player plays: the speed, and whether stretched copies keep the pitch. */
export type PlaybackSpeed = { speed: number; keepPitch: boolean };

function bufferKey(file: string, tempo: number): string {
  return `${file}@${tempo}`;
}

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
  /** Decoded buffers, keyed by file and tempo, so a buffer is never played at another speed. */
  private readonly buffers = new Map<string, Promise<Decoded | undefined>>();
  /**
   * Files that failed to load. They play as silence until the next `play`, which retries
   * them. A failed load is never kept in `buffers`, and only the play that started a load
   * records its failure.
   */
  private readonly failed = new Set<string>();
  /** Loads in `buffers` that have not settled yet. A new `play` does not reuse them. */
  private readonly pending = new Set<Promise<Decoded | undefined>>();
  /** Files whose stretched copy could not be made. They play with `playbackRate`. */
  private readonly previewFailed = new Set<string>();
  private speed = 1;
  private keepPitch = true;
  private loading = false;
  private loadingFrom = 0;
  private timer?: unknown;
  private generation = 0;

  constructor(private readonly options: PlayerOptions) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  /** True while a play waits for the first sounds to be decoded. */
  get isLoading(): boolean {
    return this.loading;
  }

  /** The playback position in timeline seconds. Drama time runs `speed` times the clock. */
  get position(): number {
    const context = this.options.unlock.audioContext;
    if (!this.playing || !context) return this.positionSec;
    return this.startSec + Math.max(0, context.currentTime - this.clockStart) * this.speed;
  }

  /**
   * Sets the speed and whether to keep the pitch. If playing, the sounds stop and start again
   * from the current drama position, the same way a seek does.
   */
  configure(next: PlaybackSpeed): void {
    if (next.speed === this.speed && next.keepPitch === this.keepPitch) return;
    const resumeAt = this.playing ? this.position : this.loading ? this.loadingFrom : undefined;
    if (this.playing) this.halt();
    this.speed = next.speed;
    this.keepPitch = next.keepPitch;
    if (resumeAt !== undefined) void this.play(resumeAt);
    else this.options.onChange?.();
  }

  /** The tempo to load for a file: 1 plays the original with `playbackRate`. */
  private tempoFor(file: string): number {
    return this.keepPitch && this.speed !== 1 && !this.previewFailed.has(file) ? this.speed : 1;
  }

  /** Sets the timeline. If playing, playback restarts at the same position in the new one. */
  setTimeline(timeline: Timeline | undefined): void {
    const wasPlaying = this.playing;
    const position = this.position;
    if (wasPlaying) this.halt();
    this.timeline = timeline;
    // Files of the old timeline that are still used keep their decoded buffers.
    const files = new Set(timeline ? scheduleFrom(timeline, 0).map((s) => s.file) : []);
    for (const key of this.buffers.keys()) {
      if (!files.has(key.slice(0, key.lastIndexOf("@")))) this.buffers.delete(key);
    }
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
    for (const [key, promise] of this.buffers) {
      if (this.pending.has(promise)) this.buffers.delete(key);
    }
    this.startSec = start >= timeline.durationSec ? 0 : Math.max(0, start);
    this.sounds = scheduleFrom(timeline, this.startSec);
    // Wait for the sounds of the next 2 s of clock time, so that none starts part way in.
    this.loading = true;
    this.loadingFrom = this.startSec;
    this.options.onChange?.();
    const first = filesAround(this.sounds, this.startSec, SCHEDULE_AHEAD_SEC * this.speed);
    await Promise.all(first.map((file) => this.decode(context, file)));
    if (run !== this.generation) return false;
    this.loading = false;
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
    if (this.loading) {
      this.loading = false;
      this.options.onChange?.();
    }
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
    const wantedKeys = new Set<string>();
    for (const file of wanted) {
      this.decode(context, file);
      wantedKeys.add(bufferKey(file, this.tempoFor(file)));
    }
    // Free buffers that are behind the position and not needed again soon.
    for (const key of this.buffers.keys()) {
      if (!wantedKeys.has(key) && !this.isStartedKey(key)) this.buffers.delete(key);
    }
    const run = this.generation;
    for (const sound of this.sounds) {
      if (sound.atSec > now + SCHEDULE_AHEAD_SEC * this.speed) break;
      if (this.started.has(sound.key) || sound.atSec + sound.durationSec <= now) continue;
      const buffer = this.buffers.get(bufferKey(sound.file, this.tempoFor(sound.file)));
      if (!buffer) continue;
      // Reserve the key, so a later tick does not start it twice while it decodes.
      void buffer.then((decoded) => {
        if (decoded && run === this.generation) this.startSound(context, sound, decoded);
      });
      this.started.set(sound.key, { sound, source: nullSource, gain: nullGain });
    }
  }

  private startSound(context: AudioContextLike, sound: ScheduledSound, decoded: Decoded) {
    const { buffer, tempo } = decoded;
    // If decoding was late, start part way in rather than out of sync.
    const lateSec = Math.max(0, this.position - sound.atSec);
    const durationSec = sound.durationSec - lateSec;
    if (durationSec <= 0) return;
    // Drama time runs `speed` times the clock, so the clock waits `1 / speed` per drama second.
    const when = this.clockStart + (sound.atSec - this.startSec + lateSec) / this.speed;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = sound.loop;
    // A stretched copy already runs at the speed. The original is played faster with the rate,
    // and offset and duration then stay in seconds of the original buffer.
    source.playbackRate.value = tempo === 1 ? this.speed : 1;
    const gain = context.createGain();
    gain.gain.value = sound.gain;
    source.connect(gain);
    gain.connect(context.destination);
    let offset = (sound.offsetSec + lateSec) / tempo;
    if (sound.loop && buffer.duration > 0) offset %= buffer.duration;
    source.start(Math.max(when, context.currentTime), offset, durationSec / tempo);
    this.started.set(sound.key, { sound, source, gain });
  }

  private isStartedKey(key: string): boolean {
    for (const { sound } of this.started.values()) {
      if (sound.atSec + sound.durationSec <= this.position) continue;
      if (key === bufferKey(sound.file, this.tempoFor(sound.file))) return true;
    }
    return false;
  }

  /** Starts loading the file at the current tempo, unless it is loaded or loading. */
  private decode(context: AudioContextLike, file: string): Promise<Decoded | undefined> {
    const tempo = this.tempoFor(file);
    const key = bufferKey(file, tempo);
    const existing = this.buffers.get(key);
    if (existing) return existing;
    if (this.failed.has(key)) return Promise.resolve(undefined);
    const run = this.generation;
    const fetchDecoded = (at: number) =>
      this.options
        .load(file, at)
        .then((bytes) => context.decodeAudioData(bytes))
        .then((buffer): Decoded => ({ buffer, tempo: at }));
    const promise: Promise<Decoded | undefined> = fetchDecoded(tempo)
      .catch((error: unknown) => {
        if (tempo === 1) throw error;
        // No stretched copy: play the original with `playbackRate` from now on.
        this.previewFailed.add(file);
        const original = bufferKey(file, 1);
        if (!this.buffers.has(original)) this.buffers.set(original, promise);
        return fetchDecoded(1);
      })
      .then(
        (decoded) => {
          this.pending.delete(promise);
          return decoded;
        },
        () => {
          this.pending.delete(promise);
          for (const [k, p] of this.buffers) if (p === promise) this.buffers.delete(k);
          if (run === this.generation) this.failed.add(bufferKey(file, 1));
          if (run === this.generation) this.failed.add(key);
          return undefined;
        },
      );
    this.pending.add(promise);
    this.buffers.set(key, promise);
    return promise;
  }
}

const nullNode: AudioNodeLike = { connect: () => undefined, disconnect: () => undefined };
const nullGain: GainNodeLike = { ...nullNode, gain: { value: 0 } };
const nullSource: BufferSourceLike = {
  ...nullNode,
  buffer: null,
  loop: false,
  playbackRate: { value: 1 },
  start: () => undefined,
  stop: () => undefined,
};

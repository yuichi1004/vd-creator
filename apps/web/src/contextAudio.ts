// Plays a few audio files one after another, for the retake screen: the line before, the take
// to hear, and the line after. It reuses one audio element, so on a phone the tap that starts
// the first file also allows the files after it.

export type AudioLike = {
  src: string;
  playbackRate: number;
  onended: ((...args: never[]) => unknown) | null;
  onerror: ((...args: never[]) => unknown) | null;
  play(): Promise<void>;
  pause(): void;
};

/** The parts of `document` and `window` that `stopWhenHidden` uses. */
export type HideTargets = {
  doc: {
    visibilityState: string;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
  };
  win: {
    addEventListener(type: "pagehide", listener: () => void): void;
    removeEventListener(type: "pagehide", listener: () => void): void;
  };
};

/**
 * Stops `player` when the tab is hidden or the page is hidden, such as when a phone locks
 * (plan 0005), like the main player. Returns the function that removes the listeners.
 */
export function stopWhenHidden(
  player: { stop(): void },
  targets: HideTargets = { doc: document, win: window },
): () => void {
  const onHidden = () => {
    if (targets.doc.visibilityState === "hidden") player.stop();
  };
  const onPageHide = () => player.stop();
  targets.doc.addEventListener("visibilitychange", onHidden);
  targets.win.addEventListener("pagehide", onPageHide);
  return () => {
    targets.doc.removeEventListener("visibilitychange", onHidden);
    targets.win.removeEventListener("pagehide", onPageHide);
  };
}

export class SequencePlayer {
  private audio: AudioLike | undefined;
  private queue: string[] = [];
  private index = 0;
  private active = false;
  private playId: string | undefined;

  constructor(
    private readonly createAudio: () => AudioLike = () => new Audio(),
    private readonly onChange: () => void = () => {},
  ) {}

  get playing(): boolean {
    return this.active;
  }

  /** The ID given to `play` while it plays, so that a button can show "Stop" for its own sound. */
  get id(): string | undefined {
    return this.active ? this.playId : undefined;
  }

  /**
   * Plays `urls` in a row at `rate`, after stopping what played. `id` names the sound for
   * `id`. Call it inside a tap.
   */
  play(urls: readonly string[], rate = 1, id?: string): void {
    this.stop();
    if (urls.length === 0) return;
    const audio = this.audio ?? this.createAudio();
    this.audio = audio;
    this.playId = id;
    this.queue = [...urls];
    this.index = 0;
    this.active = true;
    audio.playbackRate = rate;
    audio.onended = () => this.next();
    audio.onerror = () => this.next();
    this.start(audio);
    this.onChange();
  }

  stop(): void {
    const wasActive = this.active;
    this.active = false;
    this.queue = [];
    this.index = 0;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
    }
    if (wasActive) this.onChange();
  }

  private start(audio: AudioLike): void {
    const url = this.queue[this.index];
    if (url === undefined) return;
    audio.src = url;
    audio.play().catch(() => {
      // A refused or failed play moves on, as a file that cannot be decoded does.
      if (this.active && this.audio === audio && this.queue[this.index] === url) this.next();
    });
  }

  private next(): void {
    if (!this.active || !this.audio) return;
    this.index += 1;
    if (this.index >= this.queue.length) {
      this.active = false;
      this.queue = [];
      this.index = 0;
      this.onChange();
      return;
    }
    this.start(this.audio);
    this.onChange();
  }
}

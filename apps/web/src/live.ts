// Live updates of the project. See "Access from a phone" in docs/plans/0005-review-ui.md.
// The UI listens to server-sent events. If the stream fails, or a proxy buffers it so that
// it never opens, the UI falls back to polling every 5 seconds. No WebSocket is used.

import type { ServerEventName } from "@vd-creator/server";

export const POLL_INTERVAL_MS = 5000;
/** If the stream has not opened by then, it is taken as buffered and polling starts. */
export const OPEN_TIMEOUT_MS = 10000;

const PROJECT_CHANGED: ServerEventName = "project-changed";

/** The part of `EventSource` that is used. */
export type EventSourceLike = {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
};

export type Timers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type LiveUpdatesOptions = {
  url: string;
  /** Called when the project may have changed. The caller reloads `GET /api/project`. */
  onChange: () => void;
  /** Creates the event stream. Absent when the browser has no `EventSource`. */
  createEventSource?: (url: string) => EventSourceLike;
  timers?: Timers;
};

export type LiveMode = "connecting" | "events" | "polling" | "stopped";

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export class LiveUpdates {
  private source?: EventSourceLike;
  private openTimer?: unknown;
  private pollTimer?: unknown;
  private currentMode: LiveMode = "stopped";
  private readonly timers: Timers;

  constructor(private readonly options: LiveUpdatesOptions) {
    this.timers = options.timers ?? defaultTimers;
  }

  get mode(): LiveMode {
    return this.currentMode;
  }

  start(): void {
    if (this.currentMode !== "stopped") return;
    const create = this.options.createEventSource;
    if (!create) {
      this.startPolling();
      return;
    }
    this.currentMode = "connecting";
    let source: EventSourceLike;
    try {
      source = create(this.options.url);
    } catch {
      this.startPolling();
      return;
    }
    this.source = source;
    source.onopen = () => {
      if (this.source !== source) return;
      this.clearOpenTimer();
      this.currentMode = "events";
    };
    source.onerror = () => {
      if (this.source !== source) return;
      // EventSource reconnects by itself, but a proxy that breaks the stream would make it
      // retry forever. Polling is simpler and always works.
      this.startPolling();
    };
    source.addEventListener(PROJECT_CHANGED, () => {
      if (this.source === source) this.options.onChange();
    });
    this.openTimer = this.timers.setTimeout(() => {
      this.openTimer = undefined;
      if (this.currentMode === "connecting") this.startPolling();
    }, OPEN_TIMEOUT_MS);
  }

  stop(): void {
    this.closeSource();
    this.clearOpenTimer();
    if (this.pollTimer !== undefined) this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.currentMode = "stopped";
  }

  private startPolling(): void {
    this.closeSource();
    this.clearOpenTimer();
    if (this.currentMode === "polling") return;
    this.currentMode = "polling";
    // Changes made while the stream was down are picked up by the first poll.
    this.options.onChange();
    this.pollTimer = this.timers.setInterval(() => this.options.onChange(), POLL_INTERVAL_MS);
  }

  private closeSource(): void {
    const source = this.source;
    this.source = undefined;
    source?.close();
  }

  private clearOpenTimer(): void {
    if (this.openTimer !== undefined) this.timers.clearTimeout(this.openTimer);
    this.openTimer = undefined;
  }
}

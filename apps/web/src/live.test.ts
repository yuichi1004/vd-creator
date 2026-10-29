import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type EventSourceLike, LiveUpdates, OPEN_TIMEOUT_MS, POLL_INTERVAL_MS } from "./live.js";

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(withEventSource = true) {
  const sources: FakeEventSource[] = [];
  const onChange = vi.fn();
  const live = new LiveUpdates({
    url: "http://host/app/api/events",
    onChange,
    createEventSource: withEventSource
      ? (url) => {
          const source = new FakeEventSource(url);
          sources.push(source);
          return source;
        }
      : undefined,
  });
  return { live, onChange, sources };
}

describe("server-sent events", () => {
  test("reloads on project-changed and does not poll", () => {
    const { live, onChange, sources } = setup();
    live.start();
    const source = sources[0];
    expect(source?.url).toBe("http://host/app/api/events");
    source?.onopen?.(new Event("open"));
    expect(live.mode).toBe("events");

    source?.emit("project-changed");
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 4);
    expect(onChange).toHaveBeenCalledTimes(1);
    live.stop();
  });
});

describe("polling fallback", () => {
  test("polls every 5 seconds when the stream fails", () => {
    const { live, onChange, sources } = setup();
    live.start();
    sources[0]?.onopen?.(new Event("open"));
    sources[0]?.onerror?.(new Event("error"));

    expect(live.mode).toBe("polling");
    expect(sources[0]?.closed).toBe(true);
    // One reload at once picks up changes missed while the stream was down.
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(4);

    // A late event from the closed stream is ignored.
    sources[0]?.emit("project-changed");
    expect(onChange).toHaveBeenCalledTimes(4);
    live.stop();
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  test("polls when a proxy buffers the stream so it never opens", () => {
    const { live, onChange, sources } = setup();
    live.start();
    vi.advanceTimersByTime(OPEN_TIMEOUT_MS - 1);
    expect(live.mode).toBe("connecting");
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(live.mode).toBe("polling");
    expect(sources[0]?.closed).toBe(true);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    live.stop();
  });

  test("polls when the browser has no EventSource", () => {
    const { live, onChange } = setup(false);
    live.start();
    expect(live.mode).toBe("polling");
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    live.stop();
  });

  test("repeated errors start only one poll", () => {
    const { live, onChange, sources } = setup();
    live.start();
    sources[0]?.onerror?.(new Event("error"));
    sources[0]?.onerror?.(new Event("error"));
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    live.stop();
  });
});

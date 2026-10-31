import { describe, expect, test, vi } from "vitest";
import {
  type AudioBufferLike,
  type AudioContextLike,
  AudioUnlock,
  type BufferSourceLike,
  type GainNodeLike,
  LOAD_WAIT_MS,
  Player,
} from "./audio.js";
import type { Timeline } from "./types.js";

type Started = {
  file: string;
  tempo: number;
  when: number;
  offset?: number;
  duration?: number;
  loop: boolean;
  rate: number;
  bufferDuration: number;
};

class FakeContext implements AudioContextLike {
  currentTime = 0;
  state = "suspended";
  destination = {};
  resumeCalls = 0;
  started: Started[] = [];
  stopped = 0;

  resume(): Promise<void> {
    this.resumeCalls++;
    this.state = "running";
    return Promise.resolve();
  }

  createGain(): GainNodeLike {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
  }

  createBufferSource(): BufferSourceLike {
    const source: BufferSourceLike = {
      buffer: null,
      loop: false,
      playbackRate: { value: 1 },
      connect: () => undefined,
      disconnect: () => undefined,
      start: (when, offset, duration) => {
        const buffer = source.buffer as AudioBufferLike & { file: string };
        const [file = "", tempo = "1"] = buffer.file.split("@");
        this.started.push({
          file,
          tempo: Number(tempo),
          when,
          offset,
          duration,
          loop: source.loop,
          rate: source.playbackRate.value,
          bufferDuration: buffer.duration,
        });
      },
      stop: () => {
        this.stopped++;
      },
    };
    return source;
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    // The test loaders encode "<file>@<tempo>". A stretched copy is shorter.
    const file = new TextDecoder().decode(data);
    const tempo = Number(file.split("@")[1] ?? 1);
    return Promise.resolve({ duration: 4 / tempo, file } as AudioBufferLike);
  }
}

describe("audio unlock", () => {
  test("no AudioContext exists before the play gesture", async () => {
    const create = vi.fn(() => new FakeContext());
    const unlock = new AudioUnlock(create);
    const player = new Player({ unlock, load: async () => new ArrayBuffer(0) });
    player.setTimeline(timeline);
    player.seek(1);
    player.stop();

    expect(create).not.toHaveBeenCalled();
    expect(unlock.state).toBe("locked");
    expect(unlock.audioContext).toBeUndefined();
  });

  test("the context is created and resumed inside the gesture, before any await", async () => {
    const context = new FakeContext();
    const create = vi.fn(() => context);
    const unlock = new AudioUnlock(create);
    const states: string[] = [];
    unlock.subscribe((state) => states.push(state));

    const pending = unlock.unlock();
    // Synchronously, still inside the tap handler.
    expect(create).toHaveBeenCalledTimes(1);
    expect(context.resumeCalls).toBe(1);
    expect(unlock.state).toBe("unlocking");

    await pending;
    expect(unlock.state).toBe("ready");
    expect(states).toEqual(["unlocking", "ready"]);

    await unlock.unlock();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("play unlocks synchronously inside the tap", () => {
    const context = new FakeContext();
    const create = vi.fn(() => context);
    const player = new Player({
      unlock: new AudioUnlock(create),
      load: async () => new ArrayBuffer(0),
      setInterval: () => 0,
      clearInterval: () => undefined,
    });
    player.setTimeline(timeline);
    void player.play();
    expect(create).toHaveBeenCalledTimes(1);
    expect(context.resumeCalls).toBe(1);
  });

  test("a failed resume stays locked, so the UI keeps asking for a tap", async () => {
    const context = new FakeContext();
    context.resume = () => Promise.reject(new Error("not allowed"));
    const unlock = new AudioUnlock(() => context);
    expect(await unlock.unlock()).toBeUndefined();
    expect(unlock.state).toBe("locked");
  });

  test("without Web Audio the state is unsupported", async () => {
    const unlock = new AudioUnlock(undefined);
    expect(unlock.state).toBe("unsupported");
    expect(await unlock.unlock()).toBeUndefined();
  });

  test("relock asks for a new tap after the context was suspended", async () => {
    const context = new FakeContext();
    const unlock = new AudioUnlock(() => context);
    await unlock.unlock();
    context.state = "suspended";
    unlock.relock();
    expect(unlock.state).toBe("locked");
  });
});

const timeline: Timeline = {
  items: [
    {
      id: "l1",
      kind: "line",
      sceneId: "s1",
      index: 0,
      startSec: 0,
      durationSec: 2,
      assetFile: "l1.mp3",
    },
    {
      id: "l2",
      kind: "line",
      sceneId: "s1",
      index: 1,
      startSec: 3,
      durationSec: 2,
      assetFile: "l2.mp3",
    },
    {
      id: "l3",
      kind: "line",
      sceneId: "s1",
      index: 2,
      startSec: 20,
      durationSec: 2,
      assetFile: "l3.mp3",
    },
  ],
  images: [],
  bgm: [
    {
      sceneId: "s1",
      volume: 0.5,
      startSec: 0,
      endSec: 22,
      assetFile: "bgm.mp3",
      assetDurationSec: 4,
    },
  ],
  scenes: [{ sceneId: "s1", startSec: 0, endSec: 22 }],
  durationSec: 22,
};

describe("player", () => {
  async function playing(fromSec?: number) {
    const context = new FakeContext();
    let tick: (() => void) | undefined;
    const loaded: string[] = [];
    const player = new Player({
      unlock: new AudioUnlock(() => context),
      load: async (file) => {
        loaded.push(file);
        return new TextEncoder().encode(file).buffer as ArrayBuffer;
      },
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => {
        tick = undefined;
      },
    });
    player.setTimeline(timeline);
    await player.play(fromSec);
    await flush();
    return { context, player, loaded, tick: () => tick?.() };
  }

  test("decodes only files near the position and schedules them on the audio clock", async () => {
    const { context, loaded } = await playing();
    expect(loaded.sort()).toEqual(["bgm.mp3", "l1.mp3", "l2.mp3"]);
    // Within the schedule window: the BGM and the first line, not yet the line at 3 s.
    expect(context.started.map((s) => s.file).sort()).toEqual(["bgm.mp3", "l1.mp3"]);
    const bgm = context.started.find((s) => s.file === "bgm.mp3");
    expect(bgm).toMatchObject({ loop: true, offset: 0, duration: 22 });
  });

  test("later sounds start as the position moves, and far ones decode on demand", async () => {
    const { context, loaded, tick } = await playing();
    context.currentTime = 1.5;
    tick();
    await flush();
    expect(context.started.map((s) => s.file)).toContain("l2.mp3");
    const l2 = context.started.find((s) => s.file === "l2.mp3");
    expect(l2?.when).toBeCloseTo(3.05);
    expect(loaded).not.toContain("l3.mp3");

    context.currentTime = 14;
    tick();
    await flush();
    expect(loaded).toContain("l3.mp3");
  });

  test("stop keeps the position, and play resumes from it", async () => {
    const { context, player } = await playing(5);
    context.currentTime = 2.05;
    expect(player.position).toBeCloseTo(7);
    player.stop();
    expect(context.stopped).toBeGreaterThan(0);
    expect(player.isPlaying).toBe(false);
    expect(player.position).toBeCloseTo(7);

    context.started = [];
    await player.play();
    await flush();
    const bgm = context.started.find((s) => s.file === "bgm.mp3");
    // 7 s into a 4 s loop.
    expect(bgm?.offset).toBeCloseTo(3);
  });

  test("a new timeline keeps the position", async () => {
    const { context, player } = await playing(4);
    context.currentTime = 1.05;
    player.setTimeline({ ...timeline });
    await flush();
    expect(player.isPlaying).toBe(true);
    expect(player.position).toBeCloseTo(5);
  });
});

describe("stop and retry", () => {
  test("a load pending at stop is not reused, and its late failure does not silence the file", async () => {
    const context = new FakeContext();
    let rejectFirst: (error: Error) => void = () => undefined;
    const loaded: string[] = [];
    const player = new Player({
      unlock: new AudioUnlock(() => context),
      load: (file) => {
        loaded.push(file);
        if (file === "l1.mp3" && loaded.filter((f) => f === file).length === 1) {
          return new Promise<ArrayBuffer>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return Promise.resolve(new TextEncoder().encode(file).buffer as ArrayBuffer);
      },
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    player.setTimeline(timeline);
    // The first play waits for the load that never settles, until it is stopped.
    const first = player.play(0);
    await flush();
    expect(player.isLoading).toBe(true);
    player.stop();
    expect(player.isLoading).toBe(false);
    await player.play(0);
    rejectFirst(new Error("offline"));
    expect(await first).toBe(false);
    await flush();
    expect(loaded.filter((f) => f === "l1.mp3")).toHaveLength(2);
    expect(context.started.map((s) => s.file)).toContain("l1.mp3");
  });

  test("a stop while the first unlock is pending cancels the play", async () => {
    const context = new FakeContext();
    let resolveResume: () => void = () => undefined;
    context.resume = () => {
      context.resumeCalls++;
      return new Promise<void>((resolve) => {
        resolveResume = () => {
          context.state = "running";
          resolve();
        };
      });
    };
    const player = new Player({
      unlock: new AudioUnlock(() => context),
      load: async (file) => new TextEncoder().encode(file).buffer as ArrayBuffer,
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    player.setTimeline(timeline);
    const pending = player.play();
    // The page is hidden before the resume settles.
    player.stop();
    resolveResume();
    expect(await pending).toBe(false);
    await flush();
    expect(player.isPlaying).toBe(false);
    expect(context.started).toEqual([]);
  });

  test("a failed load is retried on the next play", async () => {
    const context = new FakeContext();
    let failing = true;
    const loaded: string[] = [];
    const player = new Player({
      unlock: new AudioUnlock(() => context),
      load: async (file) => {
        loaded.push(file);
        if (failing && file === "l1.mp3") throw new Error("offline");
        return new TextEncoder().encode(file).buffer as ArrayBuffer;
      },
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    player.setTimeline(timeline);
    await player.play(0);
    await flush();
    expect(context.started.map((s) => s.file)).not.toContain("l1.mp3");

    failing = false;
    player.stop();
    await player.play(0);
    await flush();
    expect(loaded.filter((f) => f === "l1.mp3")).toHaveLength(2);
    expect(context.started.map((s) => s.file)).toContain("l1.mp3");
  });
});

describe("loading wait", () => {
  const lineTimeline = (file: string): Timeline => ({
    items: [
      {
        id: "a",
        kind: "line",
        sceneId: "s1",
        index: 0,
        startSec: 0,
        durationSec: 4,
        assetFile: file,
      },
    ],
    images: [],
    bgm: [],
    scenes: [{ sceneId: "s1", startSec: 0, endSec: 4 }],
    durationSec: 4,
  });

  /** A player whose loads settle only when the test says so. */
  function gated() {
    const context = new FakeContext();
    const calls: { file: string; tempo: number; signal?: AbortSignal; release: () => void }[] = [];
    const player = new Player({
      unlock: new AudioUnlock(() => context),
      load: (file, tempo, signal) =>
        new Promise<ArrayBuffer>((resolve, reject) => {
          calls.push({
            file,
            tempo,
            signal,
            release: () =>
              resolve(new TextEncoder().encode(`${file}@${tempo}`).buffer as ArrayBuffer),
          });
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    return { context, player, calls };
  }

  test("a new timeline during the wait restarts the play on the new timeline", async () => {
    const { player, calls } = gated();
    player.setTimeline(lineTimeline("old.mp3"));
    const first = player.play(1);
    await flush();
    expect(player.isLoading).toBe(true);
    player.setTimeline(lineTimeline("new.mp3"));
    await flush();
    expect(await first).toBe(false);
    expect(player.isLoading).toBe(true);
    expect(calls.map((c) => c.file)).toEqual(["old.mp3", "new.mp3"]);
    calls[1]?.release();
    await flush();
    expect(player.isPlaying).toBe(true);
    expect(player.position).toBeCloseTo(1);
  });

  test("a seek during the wait changes where the play starts", async () => {
    const { player, calls } = gated();
    player.setTimeline(lineTimeline("a.mp3"));
    void player.play(0);
    await flush();
    player.seek(2);
    await flush();
    calls.at(-1)?.release();
    await flush();
    expect(player.isPlaying).toBe(true);
    expect(player.position).toBeCloseTo(2);
  });

  test("the wait is bounded, and a late sound starts part way in", async () => {
    vi.useFakeTimers();
    try {
      const { context, player, calls } = gated();
      player.setTimeline(lineTimeline("a.mp3"));
      const pending = player.play(0);
      await vi.advanceTimersByTimeAsync(LOAD_WAIT_MS - 1);
      expect(player.isLoading).toBe(true);
      await vi.advanceTimersByTimeAsync(2);
      expect(await pending).toBe(true);
      expect(player.isPlaying).toBe(true);
      // The file arrives 1 s of clock time later and starts 1 s in.
      context.currentTime = 1.05;
      calls[0]?.release();
      await vi.advanceTimersByTimeAsync(0);
      await flush();
      expect(context.started).toHaveLength(1);
      expect(context.started[0]?.offset).toBeCloseTo(1, 0);
      player.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a replaced play aborts its loads", async () => {
    const { player, calls } = gated();
    player.setTimeline(lineTimeline("a.mp3"));
    void player.play(0);
    await flush();
    expect(calls[0]?.signal?.aborted).toBe(false);
    player.configure({ speed: 2, keepPitch: true });
    await flush();
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls[1]).toMatchObject({ tempo: 2 });
    expect(calls[1]?.signal?.aborted).toBe(false);
    player.stop();
    expect(calls[1]?.signal?.aborted).toBe(true);
  });

  test("an aborted stretched load does not mark the file as failed", async () => {
    const { player, calls } = gated();
    player.setTimeline(lineTimeline("a.mp3"));
    player.configure({ speed: 2, keepPitch: true });
    void player.play(0);
    await flush();
    player.stop();
    await flush();
    void player.play(0);
    await flush();
    // The second play asks for the stretched copy again, not the original.
    expect(calls.map((c) => c.tempo)).toEqual([2, 2]);
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("playback speed", () => {
  // A 4 s line at 10 s and a 4 s BGM looping under a scene from 0 to 30 s.
  const speedTimeline: Timeline = {
    items: [
      {
        id: "a",
        kind: "line",
        sceneId: "s1",
        index: 0,
        startSec: 10,
        durationSec: 4,
        assetFile: "a b.mp3",
      },
    ],
    images: [],
    bgm: [
      {
        sceneId: "s1",
        volume: 0.5,
        startSec: 0,
        endSec: 30,
        assetFile: "bgm.mp3",
        assetDurationSec: 4,
      },
    ],
    scenes: [{ sceneId: "s1", startSec: 0, endSec: 30 }],
    durationSec: 30,
  };

  function setup(options: { failStretch?: boolean } = {}) {
    const context = new FakeContext();
    let tick: (() => void) | undefined;
    const loaded: { file: string; tempo: number }[] = [];
    const player = new Player({
      unlock: new AudioUnlock(() => context),
      load: async (file, tempo) => {
        loaded.push({ file, tempo });
        if (options.failStretch && tempo !== 1) throw new Error("500");
        return new TextEncoder().encode(`${file}@${tempo}`).buffer as ArrayBuffer;
      },
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => undefined,
    });
    player.setTimeline(speedTimeline);
    const advance = async (time: number) => {
      context.currentTime = time;
      tick?.();
      await flush();
    };
    return { context, player, loaded, advance };
  }

  test("keep pitch off plays the original with playbackRate and buffer seconds", async () => {
    const { context, player, advance } = setup();
    player.configure({ speed: 2, keepPitch: false });
    await player.play(0);
    await advance(4.9);
    const line = context.started.find((s) => s.file === "a b.mp3");
    // 10 s of drama is 5 s of clock, after the 0.05 s start delay.
    expect(line).toMatchObject({ rate: 2, offset: 0, duration: 4, tempo: 1 });
    expect(line?.when).toBeCloseTo(5.05);
    const bgm = context.started.find((s) => s.file === "bgm.mp3");
    expect(bgm).toMatchObject({ rate: 2, loop: true, offset: 0, duration: 30 });
  });

  test("keep pitch on plays a stretched copy at rate 1 with durations divided by the speed", async () => {
    const { context, player, loaded, advance } = setup();
    player.configure({ speed: 2, keepPitch: true });
    await player.play(0);
    await advance(4.9);
    const line = context.started.find((s) => s.file === "a b.mp3");
    expect(line).toMatchObject({ rate: 1, offset: 0, duration: 2, tempo: 2 });
    expect(line?.when).toBeCloseTo(5.05);
    expect(loaded.every((l) => l.tempo === 2)).toBe(true);
  });

  test("a play from 11 s starts the line part way in", async () => {
    for (const [keepPitch, offset, duration] of [
      [false, 1, 3],
      [true, 0.5, 1.5],
    ] as const) {
      const { context, player, advance } = setup();
      player.configure({ speed: 2, keepPitch });
      await player.play(11);
      await advance(0.1);
      const line = context.started.find((s) => s.file === "a b.mp3");
      expect(line?.offset).toBeCloseTo(offset);
      expect(line?.duration).toBeCloseTo(duration);
      // The line began 1 s before the start, so it starts at once.
      expect(line?.when).toBeCloseTo(0.05);
    }
  });

  test("a looping BGM wraps by the original length or by the copy length", async () => {
    // 11 s into a 4 s loop is 3 s.
    const off = setup();
    off.player.configure({ speed: 2, keepPitch: false });
    await off.player.play(11);
    expect(off.context.started.find((s) => s.file === "bgm.mp3")?.offset).toBeCloseTo(3);

    // The copy is 2 s long, and 3 s of the original is 1.5 s of the copy.
    const on = setup();
    on.player.configure({ speed: 2, keepPitch: true });
    await on.player.play(11);
    const bgm = on.context.started.find((s) => s.file === "bgm.mp3");
    expect(bgm?.bufferDuration).toBe(2);
    expect(bgm?.offset).toBeCloseTo(1.5);
    // Later loops wrap by the copy: 13 s is 1 s into the loop, 0.5 s of the copy.
    const later = setup();
    later.player.configure({ speed: 2, keepPitch: true });
    await later.player.play(13);
    expect(later.context.started.find((s) => s.file === "bgm.mp3")?.offset).toBeCloseTo(0.5);
  });

  test("a speed change while playing keeps the drama position", async () => {
    const { context, player, advance } = setup();
    await player.play(5);
    await advance(2.05);
    expect(player.position).toBeCloseTo(7);
    const stopped = context.stopped;
    player.configure({ speed: 1.5, keepPitch: true });
    expect(context.stopped).toBeGreaterThan(stopped);
    await flush();
    expect(player.isPlaying).toBe(true);
    expect(player.position).toBeCloseTo(7);
    // Drama time now runs 1.5 times the clock.
    context.currentTime = 2.1 + 2;
    expect(player.position).toBeCloseTo(7 + 3);
  });

  test("a play waits for the sounds of the next 2 s of clock time", async () => {
    const context = new FakeContext();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loaded: string[] = [];
    const player = new Player({
      unlock: new AudioUnlock(() => context),
      load: async (file, tempo) => {
        loaded.push(file);
        await gate;
        return new TextEncoder().encode(`${file}@${tempo}`).buffer as ArrayBuffer;
      },
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    player.setTimeline(speedTimeline);
    player.configure({ speed: 2, keepPitch: false });
    // The line is 2 s of drama ahead, which is within 2 s of clock time at x2.0.
    const pending = player.play(8);
    await flush();
    expect(player.isLoading).toBe(true);
    expect(player.isPlaying).toBe(false);
    expect(loaded.sort()).toEqual(["a b.mp3", "bgm.mp3"]);
    release();
    await pending;
    expect(player.isLoading).toBe(false);
    expect(player.isPlaying).toBe(true);
    await flush();
    expect(context.started.map((s) => s.file)).toContain("a b.mp3");
  });

  test("a buffer decoded at x1.0 is not reused at x2.0", async () => {
    const { context, player, loaded, advance } = setup();
    await player.play(10);
    await advance(0.1);
    expect(loaded.filter((l) => l.file === "a b.mp3")).toEqual([{ file: "a b.mp3", tempo: 1 }]);

    player.configure({ speed: 2, keepPitch: true });
    await flush();
    await advance(0.2);
    expect(loaded.filter((l) => l.file === "a b.mp3")).toEqual([
      { file: "a b.mp3", tempo: 1 },
      { file: "a b.mp3", tempo: 2 },
    ]);
    const stretched = context.started.filter((s) => s.file === "a b.mp3").at(-1);
    expect(stretched?.tempo).toBe(2);

    // Back at x1.0 the first buffer is used again only if it was kept; it never plays at x2.0.
    expect(context.started.filter((s) => s.tempo === 1 && s.rate === 2)).toEqual([]);
  });

  test("a failed preview plays that file with playbackRate", async () => {
    const { context, player, loaded, advance } = setup({ failStretch: true });
    player.configure({ speed: 2, keepPitch: true });
    await player.play(0);
    await advance(4.9);
    const line = context.started.find((s) => s.file === "a b.mp3");
    expect(line).toMatchObject({ rate: 2, offset: 0, duration: 4, tempo: 1 });
    // The stretched copy was tried once, then the original, and later ticks do not retry.
    await advance(5.5);
    expect(loaded.filter((l) => l.file === "a b.mp3")).toEqual([
      { file: "a b.mp3", tempo: 2 },
      { file: "a b.mp3", tempo: 1 },
    ]);
  });
});

import { describe, expect, test, vi } from "vitest";
import {
  type AudioBufferLike,
  type AudioContextLike,
  AudioUnlock,
  type BufferSourceLike,
  type GainNodeLike,
  Player,
} from "./audio.js";
import type { Timeline } from "./types.js";

type Started = { file: string; when: number; offset?: number; duration?: number; loop: boolean };

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
      connect: () => undefined,
      disconnect: () => undefined,
      start: (when, offset, duration) => {
        const file = (source.buffer as AudioBufferLike & { file: string }).file;
        this.started.push({ file, when, offset, duration, loop: source.loop });
      },
      stop: () => {
        this.stopped++;
      },
    };
    return source;
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    const file = new TextDecoder().decode(data);
    return Promise.resolve({ duration: 4, file } as AudioBufferLike);
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
    await player.play(0);
    await flush();
    player.stop();
    await player.play(0);
    rejectFirst(new Error("offline"));
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

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

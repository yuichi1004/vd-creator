import { describe, expect, test } from "vitest";
import {
  clampPosition,
  filesAround,
  formatTime,
  imageAt,
  itemAt,
  scheduleFrom,
  startOf,
} from "./playback.js";
import type { Timeline } from "./types.js";

// Scene s1: BGM looping a 4 s file from 0 to 6, line l1 0-2, sfx x1 overlapping 1-4, line l2
// 2.3-4.3 without audio, pause, line l3 5-6. Scene s2: line l4 6.3-7.3, no BGM.
const timeline: Timeline = {
  items: [
    {
      id: "i1",
      kind: "image",
      sceneId: "s1",
      index: 0,
      startSec: 0,
      durationSec: 0,
      assetFile: "a.png",
    },
    {
      id: "l1",
      kind: "line",
      sceneId: "s1",
      index: 1,
      startSec: 0,
      durationSec: 2,
      assetFile: "l1.mp3",
    },
    {
      id: "x1",
      kind: "sfx",
      sceneId: "s1",
      index: 2,
      startSec: 1,
      durationSec: 3,
      assetFile: "x1.mp3",
    },
    {
      id: "l2",
      kind: "line",
      sceneId: "s1",
      index: 3,
      startSec: 2.3,
      durationSec: 2,
      missing: true,
    },
    { kind: "pause", sceneId: "s1", index: 4, startSec: 4.3, durationSec: 0.7 },
    {
      id: "l3",
      kind: "line",
      sceneId: "s1",
      index: 5,
      startSec: 5,
      durationSec: 1,
      assetFile: "l3.mp3",
    },
    {
      id: "i2",
      kind: "image",
      sceneId: "s2",
      index: 0,
      startSec: 6,
      durationSec: 0,
      assetFile: "b.png",
    },
    {
      id: "l4",
      kind: "line",
      sceneId: "s2",
      index: 1,
      startSec: 6.3,
      durationSec: 1,
      assetFile: "l4.mp3",
    },
  ],
  images: [
    { imageId: "a", file: "a.png", startSec: 0, endSec: 6 },
    { imageId: "b", file: "b.png", startSec: 6, endSec: 7.3 },
  ],
  bgm: [
    {
      sceneId: "s1",
      volume: 0.3,
      startSec: 0,
      endSec: 6,
      assetFile: "bgm.mp3",
      assetDurationSec: 4,
    },
    { sceneId: "s2", volume: 0.3, startSec: 6, endSec: 7.3, missing: true },
  ],
  scenes: [
    { sceneId: "s1", startSec: 0, endSec: 6 },
    { sceneId: "s2", startSec: 6, endSec: 7.3 },
  ],
  durationSec: 7.3,
};

describe("scheduleFrom", () => {
  test("play all schedules every sound with audio, sorted by start", () => {
    expect(scheduleFrom(timeline, 0)).toEqual([
      {
        key: "bgm:s1",
        file: "bgm.mp3",
        atSec: 0,
        offsetSec: 0,
        durationSec: 6,
        loop: true,
        gain: 0.3,
      },
      {
        key: "item:l1",
        file: "l1.mp3",
        atSec: 0,
        offsetSec: 0,
        durationSec: 2,
        loop: false,
        gain: 1,
      },
      {
        key: "item:x1",
        file: "x1.mp3",
        atSec: 1,
        offsetSec: 0,
        durationSec: 3,
        loop: false,
        gain: 1,
      },
      {
        key: "item:l3",
        file: "l3.mp3",
        atSec: 5,
        offsetSec: 0,
        durationSec: 1,
        loop: false,
        gain: 1,
      },
      {
        key: "item:l4",
        file: "l4.mp3",
        atSec: 6.3,
        offsetSec: 0,
        durationSec: 1,
        loop: false,
        gain: 1,
      },
    ]);
  });

  test("playing from the middle starts running sounds part way in", () => {
    const sounds = scheduleFrom(timeline, 1.5);
    expect(sounds.map((s) => s.key)).toEqual([
      "bgm:s1",
      "item:l1",
      "item:x1",
      "item:l3",
      "item:l4",
    ]);
    const l1 = sounds.find((s) => s.key === "item:l1");
    expect(l1).toMatchObject({ atSec: 1.5, offsetSec: 1.5, durationSec: 0.5 });
    const x1 = sounds.find((s) => s.key === "item:x1");
    expect(x1).toMatchObject({ atSec: 1.5, offsetSec: 0.5, durationSec: 2.5 });
  });

  test("a looping BGM starts at the right point of its loop", () => {
    const bgm = scheduleFrom(timeline, 5).find((s) => s.key === "bgm:s1");
    expect(bgm).toMatchObject({ atSec: 5, offsetSec: 1, durationSec: 1, loop: true });
  });

  test("sounds that have ended, and missing audio, are left out", () => {
    expect(scheduleFrom(timeline, 6).map((s) => s.key)).toEqual(["item:l4"]);
    expect(scheduleFrom(timeline, 2.5).some((s) => s.file === undefined)).toBe(false);
    expect(scheduleFrom(timeline, 7.3)).toEqual([]);
  });

  test("play from an item starts at the item", () => {
    const from = startOf(timeline, "l3");
    expect(from).toBe(5);
    expect(scheduleFrom(timeline, from ?? 0)[0]).toMatchObject({ key: "bgm:s1", atSec: 5 });
    expect(startOf(timeline, "nope")).toBeUndefined();
  });
});

test("filesAround keeps only files playing or due soon, for decoding on demand", () => {
  const sounds = scheduleFrom(timeline, 0);
  expect(filesAround(sounds, 0, 2)).toEqual(["bgm.mp3", "l1.mp3", "x1.mp3"]);
  expect(filesAround(sounds, 4.5, 1)).toEqual(["bgm.mp3", "l3.mp3"]);
  expect(filesAround(sounds, 6.5, 8)).toEqual(["l4.mp3"]);
});

test("imageAt follows the timeline", () => {
  expect(imageAt(timeline, 0)?.imageId).toBe("a");
  expect(imageAt(timeline, 5.9)?.imageId).toBe("a");
  expect(imageAt(timeline, 6)?.imageId).toBe("b");
  expect(imageAt(timeline, 99)?.imageId).toBe("b");
  expect(imageAt({ ...timeline, images: [] }, 1)).toBeUndefined();
});

test("itemAt gives the latest started item", () => {
  expect(itemAt(timeline, 0.5)?.id).toBe("l1");
  expect(itemAt(timeline, 1.5)?.id).toBe("x1");
  expect(itemAt(timeline, 2.15)?.id).toBe("x1");
  expect(itemAt(timeline, 4.5)?.kind).toBe("pause");
});

test("clampPosition and formatTime", () => {
  expect(clampPosition(timeline, 99)).toBe(7.3);
  expect(clampPosition(timeline, -1)).toBe(0);
  expect(clampPosition(timeline, Number.NaN)).toBe(0);
  expect(formatTime(0)).toBe("0:00");
  expect(formatTime(75.9)).toBe("1:15");
});

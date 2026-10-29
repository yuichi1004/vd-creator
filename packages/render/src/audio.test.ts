import type { Timeline } from "@vd-creator/core";
import { describe, expect, test } from "vitest";
import { buildAudioMixArgs, RenderError } from "./audio.js";

const TIMELINE: Timeline = {
  items: [
    { kind: "image", sceneId: "s1", index: 0, startSec: 0, durationSec: 0, assetFile: "i/a.png" },
    {
      id: "fx1",
      kind: "sfx",
      sceneId: "s1",
      index: 1,
      startSec: 0,
      durationSec: 4,
      assetFile: "sfx/fx1.wav",
    },
    {
      id: "l1",
      kind: "line",
      sceneId: "s1",
      index: 2,
      startSec: 0.25,
      durationSec: 1.5,
      assetFile: "voice/l1.wav",
    },
    {
      id: "l2",
      kind: "line",
      sceneId: "s1",
      index: 3,
      startSec: 1.75,
      durationSec: 1,
      missing: true,
    },
    { kind: "pause", sceneId: "s1", index: 4, startSec: 2.75, durationSec: 1 },
    {
      id: "l3",
      kind: "line",
      sceneId: "s1",
      index: 5,
      startSec: 3.75,
      durationSec: 1,
      assetFile: "voice/l3.wav",
    },
    {
      id: "l4",
      kind: "line",
      sceneId: "s2",
      index: 0,
      startSec: 4.5,
      durationSec: 1.25,
      assetFile: "voice/l4.wav",
    },
    {
      id: "l5",
      kind: "line",
      sceneId: "s2",
      index: 1,
      startSec: 5.75,
      durationSec: 1,
      missing: true,
      invalid: true,
    },
  ],
  images: [],
  bgm: [
    {
      sceneId: "s1",
      volume: 0.3,
      startSec: 0,
      endSec: 4.75,
      assetFile: "bgm/s1.wav",
      assetDurationSec: 2,
    },
    { sceneId: "s2", volume: 0.5, startSec: 4.5, endSec: 6.75, missing: true },
  ],
  scenes: [
    { sceneId: "s1", startSec: 0, endSec: 4.75 },
    { sceneId: "s2", startSec: 4.5, endSec: 6.75 },
  ],
  durationSec: 6.75,
};

/** The value after a flag, such as the filter graph after -filter_complex. */
function after(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  expect(i).toBeGreaterThanOrEqual(0);
  return args[i + 1] as string;
}

/** The input files, in input order, with the flags just before each -i. */
function inputs(args: string[]): string[] {
  return args.flatMap((a, i) => (a === "-i" ? [args[i + 1] as string] : []));
}

function chains(args: string[]): string[] {
  return after(args, "-filter_complex").split(";");
}

describe("buildAudioMixArgs", () => {
  const args = buildAudioMixArgs(TIMELINE, { output: "out/drama.mp3" });

  test("starts from silence as long as the timeline", () => {
    expect(args.slice(args.indexOf("-f"), args.indexOf("-i") + 2)).toEqual([
      "-f",
      "lavfi",
      "-t",
      "6.75",
      "-i",
      "anullsrc=r=48000:cl=stereo",
    ]);
  });

  test("inputs every line and SFX with an asset, then the BGM, and leaves out missing ones", () => {
    expect(inputs(args)).toEqual([
      "anullsrc=r=48000:cl=stereo",
      "assets/sfx/fx1.wav",
      "assets/voice/l1.wav",
      "assets/voice/l3.wav",
      "assets/voice/l4.wav",
      "assets/bgm/s1.wav",
    ]);
  });

  test("delays each clip to its start time in milliseconds", () => {
    const c = chains(args);
    expect(c[0]).toMatch(/^\[1:a\].*,adelay=0:all=1\[a1\]$/);
    expect(c[1]).toMatch(/^\[2:a\].*,adelay=250:all=1\[a2\]$/);
    // l2 is missing, so l3 keeps its own start time.
    expect(c[2]).toMatch(/^\[3:a\].*,adelay=3750:all=1\[a3\]$/);
    expect(c[3]).toMatch(/^\[4:a\].*,adelay=4500:all=1\[a4\]$/);
    for (const chain of c.slice(0, 4)) {
      expect(chain).toContain("aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo");
    }
  });

  test("loops the BGM over its scene, fades it, and ducks it while mixed lines play", () => {
    const i = args.indexOf("assets/bgm/s1.wav");
    expect(args.slice(i - 3, i)).toEqual(["-stream_loop", "-1", "-i"]);
    expect(chains(args)[4]).toBe(
      [
        "[5:a]atrim=duration=4.75",
        "asetpts=PTS-STARTPTS",
        "aresample=48000",
        "aformat=sample_fmts=fltp:channel_layouts=stereo",
        // l1 and l3, clipped to the scene. l4 starts in the overlap with s2 and is merged with
        // l3. The missing l2 does not duck.
        "volume='0.3*(1-0.5*(between(t,0.25,1.75)+between(t,3.75,4.75)))':eval=frame",
        "afade=t=in:st=0:d=1",
        "afade=t=out:st=3.75:d=1",
        "adelay=0:all=1[a5]",
      ].join(","),
    );
  });

  test("shortens the BGM fades for a short scene and uses a plain volume without lines", () => {
    const short: Timeline = {
      items: [],
      images: [],
      bgm: [{ sceneId: "s", volume: 0.8, startSec: 1, endSec: 2.5, assetFile: "bgm/s.wav" }],
      scenes: [{ sceneId: "s", startSec: 1, endSec: 2.5 }],
      durationSec: 2.5,
    };
    expect(chains(buildAudioMixArgs(short, { output: "o.mp3" }))[0]).toBe(
      "[1:a]atrim=duration=1.5,asetpts=PTS-STARTPTS,aresample=48000," +
        "aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.8," +
        "afade=t=in:st=0:d=0.75,afade=t=out:st=0.75:d=0.75,adelay=1000:all=1[a1]",
    );
  });

  test("mixes without normalization, then normalizes the loudness to -16 LUFS", () => {
    expect(chains(args).at(-1)).toBe(
      "[0:a][a1][a2][a3][a4][a5]amix=inputs=6:duration=first:dropout_transition=0:normalize=0," +
        "loudnorm=I=-16:TP=-1.5:LRA=11," +
        "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[out]",
    );
    expect(after(args, "-map")).toBe("[out]");
  });

  test("encodes MP3 at 192 kbps by default and WAV on request", () => {
    expect(args.slice(-7)).toEqual([
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      "-f",
      "mp3",
      "out/drama.mp3",
    ]);
    const wav = buildAudioMixArgs(TIMELINE, { output: "x.tmp", format: "wav" });
    expect(wav.slice(-5)).toEqual(["-c:a", "pcm_s16le", "-f", "wav", "x.tmp"]);
  });

  test("reads assets from another folder when asked", () => {
    const other = buildAudioMixArgs(TIMELINE, { output: "o.mp3", assetsDir: "proj/assets" });
    expect(inputs(other)[1]).toBe("proj/assets/sfx/fx1.wav");
  });

  test("mixes only the silence when no item has an asset", () => {
    const empty: Timeline = { ...TIMELINE, items: TIMELINE.items.slice(3, 5), bgm: [] };
    const c = chains(buildAudioMixArgs(empty, { output: "o.mp3" }));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatch(/^\[0:a\]amix=inputs=1:/);
  });

  test("refuses an empty timeline", () => {
    const empty: Timeline = { items: [], images: [], bgm: [], scenes: [], durationSec: 0 };
    expect(() => buildAudioMixArgs(empty, { output: "o.mp3" })).toThrow(RenderError);
  });
});

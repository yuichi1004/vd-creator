# 0006: Rendering

- Status: In progress
- Date: 2026-10-29
- Depends on: [0003](0003-scenario-format.md), [0004](0004-providers-and-generation.md)

## Background

A finished drama leaves vd-creator as a file: an audio file to listen to, or a video with still images for sites such as YouTube ([README](../../README.md)). [0002](0002-architecture.md) chose ffmpeg as a system dependency for this. The timeline from [0004](0004-providers-and-generation.md) already says when every clip and image starts, so rendering turns that timeline into ffmpeg commands.

## Goals / Non-goals

Goals:

- Mix voices, SFX, and BGM into one audio file with consistent loudness.
- Export a video that shows the still images at the right times, with the mixed audio.
- Export subtitles (SRT) from the lines.
- `vd render`.

Non-goals:

- Burned-in subtitles, transitions, Ken Burns effects, and other video effects. Follow-ups can add them.
- Rendering from the UI.
- Rendering with missing assets. `vd render` fails and lists the items to generate first.

## Design

### Approach

`packages/render` builds ffmpeg arguments as plain data from the timeline (pure functions, unit tested), then runs ffmpeg with `node:child_process` `spawn`. No ffmpeg wrapper library is added. Building arguments separately from running them keeps tests fast and lets `vd render --print-command` show what will run.

### Audio mix

- Each voice and SFX clip is placed with `adelay` at its `startSec`.
- BGM for a scene is looped with `aloop` (or `-stream_loop`) to the scene's length, set to its `volume`, faded in and out over 1 second, and ducked to half volume while a line plays, using the line spans from the timeline (not sidechain compression, which is harder to test).
- Everything is mixed with `amix` (with `normalize=0`) and normalized with `loudnorm` to -16 LUFS integrated, a common target for spoken audio online.
- Output: `out/drama.mp3` (192 kbps) by default, or `out/drama.wav` with `--format wav`.

### Video

- Each image span from the timeline becomes one entry in an ffmpeg concat list with its duration. If no image is shown at the start, a black frame fills the gap.
- Images are scaled and padded to 1920x1080 without cropping.
- The video is H.264 (`yuv420p`, 30 fps, `-tune stillimage`) and the audio is the mixed audio as AAC, in `out/drama.mp4`.

### Subtitles

`out/drama.srt` has one cue per line, from `startSec` to the end of its audio, with the text. When speakers differ, the cue starts with the speaker name.

### `vd render`

```
vd render [dir] [--video] [--srt] [--format mp3|wav] [--print-command]
```

It checks that ffmpeg is on `PATH`, that every item has an asset, and that the project license check from [0007](0007-sound-library.md) has no errors, then renders. The audio is always rendered, and the video uses it. It also writes `out/credits.txt` with `buildCreditsText` from `@vd-creator/library` (0007), so that the attributions ship with every render.

## Tasks

- [x] Audio mix and subtitles
  - Target: `packages/render/`
  - Change: `buildAudioMixArgs(timeline, options)`, `renderAudio(projectDir, options)`, `buildSrt(timeline, scenario)`, and a small `runFfmpeg` helper that reports ffmpeg's stderr on failure.
  - Constraints: no new dependencies. ffmpeg is the only external program.
  - Ownership: `packages/render/` except `src/video.ts` and `src/video.test.ts`.
  - Acceptance: `npm test -w packages/render` passes, including: unit tests for the argument builder (delays, BGM loop and ducking, loudnorm), an SRT snapshot for the 0003 sample, and an integration test that renders a mock-generated project with the real ffmpeg and checks the output duration with `ffprobe`.
- [ ] Video export
  - Target: `packages/render/src/video.ts`, `packages/render/src/video.test.ts`
  - Change: `buildVideoArgs(timeline, options)` and `renderVideo(projectDir, options)` as described above, exported from the package index.
  - Constraints: no new dependencies. Depends on the audio task.
  - Ownership: `packages/render/src/video.ts`, `packages/render/src/video.test.ts`, and the export line in `packages/render/src/index.ts`.
  - Acceptance: `npm test -w packages/render` passes, including an integration test that renders a mock project with two images and checks with `ffprobe` that the video is 1920x1080 and as long as the audio.
- [ ] `vd render`
  - Target: `apps/cli/`
  - Change: the command described above.
  - Constraints: no new dependencies. Depends on the video task and on the 0007 project integration task. Must not run at the same time as another task that owns `apps/cli/`, such as `vd serve` in 0005.
  - Ownership: `apps/cli/`.
  - Acceptance: `npm test -w apps/cli` passes, with a test that runs `init`, `generate` with the mock, and `render --video --srt`, then checks that the output files, including `credits.txt`, exist. A test checks that a missing asset fails with the item IDs listed, and that a license error stops the render.

## Open questions

- Should the loudness target be configurable per project? The default is a fixed -16 LUFS.
- Is 1920x1080 enough, or is a vertical 1080x1920 preset wanted for short-video sites?

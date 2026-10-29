# 0006: Rendering

- Status: Done
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

- Each distinct image is fitted once, without cropping, into a 1920x1080 PNG still over black, in a temporary folder under `out/` that is removed after the render. Transparent areas show black.
- Each image span from the timeline becomes one entry in a concat demuxer list that names a still and its duration. If no image is shown at the start, a black still fills the gap. One ffmpeg input per span used several GB of memory for 120 spans, which is why the stills are made first.
- `buildVideoArgs` returns `{ stills, concatList, args }`: the commands that make the stills, the list text, and the final encode. `vd render --print-command` prints all of them.
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
- [x] Video export
  - Target: `packages/render/src/video.ts`, `packages/render/src/video.test.ts`
  - Change: `buildVideoArgs(timeline, options)` and `renderVideo(projectDir, options)` as described above, exported from the package index.
  - Constraints: no new dependencies. Depends on the audio task.
  - Ownership: `packages/render/src/video.ts`, `packages/render/src/video.test.ts`, and the export line in `packages/render/src/index.ts`.
  - Acceptance: `npm test -w packages/render` passes, including an integration test that renders a mock project with two images and checks with `ffprobe` that the video is 1920x1080 and as long as the audio.
  - Review notes: EXIF rotation of phone JPEGs is not applied. Low-severity follow-ups: pass `-safe 1` to the concat demuxer explicitly, although the list holds only generated names; libx264 uses the `medium` preset, so 1080p encodes at about real time, and a faster preset may be worth it.
- [x] `vd render`
  - Target: `apps/cli/`
  - Change: the command described above. The video step uses the `{ stills, concatList, args }` shape from `buildVideoArgs`.
  - Constraints: no new dependencies. Depends on the video task and on the 0007 project integration task. Must not run at the same time as another task that owns `apps/cli/`, such as `vd serve` in 0005.
  - Ownership: `apps/cli/`.
  - Acceptance: `npm test -w apps/cli` passes, with a test that runs `init`, `generate` with the mock, and `render --video --srt`, then checks that the output files, including `credits.txt`, exist. A test checks that a missing asset fails with the item IDs listed, and that a license error stops the render.
  - Review notes: the worker's own Claude review, then one independent Claude review and one fix round. `--print-command` starts with a quoted `cd` into the project, keeps scenario text out of its here-documents, and quotes every argument. `credits.txt` and `drama.srt` are written through a temporary file renamed over the target, so a symbolic link there is replaced, not followed. Follow-ups: a symbolic link at `out/` itself is still followed; `renderAudio` and `renderVideo` load the scenario again, so an edit during a render is rendered unchecked; when the video encode fails, the new audio sits next to the old video; stale outputs from earlier renders with other flags are not removed; README does not describe the `vd` commands yet.

## Open questions

- Should the loudness target be configurable per project? The default is a fixed -16 LUFS.
- Is 1920x1080 enough, or is a vertical 1080x1920 preset wanted for short-video sites?

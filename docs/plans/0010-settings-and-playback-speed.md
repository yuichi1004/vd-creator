# 0010: Settings screen and playback speed

- Status: Draft
- Date: 2026-10-31
- Depends on: [0005](0005-review-ui.md)

## Background

Reviewing a drama means listening to it again and again. At normal speed a 10-minute episode takes 10 minutes for every pass. Users want to play it faster to check the flow and the feel of a scene quickly, and sometimes slower to catch how one line is read. The review UI (0005) has one page and no place for settings.

## Goals / Non-goals

Goals:

- Screens and navigation in the UI, so that this plan and later plans (0011, 0012, 0013) can add screens without a router library.
- A settings screen. Its first setting is the playback speed, from x0.5 to x2.0.
- A quick speed control next to the play controls, on PC and phone.
- Speed that keeps the pitch of voices by default, so that x2.0 still sounds like the same actors.
- Playback that stays in sync at any speed: lines, SFX, BGM, and the image lane follow the same clock.
- `GET /api/server`, a home for facts about the whole server, which later plans extend.

Non-goals:

- Changing the speed of the rendered drama. `vd render` always renders at x1.0.
- Settings stored on the server or in the user's `config.yaml`. Speed is a choice of the person listening on that device, so it lives in the browser.
- A settings editor for `config.yaml`. The settings screen shows server facts read-only.

## Design

### Screens

The UI gets hash routes, so that every screen works under a path prefix (0005) and needs no server change:

| Route | Screen |
|---|---|
| `#/` | The review screen of 0005, unchanged |
| `#/settings` | Settings |

A small module without React parses and builds routes, so it can be unit tested. The header gets a settings button (a gear icon with a text label for screen readers). On a phone the settings screen is full screen with a back button. Browser back returns to the review screen and keeps the playback position. Unknown routes show the review screen.

### Settings screen

Sections:

- **Playback**
  - Speed: a slider from 0.5 to 2.0 in steps of 0.05, and buttons for x0.5, x0.75, x1.0, x1.25, x1.5, and x2.0. The current value is shown as text, such as "x1.25".
  - Keep pitch: on by default. When off, speed works like a tape: faster is higher.
- **About this server**, read-only, from `GET /api/server`: the provider and whether it is paid, the library's name when one is set, and the vd version. No file paths are shown, because the page may be open on a phone.

Settings are saved in `localStorage` under one key, `vd-creator.settings`, as JSON with a version number. Every read and write is wrapped in try/catch, and the defaults apply when storage is missing, blocked, or holds something invalid. So a phone and a PC each keep their own speed.

### Quick speed control

The player (header on PC, bottom bar on phone) shows the current speed as a button, such as "x1.0". A tap cycles through x1.0, x1.25, x1.5, x2.0, and back. Other values are set on the settings screen, because the phone bar has little room. A change while playing takes effect at once, from the current position.

### Playback at a speed

The scheduler in `apps/web/src/audio.ts` maps the drama's timeline to the audio clock. Today it starts each sound with `source.start(when, offset, duration)`, where `offset` and `duration` count seconds of the buffer, and BGM loops wrap the offset by the buffer's length. Speed `r` changes the mapping:

- Drama time advances `r` seconds per second of clock time. A sound at drama time `t` starts at clock time `clockStart + (t - startSec) / r`. The playback position, the image lane, and "play from here" stay in drama time.
- **Keep pitch off**: the original buffer plays with `playbackRate = r`. `offset` and `duration` stay in seconds of the original buffer, unchanged, because `start()` counts buffer time and the rate applies on top. Loop wrapping uses the original length.
- **Keep pitch on** (default): the buffer is a copy stretched to `1/r` of the length (below), played at rate 1. `offset` and `duration` are divided by `r`, and loop wrapping uses the copy's length.
- A sound that starts late is started part way in, as today. To keep that from clipping the first lines at a new speed, a play or a speed change waits until the sounds of the next 2 seconds of clock time are decoded, and shows "loading" meanwhile.
- The decode lookahead counts drama time, so that it covers as much of the drama at x2.0 as at x1.0. Decoded buffers are keyed by file and tempo, so a buffer decoded at one speed is never played at another.
- Changing the speed while playing stops the scheduled sounds and starts again from the current drama position at the new speed, the same way a seek does.

### Time-stretched copies

Web Audio has no time stretch that keeps pitch, and adding a library for it is heavy. The server already needs ffmpeg, whose `atempo` filter covers exactly 0.5 to 2.0 in one pass. So the server makes the stretched copy:

- `GET /preview/<file>?tempo=<r>` returns the asset `assets/<file>` stretched by `atempo=<r>`, as 16-bit PCM WAV. WAV adds no encoder padding, so lines stay in sync and BGM loops stay seamless, and it needs no optional ffmpeg encoder. `tempo=1` returns the original file.
- `r` must be one of the values the slider can produce (0.5 to 2.0 in steps of 0.05), otherwise 400.
- Only files with an audio extension the project uses (`.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`) are accepted. The same path checks as `/assets/*` apply.
- The server opens the file itself, refusing symbolic links (`O_NOFOLLOW`) after the path check, and pipes it to ffmpeg's stdin with the input format forced from the extension (`-f <format> -i pipe:0`). ffmpeg never opens a path from the request and never guesses a format such as a playlist from the content.
- Copies are cached outside the project, in `vd-creator/preview/` under the user's cache folder (`$XDG_CACHE_HOME`, or `~/.cache` when it is not set), keyed by the SHA-256 of the source file and the tempo. A copy is written to a temporary name and renamed when complete, so no partial file is ever served. The cache is limited to 500 MB, and the oldest files are removed first.
- At most two ffmpeg processes run at once. A conversion that fails, or takes more than 30 seconds, returns 500 with fixed text.
- If ffmpeg is not on `PATH`, `GET /api/server` reports `preview: { keepPitch: false }`, the setting is shown as unavailable with a short reason, and playback uses `playbackRate`.
- Library previews in the library panel always play at x1.0.

### API additions

| Method and path | Purpose |
|---|---|
| `GET /api/server` | Facts about the whole server: `provider` (`id`, `paid`), `library` (`{ name }` or absent), `version`, and `preview: { keepPitch: boolean }`. Later plans add fields. |
| `GET /preview/*?tempo=<r>` | A time-stretched copy of a project asset, as above. |

With `--host`, both check the token like every route. `/preview/` joins the paths that the server never answers with the web UI. `GET /api/project` is unchanged.

## Tasks

Run in order. The server task's first review uses Codex `gpt-6.1-sol`, because it runs ffmpeg on files named by requests. The other tasks use a Claude reviewer.

- [ ] Server info and preview endpoint
  - Target: `apps/server/`
  - Change: `GET /api/server`, `GET /preview/*?tempo=<r>` with the file checks, the cache, and the ffmpeg limits, with types in `api.ts`. Update the API table of 0005 with a link to this plan.
  - Constraints: no new dependencies. ffmpeg runs with an argument list, never through a shell, and reads only from stdin. Tests use a fake ffmpeg runner, plus one test with real ffmpeg that is skipped when ffmpeg is missing.
  - Ownership: `apps/server/`, and the API table in plan 0005.
  - Acceptance: `npm test -w apps/server` passes, with tests that a tempo outside the allowed values returns 400; that `/preview/../scenario.yaml`, a non-audio file, and a symbolic link inside `assets/` are refused; that a second request reuses the cached copy without running ffmpeg; that a failed conversion leaves no file in the cache; that `keepPitch` is false without ffmpeg; and, with real ffmpeg, that a 2.0 s WAV at tempo 2 comes back about 1.0 s long.
- [ ] Screens and settings storage
  - Target: `apps/web/src/`
  - Change: the hash route module, the settings screen with the playback section and the server section, the settings button in the header, and the settings store in `localStorage` with defaults and a version number. The speed control is shown but only saves the value; playback uses it in the next task.
  - Constraints: no new dependencies and no router library. Every control works by tap, with targets of at least 44 by 44 px. Back from the settings screen keeps the playback position. Depends on the first task.
  - Ownership: `apps/web/src/` except `audio.ts` and `playback.ts`.
  - Acceptance: `npm run build -w apps/web && npm test -w apps/web` pass, with tests that routes parse and build under a path prefix, that settings fall back to defaults when storage throws or holds invalid JSON, and that a saved speed is read back.
- [ ] Playback at a speed
  - Target: `apps/web/src/audio.ts`, `apps/web/src/playback.ts`, the player components
  - Change: the scheduler mapping above, both pitch modes, the wait for the first buffers, the lookahead in drama time, buffers keyed by tempo, the quick speed control, and the change of speed while playing. With keep pitch on, sounds load from `preview/<file>?tempo=<r>`.
  - Constraints: no new dependencies. The playback position stays in drama time. Depends on the first two tasks.
  - Ownership: `apps/web/src/`.
  - Acceptance: `npm test -w apps/web` passes, with tests that, at x2.0 and from a play at 0: a 4 s line at drama time 10 s starts 5 s later on the clock. With keep pitch off, it starts with `playbackRate` 2, offset 0, and duration 4. With keep pitch on, it plays at rate 1 with duration 2. A play from drama time 11 s starts it at offset 1 (off) or 0.5 (on). A looping BGM wraps by the right length in each mode. A speed change while playing keeps the drama position. A buffer decoded at x1.0 is not reused at x2.0. Preview URLs stay relative to the page. Before the plan is closed, the coordinator plays the first scene at x0.5, x1.0, and x2.0 in a browser at 1280 px and 375 px widths, and the human checks on a phone that x2.0 keeps the voices' pitch.

## Open questions

- Should the speed also apply to "play this line" in the scene list? The default is yes, because it uses the same scheduler.
- Should the settings screen later hold other per-device choices, such as the volume of BGM while reviewing? Not in this plan.

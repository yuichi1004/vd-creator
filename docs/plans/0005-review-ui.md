# 0005: Review UI

- Status: In progress
- Date: 2026-10-29
- Depends on: [0003](0003-scenario-format.md), [0004](0004-providers-and-generation.md), [0007](0007-sound-library.md)

## Background

The UI is where a human listens to what the agent produced and fixes it ([README](../../README.md), [0002](0002-architecture.md)). It is a browser page served by `vd serve`, talking to a local HTTP server that reads and writes the same project folder as the CLI.

## Goals / Non-goals

Goals:

- A local server (`apps/server`) with an HTTP API over one project folder.
- A React UI (`apps/web`) to play the drama, see the timeline with still images, edit lines, and regenerate items.
- Decide how the UI may trigger paid generation (0002 open question).
- Pick up edits that an agent makes to `scenario.yaml` while the UI is open.
- Basic operation on both a PC and a smartphone: play, follow the images, edit a line, change the take, regenerate, and pick a library sound.
- A library panel: search the shared library (0007), preview a sound, use it for an SFX or BGM, and verify its license record.
- Access from a phone, with Tailscale as the recommended way, and an opt-in fallback protected by a token.
- `vd serve`.

Non-goals:

- Rendering from the UI. `vd render` (0006) is enough at first.
- Adding or reordering scenes and items in the UI. Agents do structural edits. The UI edits text, speaker, timing, takes, and the sound source of SFX and BGM.
- Multiple projects per server, user accounts, and access from the internet. The server listens on `127.0.0.1` unless `--host` is given (see below).
- Importing files into the library from the UI. `vd library import` covers it.
- Waveform display and drag-to-move timing. A follow-up can add them.
- An installable app (PWA) or offline use.

## Design

### Paid generation from the UI

The server runs with one provider, chosen by `vd serve --provider`, which defaults to `mock`. When that provider is paid, regeneration is a two-step call: the UI first asks for a plan and shows the estimated characters, and the user must press "Generate (N characters)" to send the same request with `confirm: true`. The server refuses a paid generation without `confirm`. Nothing in the UI can switch the provider.

### Access from a phone

By default the server listens on `127.0.0.1`, so only the PC can open it.

**The recommended way to use a phone is [Tailscale](https://tailscale.com/)**, a private network between the user's own devices. It works at home and away, encrypts traffic, and keeps the UI off the local network and the internet. The server stays on `127.0.0.1`, and Tailscale forwards to it:

```sh
vd serve my-drama                  # Listens on 127.0.0.1:5310
tailscale serve --bg 5310          # Makes it reachable from the user's tailnet over HTTPS
```

The phone, signed in to the same tailnet, opens the `https://<machine>.<tailnet>.ts.net/` URL that `tailscale serve` prints. Access is limited by the tailnet's own access controls. `tailscale funnel`, which publishes to the internet, must not be used. vd itself does not call or configure Tailscale; the guide in the docs task below explains these steps.

Other VPNs and SSH tunnels work the same way: anything that forwards to `127.0.0.1:5310` from a trusted network.

Without a token, the server accepts a request only if its `Host` header names an allowed host: `localhost`, `127.0.0.1`, `[::1]`, any name ending in `.ts.net`, or a name given with `vd serve --allow-host <name>` (repeatable), each with or without a port. Others get 403 with a fixed body. This stops DNS rebinding, where a hostile web page points its own name at `127.0.0.1` and then calls the API as a same-origin page. A `.ts.net` name resolves only to addresses of its own tailnet, so it cannot be rebound to the user's machine. A user's own reverse proxy either rewrites `Host` to `127.0.0.1:<port>` or is named with `--allow-host`. With `--host`, the token check applies instead. (Added during implementation, after the server review.)

**Fallback without a VPN:** `vd serve --host <addr>`, for example `0.0.0.0` or the machine's Tailscale IP, listens on that address directly. Then:

- The server creates a random token at start, and `vd serve` prints the URL with it for each address of the machine.
- Every request needs the token: from the `?token=` query on the first visit, after which the server sets an `HttpOnly`, `SameSite=Strict` cookie and redirects to the same page without the query, using a relative `Location` so that it works under a path prefix. Every response carries `Referrer-Policy: no-referrer`. Requests without the token get 401. With the default `127.0.0.1` host no token is needed. (The redirect and the header were added during implementation.)
- The server prints a warning that anyone on the network with the URL can edit the project and, with a paid provider, spend money, and that Tailscale is the recommended way. A paid provider still needs the confirm step for every generation.
- Traffic is plain HTTP. vd adds no TLS.

The UI must also work behind a user's own reverse proxy that serves it under a path prefix, such as `http://host/app/vd/`, while the server stays on `127.0.0.1`:

- The web build uses relative URLs for its files (Vite `base: "./"`), and the API client builds every URL relative to the page, never from `/`. The server needs no prefix setting.
- The web build puts its files under `ui/` (Vite `build.assetsDir: "ui"`), so they never collide with the project's `/assets/`. (Added during implementation.)
- Cookies set by the server have no fixed `Path` that assumes the root.
- Live updates use server-sent events, which are plain HTTP. If the event stream fails or is buffered by a proxy, the UI falls back to polling `GET /api/project` every 5 seconds. No WebSocket is used.

### Library in the UI

When the server knows a library (`VD_LIBRARY` or `vd serve --library`), the UI shows a library panel. Without one, the panel is hidden. The panel searches entries by words and kind, plays a preview, shows each entry's license, attribution, and verified state, and has "use for this SFX/BGM", which writes `{ library: <id> }` into the scenario and resolves the entry into the project (0007). "Verify" shows the evidence link and the license record, and marks the entry verified only after the user confirms. Validation issues from the license check (0007) appear next to the items they concern.

### HTTP API

| Method and path | Purpose |
|---|---|
| `GET /api/project` | Scenario, validation issues, timeline, and provider info (`id`, `paid`). |
| `GET /api/events` | Server-sent events: `project-changed` when `scenario.yaml` or `cache.json` changes on disk. |
| `PATCH /api/items/:id` | Change `text`, `speaker`, `gapBeforeSec`, or `take` of one item, or the source of an SFX (`{ prompt }` or `{ library }`). Saved through `updateItem`, so comments survive. |
| `PATCH /api/scenes/:id` | Change the scene's BGM source and volume. |
| `POST /api/generate` | Body `{ ids?: string[], dryRun?: boolean, confirm?: boolean }`. With `dryRun: true`, returns the plan only and never generates, for any provider. Otherwise it runs: a free provider runs at once and ignores `confirm`; a paid provider runs only with `confirm: true`, and without it returns 409 `confirm-required` with the plan in the body, so the UI can show "Generate (N characters)". Library items are resolved, not generated, and cost nothing. (The `dryRun` field and the 409 body were fixed during implementation, because the first wording left a request without `confirm` meaning both "plan" and "refuse".) |
| `GET /api/library` | Query `q`, `kind`. Entries with license and verified state. 404 when no library is set. |
| `POST /api/library/:kind/:id/verify` | Body `{ confirm: true, approveCommercial?: boolean }`. Marks the entry verified. |
| `GET /library-files/:kind/:id` | The entry's audio, for preview. Only files named in an `entry.yaml` are served. |
| `GET /assets/*` | Files under the project's `assets/`, with path traversal rejected. |
| `GET /*` | The built web UI. |

With `--host`, every route above checks the token.

The request and response types live in `apps/server/src/api.ts`. `apps/web` imports them with `import type` from `@vd-creator/server`. This adds a type-only edge from web to server, which 0002's module list does not have. It is the smallest way to share the API types, and approving this plan approves it.

### UI

One page:

- A header with the title, the provider (shown in a warning color when it is paid), and play controls.
- A scene list. Each line shows the speaker, the text (editable in place), the take with "regenerate", and its status (`ready`, `missing`, `generating`).
- An image lane showing which still image is on screen at each point, following the timeline.
- Playback with the Web Audio API, scheduled from the timeline: play all, play from an item, and stop. BGM loops under its scene.
- A "regenerate" on a line increments its `take` and calls generate for that item. On a paid provider, the confirm step above applies.

Edits save immediately. On `project-changed`, the UI reloads the project and keeps the playback position when it can.

### PC and smartphone

One responsive page, not two apps. The layout switches at a width of 768 px, with plain CSS (media queries and flexbox or grid), so no UI library is added.

| | PC (768 px and wider) | Phone (narrower) |
|---|---|---|
| Layout | Scene list on the left, a side panel on the right with the current image and the library | One column. The current image is a strip at the top that follows playback |
| Player | Controls in the header | A bar fixed to the bottom of the screen, within reach of the thumb |
| Editing a line | Click the text and edit in place | Tap opens a full-screen editor with the text, speaker, take, and regenerate, and Save and Cancel buttons |
| Library | Side panel | A full-screen sheet opened from an SFX or BGM item |

Rules that keep the phone usable:

- Every control works by tap. Nothing depends on hover, right-click, keyboard shortcuts, or drag. Keyboard shortcuts on PC are extras only.
- Touch targets are at least 44 by 44 px. Text inputs use a font size of at least 16 px, so that iOS Safari does not zoom in.
- The page sets `<meta name="viewport" content="width=device-width, initial-scale=1">`, respects safe-area insets for the bottom bar, and never scrolls sideways at 360 px width.
- Audio: mobile browsers, iOS Safari in particular, start Web Audio only from a user gesture. The `AudioContext` is created or resumed inside the first tap on play, and the player shows a "tap to enable sound" state until then. Audio files are decoded on demand around the playback position, not all at once, to limit memory on phones.
- When the phone locks or the tab goes to the background, playback stops cleanly and the position is kept.
- Paid generation needs the same confirm step on both.

Target browsers: current Chrome, Edge, Firefox, and Safari on PC, Safari on iOS, and Chrome on Android.

### Dependencies

New runtime dependencies, named here: `hono`, `@hono/node-server`, `react`, `react-dom`. `apps/server` also depends on `@vd-creator/library` (0007). New dev dependencies: `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`. File watching uses `node:fs` `watch`, with no dependency. The web build switches `apps/web` from `tsc` to Vite. Its `typecheck` script stays `tsc --noEmit`.

## Tasks

The server task is reviewed with `gpt-6-astra`, because it handles file access, the access token, and the paid-generation gate. The others use the default reviewer.

- [x] Dependencies, Vite setup, and API types
  - Target: `apps/server/package.json`, `apps/web/package.json`, `apps/web` build config, root `package-lock.json`, `apps/server/src/api.ts`
  - Change: add every dependency listed in this plan, switch the `apps/web` build to Vite with a placeholder page, and write the request and response types for the API above, exported from `@vd-creator/server`. Doing all dependency changes here means the parallel tasks after it never touch the lockfile.
  - Constraints: types only in `api.ts`, no runtime code. The viewport meta tag goes into `index.html`. Depends on 0003, 0004, and the 0007 library package being done.
  - Ownership: `apps/server/package.json`, `apps/server/src/api.ts`, `apps/server/src/index.ts`, `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/tsconfig*.json`, root `package-lock.json`.
  - Acceptance: the full acceptance chain from AGENTS.md passes, and `npm run build -w apps/web` produces `apps/web/dist/index.html`.
- [ ] Server
  - Target: `apps/server/`
  - Change: the Hono app with every endpoint above, the file watcher with events, the token check, and `startServer({ projectDir, provider, port, host, library })`, which returns the URL including the token.
  - Constraints: no dependency changes. Listen on `127.0.0.1` unless `host` is given. Compare tokens in constant time. Mock provider and a temporary library in tests. Can run in parallel with the web task.
  - Ownership: `apps/server/src/` except `api.ts`.
  - Acceptance: `npm test -w apps/server` passes, with tests using Hono's request helper for every endpoint, including: a PATCH keeps comments in `scenario.yaml`, a paid generate without `confirm` returns 409, `/assets/../scenario.yaml` and `/library-files/` paths outside the library are rejected, a request without the token returns 401 when a host is set, and the token is not needed on `127.0.0.1`.
- [x] Web UI
  - Target: `apps/web/`
  - Change: the page described above, including the PC and phone layouts and the library panel, built with Vite into `apps/web/dist/`. Pure logic, such as playback scheduling from a timeline, the audio unlock state, and the API client, sits in modules without React so it can be unit tested.
  - Constraints: no dependency changes, and no UI or CSS library; ask the coordinator if one is missing. Talks to the server only through the API types. Can run in parallel with the server task.
  - Ownership: `apps/web/src/`.
  - Acceptance: `npm run build -w apps/web && npm test -w apps/web` passes, with unit tests for playback scheduling, for the confirm step on paid providers, for the audio unlock state (no `AudioContext` start before a play gesture), for API URLs staying relative under a path prefix, and for the polling fallback when events fail.
- [ ] `vd serve`
  - Target: `apps/cli/`
  - Change: `vd serve [dir] [--port 5310] [--provider mock|elevenlabs] [--host <addr>] [--allow-host <name>]... [--library <path>]` starts the server with the built UI and prints the URL. With `--host`, it prints the LAN URLs with the token and the network warning.
  - Constraints: no new dependencies. Depends on the server and web tasks. Must not run at the same time as another task that owns `apps/cli/`.
  - Ownership: `apps/cli/`.
  - Acceptance: `npm test -w apps/cli` passes, with a test that starts `serve` on a free port against an `init` project and gets `/api/project`, and a test that `--host` output contains a URL with a token. Before the plan is closed, the coordinator checks the UI in a browser at 1280 px and 375 px widths, and the human runs the phone checklist below on a real phone.

- [ ] Phone access guide
  - Target: `docs/phone-access.md` (new), `README.md`
  - Change: a guide that recommends Tailscale: install it on the PC and the phone, run `vd serve` and `tailscale serve --bg <port>`, open the printed URL, and stop with `tailscale serve --bg <port> off` (or the command current Tailscale documents). It says not to use `tailscale funnel`, then describes other VPNs or SSH tunnels and the `--host` fallback with its risks. Link it from the README.
  - Constraints: no code. No addresses, machine names, or tailnet names from a real setup. Check the Tailscale commands against Tailscale's current documentation. Depends on the `vd serve` task.
  - Ownership: `docs/phone-access.md`, `README.md`.
  - Acceptance: the coordinator follows the guide once with a real phone, as part of the phone checklist.

Phone checklist for the human: open the URL from the guide on a phone over Tailscale, tap play and hear sound, see the image change, edit a line and save, change a take and regenerate with the mock, pick a library SFX, and lock and unlock the phone.

## Open questions

- Should the UI show a running total of paid characters used in this session?
- Should `vd serve --host` print a QR code of the URL, so that the long token need not be typed? It needs a small dependency such as `qrcode-terminal`. The default is no QR in this plan.
- Should paid generation be disabled entirely for requests coming through `--host`, leaving phones with the mock only? The default is to allow it with the confirm step.

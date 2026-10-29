# 0005: Review UI

- Status: Draft
- Date: 2026-10-29
- Depends on: [0003](0003-scenario-format.md), [0004](0004-providers-and-generation.md)

## Background

The UI is where a human listens to what the agent produced and fixes it ([README](../../README.md), [0002](0002-architecture.md)). It is a browser page served by `vd serve`, talking to a local HTTP server that reads and writes the same project folder as the CLI.

## Goals / Non-goals

Goals:

- A local server (`apps/server`) with an HTTP API over one project folder.
- A React UI (`apps/web`) to play the drama, see the timeline with still images, edit lines, and regenerate items.
- Decide how the UI may trigger paid generation (0002 open question).
- Pick up edits that an agent makes to `scenario.yaml` while the UI is open.
- `vd serve`.

Non-goals:

- Rendering from the UI. `vd render` (0006) is enough at first.
- Adding or reordering scenes and items in the UI. Agents do structural edits. The UI edits text, speaker, timing, and takes.
- Multiple projects per server, authentication, and remote access. The server listens on `127.0.0.1` only.
- Waveform display and drag-to-move timing. A follow-up can add them.

## Design

### Paid generation from the UI

The server runs with one provider, chosen by `vd serve --provider`, which defaults to `mock`. When that provider is paid, regeneration is a two-step call: the UI first asks for a plan and shows the estimated characters, and the user must press "Generate (N characters)" to send the same request with `confirm: true`. The server refuses a paid generation without `confirm`. Nothing in the UI can switch the provider.

### HTTP API

| Method and path | Purpose |
|---|---|
| `GET /api/project` | Scenario, validation issues, timeline, and provider info (`id`, `paid`). |
| `GET /api/events` | Server-sent events: `project-changed` when `scenario.yaml` or `cache.json` changes on disk. |
| `PATCH /api/items/:id` | Change `text`, `speaker`, `gapBeforeSec`, or `take` of one item. Saved through `updateItem`, so comments survive. |
| `POST /api/generate` | Body `{ ids?: string[], confirm?: boolean }`. Without `confirm`, returns the plan only. Returns 409 if a paid run lacks `confirm`. |
| `GET /assets/*` | Files under the project's `assets/`, with path traversal rejected. |
| `GET /*` | The built web UI. |

The request and response types live in `apps/server/src/api.ts`. `apps/web` imports them with `import type` from `@vd-creator/server`. This adds a type-only edge from web to server, which 0002's module list does not have. It is the smallest way to share the API types, and approving this plan approves it.

### UI

One page:

- A header with the title, the provider (shown in a warning color when it is paid), and play controls.
- A scene list. Each line shows the speaker, the text (editable in place), the take with "regenerate", and its status (`ready`, `missing`, `generating`).
- An image lane showing which still image is on screen at each point, following the timeline.
- Playback with the Web Audio API, scheduled from the timeline: play all, play from an item, and stop. BGM loops under its scene.
- A "regenerate" on a line increments its `take` and calls generate for that item. On a paid provider, the confirm step above applies.

Edits save immediately. On `project-changed`, the UI reloads the project and keeps the playback position when it can.

### Dependencies

New runtime dependencies, named here: `hono`, `@hono/node-server`, `react`, `react-dom`. New dev dependencies: `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`. File watching uses `node:fs` `watch`, with no dependency. The web build switches `apps/web` from `tsc` to Vite. Its `typecheck` script stays `tsc --noEmit`.

## Tasks

The server task is reviewed with `gpt-6-astra`, because it handles file access and the paid-generation gate. The others use the default reviewer.

- [ ] Dependencies, Vite setup, and API types
  - Target: `apps/server/package.json`, `apps/web/package.json`, `apps/web` build config, root `package-lock.json`, `apps/server/src/api.ts`
  - Change: add every dependency listed in this plan, switch the `apps/web` build to Vite with a placeholder page, and write the request and response types for the API above, exported from `@vd-creator/server`. Doing all dependency changes here means the parallel tasks after it never touch the lockfile.
  - Constraints: types only in `api.ts`, no runtime code. Depends on 0003 and 0004 being done.
  - Ownership: `apps/server/package.json`, `apps/server/src/api.ts`, `apps/server/src/index.ts`, `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/tsconfig*.json`, root `package-lock.json`.
  - Acceptance: the full acceptance chain from AGENTS.md passes, and `npm run build -w apps/web` produces `apps/web/dist/index.html`.
- [ ] Server
  - Target: `apps/server/`
  - Change: the Hono app with every endpoint above, the file watcher with events, and `startServer({ projectDir, provider, port })`.
  - Constraints: no dependency changes. Listen on `127.0.0.1`. Mock provider in tests. Can run in parallel with the web task.
  - Ownership: `apps/server/src/` except `api.ts`.
  - Acceptance: `npm test -w apps/server` passes, with tests using Hono's request helper for every endpoint, including: a PATCH keeps comments in `scenario.yaml`, a paid generate without `confirm` returns 409, and `/assets/../scenario.yaml` is rejected.
- [ ] Web UI
  - Target: `apps/web/`
  - Change: the page described above, built with Vite into `apps/web/dist/`. Pure logic, such as playback scheduling from a timeline and the API client, sits in modules without React so it can be unit tested.
  - Constraints: no dependency changes; ask the coordinator if one is missing. Talks to the server only through the API types. Can run in parallel with the server task.
  - Ownership: `apps/web/src/`.
  - Acceptance: `npm run build -w apps/web && npm test -w apps/web` passes, with unit tests for playback scheduling and for the confirm step on paid providers.
- [ ] `vd serve`
  - Target: `apps/cli/`
  - Change: `vd serve [dir] [--port 5310] [--provider mock|elevenlabs]` starts the server with the built UI and prints the URL.
  - Constraints: depends on the server and web tasks.
  - Ownership: `apps/cli/`.
  - Acceptance: `npm test -w apps/cli` passes, with a test that starts `serve` on a free port against an `init` project and gets `/api/project`. The human checks the UI in a browser before the plan is closed.

## Open questions

- Should the UI show a running total of paid characters used in this session?

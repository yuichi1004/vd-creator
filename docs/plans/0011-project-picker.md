# 0011: Several projects in one server

- Status: Accepted
- Date: 2026-10-31
- PRD: [P0001](../prd/P0001-product-baseline.md), R31
- Depends on: [0005](0005-review-ui.md), [0008](0008-user-config.md), [0010](0010-settings-and-playback-speed.md), [0013](0013-voice-retake-with-agent.md), [0015](0015-change-log-and-draft-audio.md)

## Background

`vd serve <dir>` serves one project folder. A user with several dramas, such as one folder per episode, must stop the server and start it again for another folder, or run one server per project on different ports. On a phone that means remembering several URLs. Users want one place to pick a scenario from all their projects.

## Goals / Non-goals

Goals:

- A projects root: a folder whose subfolders are projects. `vd serve --projects <root>`, or `serve.projects` in `config.yaml` (0008).
- A project picker screen that lists the projects with their title and state, and opens one.
- Switching projects in the UI without restarting the server.
- The single-project mode of 0005 keeps working as it is.

Non-goals:

- Creating, renaming, copying, or deleting projects from the UI. `vd init` and agents do that.
- Projects outside the root, or nested deeper than one level.
- Several users at once, or per-project access rights. The access rules of 0005 apply to the whole server.
- Several scenarios in one project folder. A project has one `scenario.yaml`, as in 0003.

## Design

### Projects root

- `vd serve --projects <root>` serves every direct subfolder of `<root>` that holds a `scenario.yaml`.
- `serve.projects: <path>` in `config.yaml` sits next to the existing `serve.port` and `serve.host`. It applies only when `vd serve` is given no folder argument. A folder argument, `.` included, always means single-project mode. So with `serve.projects` set, a plain `vd serve` opens the root, and `vd serve .` opens the current folder. `vd serve` prints which mode it runs in and why.
- Giving both a folder and `--projects` is an error, as is a root that does not exist.
- A project is named by its folder name. A name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Folders with other names, hidden folders, and folders whose real path is outside the root (a symbolic link that leads out) are skipped and listed in the server log with a reason.
- The list is read again on each `GET /api/projects`, so a project that an agent creates appears without a restart.

### API

In projects mode, every per-project route moves under `/p/<name>/`:

| Single-project mode (0005, 0010) | Projects mode |
|---|---|
| `GET /api/project` | `GET /p/<name>/api/project` |
| `GET /api/events` | `GET /p/<name>/api/events` |
| `PATCH /api/items/:id`, `PATCH /api/scenes/:id`, `POST /api/generate` | the same under `/p/<name>/` |
| `GET /assets/*` | `GET /p/<name>/assets/*` |
| `GET /preview/*` | `GET /p/<name>/preview/*` |

Server-wide routes stay at the root in both modes: `GET /api/server` (0010), `/api/library`, `/api/library/:kind/:id/verify`, and `/library-files/*`.

- The request checks of 0005 that guard `/api/*`, such as the JSON content type and the cross-site check, apply to `/p/<name>/api/*` as well. `/p/` joins the paths that the server never answers with the web UI.
- A request for an unknown name, or a name that fails the rule above, gets 404 with fixed text. The project is looked up from the list each time, never by joining the name to the root path.
- `GET /api/server` gains `mode: "single" | "projects"`. The UI reads it first.
- New: `GET /api/projects`, in projects mode only (404 in single-project mode). Each project has its `name`, the scenario `title` (absent when `scenario.yaml` does not validate), the number of errors, the number of items with and without audio, and the time `scenario.yaml` last changed. Paths are never sent.

The UI client builds every per-project URL from a base, `./` in single-project mode and `./p/<name>/` in projects mode, still relative to the page.

### Server state

- The server opens a project on its first request: it reads the scenario, starts a file watcher, and sets up a mutation queue for edits and generation. Each project has its own queue, so an edit in one never waits for a generation in another.
- At most eight projects are open at once. A project with an open `/api/events` stream is never closed. When a ninth is needed, the least recently used project without a stream is closed and its watcher stops. If all eight have streams, the ninth is opened anyway, and the limit applies again once streams end.
- Library writes (verify today, promote in 0012) go through one server-wide library queue, because the library is shared by all projects.
- One paid generation runs at a time across the whole server, so that two tabs cannot spend at once without each confirm.

### UI

| Route | Screen |
|---|---|
| `#/projects` | The project picker. The start screen in projects mode |
| `#/p/<name>` | The review screen of that project |
| `#/settings` | Settings (0010). Settings are per device, so the route has no project |

- The picker lists projects as cards: the title, or the folder name when there is no valid title; "N of M ready"; an error badge when the scenario has errors; and when it last changed. The newest change comes first. A search box filters by title and name.
- Tapping a card opens the project. The header of the review screen shows the project's title and a button back to the picker.
- The last opened project is kept in `localStorage`, and the picker marks it. The UI does not jump to it on start, so the user always sees the list first.
- Back from settings returns to the screen it was opened from.
- In single-project mode there is no picker, and the routes of 0010 stay.

## Tasks

Run after plans 0015, 0010, and 0013, following P0001's build order. Projects mode must cover everything they add: the change log routes and marks of 0015, and the retake route, takes, trials, proposals, and agent runs of 0013, with one agent run at a time per server and cancel only from the run's own project. The server task's first review uses `gpt-6-astra`, because it changes the HTTP API and maps names from requests to folders. Its fix rounds use a Claude reviewer. The other tasks use a Claude reviewer.

- [ ] Server in projects mode
  - Requirements: R31
  - Target: `apps/server/`
  - Change: the projects root, `mode` in `GET /api/server`, `GET /api/projects`, the per-project routes under `/p/<name>/` with the request checks, the open-project limit that keeps projects with streams, per-project mutation queues, the library queue, the one-paid-run limit, and every route of 0015 and 0013 under `/p/<name>/`: changes and review, takes, trials, proposals, and agent cancel, with one agent run per server that only its own project can cancel. `startServer` takes either `projectDir` or `projectsRoot`. Add the new types to `apps/server/src/api.ts`, and update the API table of 0005 with a link to this plan.
  - Constraints: no new dependencies. Single-project mode keeps every route and response of 0005 and 0010. Never build a path from a name without finding it in the list. Never call a paid API in tests.
  - Ownership: `apps/server/`, and the API table in plan 0005.
  - Acceptance: `npm test -w apps/server` passes, with tests that:
    - the list skips hidden folders, bad names, and a symbolic link out of the root;
    - `/p/../api/project`, `/p/%2e%2e/api/project`, and an unknown name return 404;
    - a cross-site or non-JSON write to `/p/<name>/api/items/:id` is refused as on `/api/items/:id`;
    - an edit in one project does not wait for a generation in another;
    - a ninth open project closes the least used one without a stream and stops its watcher, while a project with a stream stays open;
    - two verifies from different projects run one after the other;
    - the change log, takes, trial, and proposal routes of 0015 and 0013 work under `/p/<name>/` and write only that project's files;
    - a second project's agent run gets 409 `busy`, and its cancel does not end the first project's run;
    - every 0005 and 0010 test still passes in single-project mode.
- [ ] `vd serve --projects` and `serve.projects`
  - Requirements: R31
  - Target: `apps/cli/`, the docs that describe `vd serve` and `config.yaml`
  - Change: the `--projects <root>` option, `serve.projects` in the config schema with `vd config show`, the mode rule and the errors above, and the printed URL and mode. Document both in the README and in the config docs.
  - Constraints: no new dependencies. Depends on the server task.
  - Ownership: `apps/cli/`, `README.md`, and the docs pages that list `vd serve` options or `config.yaml` keys.
  - Acceptance: `npm test -w apps/cli` passes, with tests that `--projects` serves `/api/projects` from a temporary root with two `init` projects, that a folder and `--projects` together fail, that `serve.projects` is used by a plain `vd serve`, and that `vd serve .` with `serve.projects` set runs single-project mode.
- [ ] Project picker
  - Requirements: R31
  - Target: `apps/web/src/`
  - Change: the client base URL, the routes above, including the retake route of 0013 under the project's route, the picker screen, the back button, the last opened project, and search.
  - Constraints: no new dependencies. The phone rules of 0005 apply. Can run in parallel with the CLI task once the server task is merged.
  - Ownership: `apps/web/src/`.
  - Acceptance: `npm run build -w apps/web && npm test -w apps/web` pass, with tests that per-project URLs stay relative under a path prefix in both modes, that server-wide URLs never get the project base, that the picker sorts by last change and filters by search, and that single-project mode shows no picker, and that the retake screen and the change marks work in a project opened from the picker. Before the plan is closed, the coordinator opens two projects from the picker in a browser at 1280 px and 375 px widths.

## Open questions

- Should the picker show each project's cover image, the first image of its scenario? The default is no, to keep the list fast.
- Should the open-project limit be configurable? The default is a fixed eight.

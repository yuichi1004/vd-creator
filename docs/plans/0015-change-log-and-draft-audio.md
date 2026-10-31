# 0015: Change log, agent changes, and draft audio

- Status: In progress
- Date: 2026-10-31
- PRD: [P0001](../prd/P0001-product-baseline.md), R38, R39, R13, R36
- Depends on: [0003](0003-scenario-format.md), [0005](0005-review-ui.md), [0006](0006-rendering.md)

## Background

The user and agents change the same drama from two sides. The user fixes lines in the review UI, often on a phone; agents edit `scenario.yaml` in a terminal. Today neither side can see what the other did. The UI reloads when an agent edits the file, but nothing marks what changed or why. An agent that starts work has no record of what the user fixed, so it may undo it. P0001 makes both directions a Must: a change log of UI edits that agents read (R38), and marks in the UI for what an agent changed, with its reason (R39).

P0001 also asks that draft audio never passes for final audio. Mock tones show as "ready" next to paid takes (R13), and `vd render` puts them into a final file without a word (R36).

## Goals / Non-goals

Goals:

- A change log in each project: every change to the drama, from the UI or from the file, with its old and new value, its time, and where it came from.
- A command for agents to read the changes since a point, and to record why they made theirs.
- Marks in the UI on items changed since the user last reviewed, with the reason, and a way to mark them reviewed.
- A visible "draft" state on items whose audio came from the free provider.
- A render that stops and names every item with draft audio, unless told to go on.

Non-goals:

- Undo (R20, Could). The log keeps old values, so undo can be built on it later.
- Notes on scenes or the whole drama (R14, Could).
- Recording instructions and proposals of agents run from the UI. Plan 0013 adds those as their own entries.
- Telling which agent, or whether a person, edited the file. File changes are recorded as coming from the file.

## Design

### The change log

The log is `changes.jsonl` in the project folder, one JSON object per line, appended only. `vd clean` keeps it. Each entry has:

- `id`: a number one higher than the entry before it.
- `time`: ISO 8601 with time zone.
- `source`: `ui` for a change made through the server's API, `file` for a change found in `scenario.yaml`, `agent` for a reason an agent recorded, or `review` for a "marked reviewed" entry.
- `target`: `{ kind: "item" | "scene" | "speaker" | "image" | "drama", id }`. `drama` covers the top-level fields, such as the title and the provider.
- `change`: `added`, `removed`, `moved`, or `edited`; for `edited`, the field path (such as `line`, `direction`, `take`, `source.library`, `voice.settings.stability`) with `old` and `new` values. A `removed` entry keeps the target's last fields, so the UI can show what went away. A `moved` entry has the old and new scene and position.
- `reason`: optional text, up to 300 characters, on `ui` entries made from an agent's proposal (0013) and on `agent` entries.
- `refs`: on an `agent` entry, the IDs of the entries its reason explains.

A change of several fields in one save is one entry per field, with the same `time`. Values are copied as they are in the scenario. The log holds the drama's own text, so it follows the same privacy rules as `scenario.yaml`.

### Finding file changes

To know what changed in the file, the tool keeps the last recorded state of the drama in `changes-snapshot.json` in the project folder: the top-level fields, and each speaker, image, scene, and item by kind and ID, with its fields and position. When `scenario.yaml` is valid and differs from the snapshot, the tool records the differences as `file` entries and updates the snapshot. An item whose ID is gone and a new item whose ID appeared are `removed` and `added`; IDs are what tie the two states together. A scenario that does not validate is not compared, and the snapshot stays until it validates again.

The comparison, called reconciling, runs when the server sees `scenario.yaml` change, when the server starts, before every UI change, and in every `vd changes` command. So file changes made while no server ran are recorded the next time either runs, and an agent's edit that the server has not seen yet is recorded as a `file` change before a UI change is applied on top of it.

The first run in a project without a snapshot writes the snapshot and records nothing.

### One writer at a time

The server and `vd changes` can run at the same time, so every reconcile and every UI change holds a project lock: `changes.lock` in the project folder, created exclusively, holding the process ID and the time. A process waits up to 5 seconds for the lock, and takes over a lock whose process no longer runs or which is older than 30 seconds. Inside the lock, a UI change reconciles first, then writes `scenario.yaml`, appends its `ui` entries, and replaces the snapshot. So a UI change is never recorded a second time as a `file` change, and two processes never record the same change twice.

The snapshot is replaced by writing a temporary file and renaming it. Each entry is appended with one write ending in a newline; a reader skips a last line without its newline, and the next writer first cuts it off. If a process stops after appending entries but before replacing the snapshot, the next reconcile finds the same differences again; it skips any whose entry already exists with the same target, change, and values since the snapshot's last entry ID, which the snapshot records.

### Commands for agents

- `vd changes [dir]` reconciles, then lists the changes since the last `agent` entry, oldest first, as readable lines: time, source, target, change, and reason. This is what the user and other agents did since an agent last recorded its work, whatever the user marked reviewed. An earlier agent's record means it has seen what came before; an agent that wants more uses `--since`. `--since <entry ID or time>` and `--since start` choose another point. `--source ui|file|agent` filters. `--json` prints the entries.
- `vd changes record [dir] --reason "<why>" [--items <id,...>]` reconciles, then appends an `agent` entry with the reason, whose `refs` are every `file` entry that no reason explains yet, however old, or only those for the listed items. The server may have recorded the agent's edits already, while the agent was working; the reason still reaches them. An agent runs it after each piece of work.

The scenario format guide and AGENTS.md get the rule: before you change a project, run `vd changes` and build on the user's changes rather than undoing them; after you change it, run `vd changes record --reason`. AGENTS.md is the repository's rule file, and the user's own `AGENTS.md` cannot loosen it.

### Draft audio

An asset made by the free provider (`mock`) is draft audio. `GET /api/project` gives each item `audio: "draft" | "final" | null`, from the provider recorded with its asset. The UI shows a "draft" badge on such items, and the header shows how many there are.

Library sounds and assets of a paid provider are final audio. `vd render` checks every item after its other checks. If any has draft audio, it prints their IDs and stops with an error, unless `--allow-draft` is given. On a terminal it asks instead whether to go on. The rule for agents: do not pass `--allow-draft` unless the user asked for a draft render.

### Marks in the UI

R39 asks to mark what changed since the user's last visit. A visit ends when the user says they have seen the changes, not when a page closes, so the marks do not vanish on a reload or a dropped connection, and the user's phone and PC share them.

- Any target with change entries from the file, or from the UI in another session, after the last `review` entry gets a "changed" mark, and so does any target an `agent` entry after the last `review` explains, so a reason recorded after the user reviewed still shows. Instruction entries of 0013 do not mark. Marks are keyed by kind and ID, because a speaker and an item may share an ID. Tapping the mark shows the changes, with old and new values and the reason when there is one, from the `agent` entry that explains them or from the entry itself. `file` changes show "changed in the file"; `ui` changes show "changed in the UI".
- The header shows the number of changed targets and a "Changes" list of all of them, grouped by scene, with removed items and drama-level changes in their own groups. "Mark all reviewed" appends a `review` entry, and the marks go away on every device.
- Changes the user makes in this session are not marked, so the user only sees what others did. The UI hides `ui` entries made from its own session, using an ID it sends with each change.

### API additions

| Method and path | Purpose |
|---|---|
| `GET /api/changes?since=review\|<entry ID>` | Entries since the point, default the last `review` entry. |
| `POST /api/changes/review` | Body `{}`. Appends a `review` entry. |
| `GET /api/project` | Items gain `audio`, and the project gains `changedSinceReview`, a list of `{ kind, id, count }`. |

Every mutation route of 0005 records its `ui` entries. Requests may send an `X-VD-Session` header with a random ID made by the page, which is stored in the entry as `session`, for the rule above.

## Tasks

Run the first task, then the second and third at the same time, then the fourth. Run this plan before plans 0010 and 0013, and not at the same time as another plan that owns `apps/server/` or `apps/web/src/`. The first task's first review uses `gpt-6-astra`, because it adds project files that agents and later versions will read. The server task's first review uses Codex `gpt-6.1-sol`, because it writes into the project from requests. Fix rounds and the other tasks use a Claude reviewer.

- [x] Change log in core
  - Requirements: R38, R39
  - Target: `packages/core/src/changes/` (new)
  - Change: the draft or final kind of an asset, as one helper both later tasks use; the entry type and its JSON Schema, append and read with filters, the snapshot with atomic replacement, the comparison of a scenario with the snapshot by kind, ID, and field, the project lock, reconciling with recovery, and `agent` entries with their `refs`.
  - Constraints: no new dependencies. Never compare a scenario that does not validate.
  - Ownership: `packages/core/src/changes/`, `packages/core/src/draft.ts` (new), `packages/core/src/index.ts`.
  - Acceptance: the standard acceptance chain passes, with tests that an edited field, an added, removed, and moved item, and a changed voice setting each give the right entry; that images and top-level fields are tracked; that a removed item keeps its last fields; that the first run records nothing; that an invalid scenario records nothing and keeps the snapshot; that a reason refers to file entries already recorded by an earlier reconcile; that `--items` limits the refs, and a later plain record still explains the rest; that two reconciles racing on the lock record each change once; that a stale lock is taken over; that a cut-off last line is skipped and removed; that a crash between append and snapshot does not duplicate entries on the next run; and that `since` filters by entry ID and by the last review.
  - Review notes: first review by Codex `gpt-6-astra`: one P1 (lock ownership was checked and removed in separate steps, so two holders could overlap) and three P2 (crash recovery compared only the stale snapshot; `--items` matched IDs without kind; the JSON Schema disagreed with the reader). Round 1 put release and takeover under a gate file, `changes.lock.break`, created exclusively, and recovered against the snapshot plus the entries after it. The Claude re-review found the stale-gate removal racy, no real concurrency test, and a release with no deadline that could hide errors. Round 2 renames a stale gate aside before judging it, adds a stress test with five child processes, one of them crashing while holding the lock, bounds release, and applies entries in order. Follow-ups: the stress test runs the built `packages/core/dist`, so `npm test` alone fails in a fresh clone before `npm run build`; it could skip with a note instead.
- [x] `vd changes`, the render check, and the agent rules
  - Requirements: R38, R39, R36
  - Target: `apps/cli/`, `AGENTS.md`, `docs/scenario-format.md`
  - Change: `vd changes` and `vd changes record` as above, with help text; the draft audio check in `vd render` with `--allow-draft` and the terminal question; the rules in AGENTS.md and the guide; `vd clean` keeping both files.
  - Constraints: no new dependencies. Depends on the first task.
  - Ownership: `apps/cli/` except the `serve` part of `cli.ts`, `AGENTS.md`, `docs/scenario-format.md`.
  - Acceptance: `npm test -w apps/cli` passes, with tests that `vd changes` lists entries since the last `agent` entry, even after a `review` entry, and prints JSON with `--json`; that `record` explains edits the server recorded first; that `vd render` stops and names draft items without `--allow-draft`, renders with it, and on a terminal asks and follows the answer; that library sounds and paid assets in a mixed drama are not called draft, and a mock BGM is; and that `vd clean` keeps `changes.jsonl` and `changes-snapshot.json`.
  - Review notes: Claude reviews. The first found two P2: an agent's terminal is a pseudo-terminal, so the draft question of `vd render` reaches agents too, and `vd changes` cut values at 80 characters. Round 1 kept the question, as the plan asks, and added a rule to AGENTS.md and the scenario format guide that agents never answer yes and never pass `--allow-draft` unless the user asked; it prints full values. The re-review found no tests for the new output; round 2 added them and made `--since` reject a time without a zone. The coordinator reviewed round 2 directly. No follow-ups.
- [x] Server changes and draft state
  - Requirements: R38, R39, R13
  - Target: `apps/server/`
  - Change: `ui` entries for every mutation route, with the session ID; the comparison on file change and on start; `GET /api/changes`, `POST /api/changes/review`; `audio` and `changedSinceReview` in the project response, with types in `api.ts`. Update the API table of 0005 with a link to this plan.
  - Constraints: no new dependencies. Every UI change holds the project lock and reconciles before it writes, inside the same mutation queue step. Depends on the first task.
  - Ownership: `apps/server/`, the API table in plan 0005.
  - Acceptance: `npm test -w apps/server` passes, with tests that a PATCH writes one `ui` entry per field with the session ID and no `file` entry; that an outside edit of `scenario.yaml` writes `file` entries; that an outside edit not yet seen by the watcher is recorded as `file` before a PATCH on top of it; that edits made while the server was stopped are recorded on start; that `review` clears `changedSinceReview`, and an `agent` entry after it marks its targets again; that a speaker and an item with the same ID are marked apart; and that a mock asset gives `audio: "draft"` while library and paid assets give `final`.
  - Review notes: first review by Codex `gpt-6.1-sol`: four P2. The server typecheck failed on a test type; requests without a session matched each other; `GET /api/changes` returned session IDs, which another client could copy into `X-VD-Session` to hide its edits from that page; and a review or a log-only agent reason sent no live event. Round 1 hides entries only for a matching session ID, never sends session IDs (only `own: true` to the requester), and watches `changes.jsonl`. The Claude re-review found no P1 or P2. Follow-ups: each PATCH now fires two `project-changed` events (one for `scenario.yaml`, one for `changes.jsonl`), so the page reloads twice per edit; coalesce them. Add tests that an empty, over-long, or newline-suffixed `X-VD-Session` gets 400, including on `GET /api/changes`. Strip `session` from every entry in responses, not only `ui` entries.
- [ ] Marks and draft badges in the UI
  - Requirements: R39, R13
  - Target: `apps/web/src/`
  - Change: the session ID header, the "changed" marks with their details, the header count and the "Changes" list, "Mark all reviewed", and the "draft" badge and count.
  - Constraints: no new dependencies. The phone rules of 0005 apply. Depends on the third task.
  - Ownership: `apps/web/src/`.
  - Acceptance: `npm run build -w apps/web && npm test -w apps/web` pass, with tests that a `file` change shows its mark and reason, that the page's own changes are not marked, that "Mark all reviewed" sends one request and clears the marks, and that draft items show the badge. Before the plan is closed, the coordinator edits the scenario as an agent would, records a reason, and checks the marks in a browser at 1280 px and 375 px widths.

## Open questions

- Should the log be trimmed when it grows large? The default is no; a long drama with many sessions stays far below a size that matters.
- Should marks be per device instead of shared? The default is shared, so a review on the phone counts on the PC.

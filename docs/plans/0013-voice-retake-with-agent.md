# 0013: Voice retakes with an agent

- Status: In progress
- Date: 2026-10-31
- PRD: [P0001](../prd/P0001-product-baseline.md), R18, R19, R17
- Depends on: [0003](0003-scenario-format.md), [0004](0004-providers-and-generation.md), [0005](0005-review-ui.md), [0010](0010-settings-and-playback-speed.md), [0015](0015-change-log-and-draft-audio.md)

## Background

When a line sounds wrong, the review UI (0005) can only raise its take and generate again with the same text, direction, and voice settings. The result is a new random reading, which may be no better. To fix it, the user goes to a terminal and asks an agent to change the direction or the settings, or edits `scenario.yaml` by hand. On a phone neither is possible.

P0001 follows its design principle here: changing how a line is acted is judgment, so it goes to an agent, and the UI only carries the instruction and lets the user hear the result. The user says what is wrong in their own words, such as "more surprised, and a short pause before 全部"; an agent proposes changes to the line; the user hears the new take and keeps it or goes back (R18, Must). Earlier takes stay one tap away (R19, Must). The direction can also be edited as a short text (R17, Should). Sliders for voice settings (R37) are a Could and are left out.

## Goals / Non-goals

Goals:

- A retake screen for one line, on PC and phone.
- An instruction box. The instruction goes to an agent, which proposes changes to the line: its direction, its text, and its voice settings.
- The user sees the proposal and hears a trial take made from it before anything in the scenario changes, then keeps it or not.
- Editing the text and the direction of the line on the same screen.
- A list of earlier takes of the line, to hear and go back to, without generating again.
- Each instruction and its outcome in the change log of 0015, so that agents working in a terminal later can read what the user asked for.

Non-goals:

- Sliders for voice settings (R37, Could). The agent can change settings through a proposal, and the provider's parameters below are what a later slider plan would use.
- Agents that edit files, run commands, or call generation APIs from the UI. The agent only proposes; the server applies the proposal, and generation goes through the confirm step of 0005.
- Retakes of SFX and BGM. Their prompts can follow the same pattern later.
- Batch instructions over a whole scene.
- Choosing the agent's model in the UI.
- Routes and project-scoped runs of projects mode. Plan 0011 runs after this plan and covers the routes added here (see 0011).

## Design

### Line voice settings in the scenario

An agent's proposal can change the voice settings of one line, so a line gets an optional `voice` field with `settings`, merged over its speaker's `voice.settings` one key at a time:

```yaml
- id: s0-l2
  speaker: noki
  line: どの加盟店？
  direction: still casual
  voice:
    settings: { stability: 0.35, style: 0.2 }   # Over noki's settings for this line only
```

- The value follows the same rules as a speaker's `voice.settings` (0003): plain JSON values at any depth, any keys, passed to the provider. The same plain-JSON check applies, and the scenario's JSON Schema is updated.
- `updateItem` can set and remove keys of this nested map, and keeps comments, as it does for other fields.
- The merged settings are part of the cache key, so a change makes a new asset, as a change of the speaker's settings does today. A line without `voice` keeps exactly the cache key it has today.
- The scenario format guide documents the field.

This is a change to the scenario format of 0003, and approving this plan approves it.

### Voice parameters of a provider

The agent must only propose settings the provider reads, within their ranges. `TtsProvider` gets an optional `voiceParameters(settings)`, which returns the parameters the provider reads for the given merged settings: key, label, kind (number or on-off), range, and step, or a list of allowed values. Settings matter because a model can limit values: `eleven_v3` accepts only 0, 0.5, and 1 for `stability`. A provider without it gets no settings in proposals. This adds to the provider interface of 0004, and approving this plan approves it.

For ElevenLabs: `stability`, `similarityBoost`, and `style` from 0 to 1 in steps of 0.05 (`stability` limited by model as above), `speed` from 0.7 to 1.2 in steps of 0.05, and `useSpeakerBoost` on or off.

### Take history

`cache.json` cannot say which takes belong to a line: its entries hold requests, and requests hold no item ID. So generation keeps a per-line history in `takes.jsonl` in the project folder, appended only. Each entry has the time, the item ID, the cache key, the provider, and the line's own fields that made the request: `line`, `direction`, the line's `voice.settings` override as it was (not merged), the speaker's `voiceId` and `settings`, and `take`, plus, for a trial take (below), `trial: true` and, when it came from a proposal, the proposal's ID and reason. Every TTS asset generated for a line, by `vd generate`, by the server, or as a trial, appends one entry. `vd clean` keeps the file. Lines generated before this plan have no history; their current take is listed from the scenario.

A version can be used again only when the line can point at exactly that asset:

- Its asset file still exists.
- Its provider is the line's provider now. The cache key includes the provider, so a draft made with the mock cannot be used after the drama moves to ElevenLabs. Such a version is listed, marked "made with another provider", without "Use this take".
- The speaker's `voiceId` and `settings` are the same as now. A version made with another voice or other speaker settings is listed with that note, without "Use this take".
- It is the asset playback would pick for its request. Playback picks the newest asset of a request from any provider (`cache.ts`), so if a newer asset of another provider has the same request, the version is listed with that note and without "Use this take".

"Use this take" sends one PATCH with `restore`. The server reads the history entry and sets `line`, `direction`, and `take`, and replaces the line's `voice.settings` override as a whole: removed when the version had none, so keys tried since are not left behind. The server applies the same rule as the list, then checks that the line's request now has that cache key, and refuses the PATCH with 409 `stale` otherwise, leaving the line as it was.

### Trial takes

"Try it" must let the user hear a proposal before anything is kept (R18), so a trial never writes `scenario.yaml`:

1. The server builds the line's request with the proposal applied and a take number one higher than any in the line's history and the scenario, so trying the same proposal twice gives two readings, and plans its cost. With a paid provider, the UI shows the confirm step of 0005. If the user cancels, nothing happened.
2. The server generates that one request into the cache, as generation does for any item, and appends a `trial` history entry. The UI plays it in context.
3. "Keep" sends a PATCH with `restore` set to the trial's cache key, as above. Its cache key matches, so nothing is generated.
4. "Not this one", leaving the screen, closing the tab, or a failed generation keep nothing: the line stays as it was. The trial stays in the history and in the takes list, so the user can still use it later, and its cost is not lost.

Edits of the text or direction work the same way: "Try" generates a trial from the edited fields, and "Keep" applies them. A plain "Regenerate" with no changes keeps today's behavior, raising the take in the scenario.

Each proposal and each trial carries the line's fields as they were when it was made. "Keep" and "Use this take" send them back, and the server refuses with 409 `stale` when the line has changed since, for example from another device or an agent in a terminal. The UI then reloads the line and says it changed.

### Retake screen

The route is `#/line/<id>`. It opens from a "Retake" button on each line, which replaces the plain regenerate button of 0005 on lines. On a phone the button shows on every line card without a tap first, as SFX and BGM cards show Regenerate today, so that the user can see what a card offers (from the human's phone check in plan 0009). On a phone it is full screen; on PC it is a side panel next to the scene list.

It shows:

- The line in context: the line before and the line after, with their speakers, and a button to play the three in a row.
- The current take, with play.
- **Ask the agent**: a text box for the instruction, up to 1,000 characters, and "Send". While the agent works, the screen shows that it is working and can be cancelled.
- **Proposal**, when the agent answers: the old and new direction, text, and settings side by side, with the agent's short reason. "Try it", "Edit", and "Discard". "Edit" moves the proposed text and direction into the fields below; proposed settings stay as proposed.
- **Edit**: the text and the direction, with "Try" and "Regenerate".
- **Trial**, when a trial take is ready: it plays in context, with "Keep" and "Not this one".
- **Takes**: the versions in the line's history, newest first, each with play, its provider, whether it was a trial, and "Use this take" where it can be used.

### Agent proposals

The server runs the agent; the UI never does. Which agent runs is set in the user's `config.yaml` (0008), not in the request:

```yaml
agent:
  command: claude     # claude or codex
  timeoutSec: 120
```

Without `agent`, the "Ask the agent" box is hidden and the rest of the screen works.

For each instruction the server:

1. Appends the instruction to the change log (below), then builds a prompt from fixed text, the line, its speaker's name and settings, the lines before and after it, the provider's parameters, and the user's instruction. The prompt tells the agent to answer with JSON only.
2. Runs the agent in a new empty temporary folder, with the command and arguments fixed by the server, without a shell. The prompt goes in through stdin, never as an argument. The agent must have no tools, so it cannot read files or run commands:
   - `claude`: print mode with JSON output, all built-in tools turned off, no MCP servers (`--strict-mcp-config` with an empty config), no user or project settings or hooks, and no saved session.
   - `codex`: `codex exec` with an ephemeral session, user config ignored, and the git check skipped. Codex's read-only sandbox blocks writes but not reads, so it does not meet the rule above by itself. The task must find a way to run codex with no command execution at all. If there is none, the task supports `claude` only and reports that codex is not supported yet, and `command: codex` is a config error.
   The task checks the exact flags against each tool's current documentation, and records them in the config docs.
3. Unwraps the answer: for claude, the `result` string of the JSON envelope; for codex, the last message from its output file. Then it parses that text as JSON and checks it against a strict schema: `{ direction?: string, text?: string, settings?: object, reason: string }`, with every setting one of the provider's parameters and inside its range, `text` up to 500 characters, `direction` up to 300, and `reason` up to 300. Text around the JSON fails the check. A failed answer is reported to the UI as "the agent's answer could not be used", with no detail from the agent's output.
4. Returns the proposal with an ID and the line's fields it was made from. Nothing is written to `scenario.yaml` at this point.

Limits:

- One agent run at a time per server. `timeoutSec` is from 10 to 600, default 120.
- The instruction is up to 1,000 characters, and the prompt up to 16 KB. The server reads at most 64 KB of the agent's output and 16 KB of its error output, and fails the run when the output is longer, without keeping the rest.
- The agent runs in its own process group. Cancel and the timeout send SIGTERM to the group, then SIGKILL after 5 seconds, so no child process is left. The temporary folder is removed after every run.
- Proposals are kept in memory only, at most 20, for 30 minutes.
- The agent's own usage is billed by its provider, so the UI says which agent runs before the first send in a session.

Text from the scenario reaches the agent, and the agent's answer reaches the scenario only after the user hears it and keeps it. Because the agent has no tools, a line written to steer it can at worst produce a strange proposal, which the user sees before anything changes.

### In the change log

The server owns each instruction's record in `changes.jsonl` (0015). When an instruction is sent, it appends an entry with `source: "ui"`, `target` the line, `change: "instruction"`, an `instructionId`, and the instruction text. Each later step appends an `instruction-outcome` entry with the same ID: `proposed`, `failed`, `cancelled`, `discarded`, `tried`, or `kept`. The server writes each outcome once, from its own state, so a repeated request does not repeat it. An instruction with no `kept` outcome was not kept, whatever the client did. A discarded proposal is logged without its content. The changes a "Keep" applies are the usual `ui` entries of 0015, with the agent's reason as their `reason`. The entry types of 0015 gain these two, and `vd changes` prints them. They do not mark the line as changed in the UI; only the changes a "Keep" applies do.

### API additions

| Method and path | Purpose |
|---|---|
| `POST /api/items/:id/proposals` | Body `{ instruction: string }`. Runs the agent and returns `{ proposal: { id, direction?, text?, settings?, reason, base } }`, where `base` is the line's fields it was made from. 409 with the new code `busy` when another agent run is in progress, 404 when no agent is set, 504 with the new code `timeout` when it times out. |
| `POST /api/agent-run/cancel` | Body `{}`. Cancels the agent run, if any. |
| `POST /api/proposals/:proposalId/discard` | Body `{}`. Records the discard. |
| `POST /api/items/:id/trials` | Body `{ base, proposalId?, line?, direction?, voiceSettings?, confirm? }`. Without `confirm`, returns the plan and its cost; with `confirm: true`, generates the trial and returns its cache key and audio URL. 409 `stale` when the line no longer matches `base`. |
| `GET /api/items/:id/takes` | The line's history, each version with its fields, provider, trial flag, file, duration, and whether "Use this take" is possible and why not. |
| `GET /api/server` (0010) | Gains `agent?: { command }`. |

`ItemPatchRequest` gains `direction`, `voiceSettings` (the line's override, where a `null` value removes one key), and `restore: { key, base }`, which applies a version from the history as above. A `restore` of a trial made from a proposal carries the proposal's reason, read from the history entry, into the change log, and records the `kept` outcome, even after the proposal has left memory.

## Tasks

Run in order, after plans 0015 and 0010, and not at the same time as another plan that owns `apps/server/` or `apps/web/src/`. The scenario task's first review uses `gpt-6-astra`, because it changes the scenario format and the cache key. The agent task's first review uses Codex `gpt-6.1-sol`, because the server starts a process from a request. Fix rounds and the other tasks use a Claude reviewer.

- [x] Line voice settings
  - Requirements: R18
  - Target: `packages/scenario/`, `packages/core/`, `docs/scenario-format.md`
  - Change: the optional `voice.settings` on lines with the plain-JSON check and the JSON Schema, `updateItem` support for the nested map, the merge over the speaker's settings in planning and generation, the merged settings in the cache key, and the guide. Also fix the guide's speaker example, which writes `similarity`, a key the ElevenLabs adapter ignores, to `similarityBoost`.
  - Constraints: no new dependencies. A line without `voice` must give the same cache key as today, so no asset is generated again. Use the mock provider in tests.
  - Ownership: `packages/scenario/`, `packages/core/` except `src/changes/`, `docs/scenario-format.md`.
  - Acceptance: the standard acceptance chain passes, with tests that a line override wins over the speaker one key at a time, that a change to the override changes the cache key, that a scenario without overrides keeps its cache keys, and that `updateItem` sets and removes one key and keeps comments.
  - Review notes: first review by Codex `gpt-6-astra`: no P1, two P2, both in `updateItem`. Removing the last key of a block-style `voice.settings` threw, and a flow-style one left empty maps behind; and a list value was written as the text "1,2". In both cases the file stayed unchanged. Astra confirmed by loading the old code that a line without `voice` keeps its exact cache key, also with an empty `voice` or `settings`, and that every TTS request goes through `generationRequest`. It judged the top-level merge, where a nested object replaces the speaker's as a whole, as the plan specifies, and found empty overrides cache-neutral, which is right. Round 1 removes the emptied `settings`, then the emptied `voice`, in block and flow style, and writes lists and nested maps as YAML at any depth. The Claude re-review found no P1 or P2. Follow-ups: a string with a newline inside a nested list or map is refused instead of written; a nested `yes` stays unquoted, which a YAML 1.1 reader would read as a boolean; the removal tests cover only one-key maps, and none checks that a survivor keeps its comment, that the result has a no-voice line's cache key, or that other item kinds are unchanged.
- [ ] Voice parameters and the takes API
  - Requirements: R18, R19, R17
  - Target: `packages/providers/`, `apps/server/`
  - Change: `voiceParameters` on `TtsProvider` and for ElevenLabs and the mock; the take history in core, appended by every TTS generation; `direction`, `voiceSettings`, and `restore` in `PATCH /api/items/:id`; trial takes; `GET .../takes`; and the `stale` error code, with types in `api.ts`.
  - Constraints: no new dependencies. Never call a paid API in tests. A trial never writes `scenario.yaml`. Depends on the first task.
  - Ownership: `packages/providers/src/`, `packages/core/src/generate.ts` and a new `packages/core/src/takes/`, `apps/server/`, and the API table in plan 0005.
  - Acceptance: `npm test -w packages/providers && npm test -w packages/core && npm test -w apps/server` pass, with tests that ElevenLabs lists the five parameters and limits `stability` for `eleven_v3`; that a PATCH sets and removes one override key and keeps comments; that generation appends history with the line's own fields; that a trial generates one asset and leaves `scenario.yaml` unchanged; that a cancelled or failed trial changes nothing; that `restore` of a version without an override removes a key tried since, plans no generation, and plays that exact asset; that versions made with another provider (a mock draft after a switch to ElevenLabs), another voice, or other speaker settings, or shadowed by a newer asset of another provider, are listed but cannot be restored, and the list and the restore agree; that trying the same proposal twice gives two takes; that keeping a trial an hour later still records its reason; that a restore or trial with a stale `base` returns 409 and changes nothing; and that after a direction edit is kept, the next generation's request carries the new direction.
- [ ] Agent proposals
  - Requirements: R18
  - Target: `apps/server/`, `apps/cli/`, `packages/core/src/changes/`
  - Change: `agent` in the config schema, passed by `vd serve` to `startServer`; the prompt; the agent runner; the answer unwrapping and schema; the limits, process-group cancel, and cleanup; the proposal routes; the `busy` and `timeout` error codes; and the `instruction` and `instruction-outcome` entries in the change log, printed by `vd changes`.
  - Constraints: no new dependencies. No shell, and no request text in arguments. The agent runs with no tools, as above. Tests use a fake agent command, never a real agent. Depends on the second task.
  - Ownership: `apps/server/`, `apps/cli/src/config/`, the `serve` and `changes` parts of `apps/cli/src/cli.ts`, `packages/core/src/changes/`, and the docs page for `config.yaml` keys.
  - Acceptance: `npm test -w apps/server && npm test -w apps/cli && npm test -w packages/core` pass, with tests that the instruction reaches the fake agent only through stdin; that the argument list holds the no-tools flags; that an answer with an unknown parameter, a value out of range, or text around the JSON is refused with fixed text; that a second run during the first returns 409 `busy`; that a timeout ends the process and returns 504; that output past 64 KB fails the run; that cancel ends a fake agent that started a child process, and the child too; that the temporary folder is gone after success, failure, and cancel; that each outcome is logged once even when a request is repeated; that a discarded proposal is logged without its content; that a kept trial's entries carry the proposal's reason; and that nothing in `scenario.yaml` changes before "Keep". The coordinator runs one proposal with the real `claude` command and checks that it cannot read a file in the temporary folder's parent.
- [ ] Retake screen
  - Requirements: R18, R19, R17
  - Target: `apps/web/src/`
  - Change: the route, the Retake button on every line card, shown on a phone without a tap first, the screen with context, the agent box, the proposal diff, the text and direction fields, trial takes with "Keep" and "Not this one", the stale message, and the takes list with "Use this take".
  - Constraints: no new dependencies. The phone rules of 0005 apply. Paid generation goes through the existing confirm step. Depends on the third task.
  - Ownership: `apps/web/src/`.
  - Acceptance: `npm run build -w apps/web && npm test -w apps/web` pass, with tests that "Try it" sends a trial request and no PATCH, that "Keep" sends one `restore` PATCH with the trial's key and base, that "Discard" and "Not this one" send no PATCH, that a 409 `stale` reloads the line and shows the message, that "Use this take" is shown only where the server allows it, that a line card on a phone shows the Retake button without a tap, and that the agent box is hidden without an agent. Before the plan is closed, the coordinator runs a retake with the mock provider and a fake agent in a browser at 1280 px and 375 px widths, and the human tries one real instruction with their agent.

## Open questions

- Should a proposal be able to split a line in two, or add a pause item before it? The default is no; structural edits stay with agents in a terminal.
- Should the agent see more of the scene than one line before and after? The default is one each way, to keep the prompt small.
- Should old trials that were never kept be removed by `vd clean`? The default is that `vd clean` treats them like any asset no line uses.

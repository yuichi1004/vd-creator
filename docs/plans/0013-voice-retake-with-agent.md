# 0013: Voice retakes with instructions and parameters

- Status: Draft
- Date: 2026-10-31
- Depends on: [0003](0003-scenario-format.md), [0004](0004-providers-and-generation.md), [0005](0005-review-ui.md), [0010](0010-settings-and-playback-speed.md), [0011](0011-project-picker.md)

## Background

When a line sounds wrong, the review UI (0005) can only raise its take and generate again with the same text, direction, and voice settings. The result is a new random reading, which may be no better. To fix it, the user goes to a terminal and asks an agent to change the direction or the settings, or edits `scenario.yaml` by hand. On a phone neither is possible.

Users want to say what is wrong in their own words, such as "more surprised, and a short pause before 全部", and have an agent turn that into changes to the line. They also want to adjust the voice parameters of one line directly.

## Goals / Non-goals

Goals:

- A retake screen for one line, on PC and phone.
- An instruction box. The instruction goes to an agent, which proposes changes to the line: its direction, its text, and its voice settings.
- The user sees the proposal as a diff and accepts it, edits it, or discards it. Nothing changes before the user accepts.
- Sliders for the voice parameters of one line, overriding the speaker's settings. For ElevenLabs these are the keys its adapter reads: `stability`, `similarityBoost`, `style`, `speed`, and `useSpeakerBoost`.
- Hearing the new take, and going back to an earlier take without generating again.
- A record of each instruction and what came of it, kept in the project, so that agents working in a terminal later can read what the user asked for.

Non-goals:

- Agents that edit files, run commands, or call generation APIs from the UI. The agent only proposes; the server applies the accepted proposal, and generation goes through the confirm step of 0005.
- Retakes of SFX and BGM. Their prompts can follow the same pattern later.
- Batch instructions over a whole scene.
- Choosing the agent's model in the UI.

## Design

### Line voice settings in the scenario

A line gets an optional `voice` field with `settings`, merged over its speaker's `voice.settings` one key at a time:

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

The sliders come from the provider, so another provider can list its own. `TtsProvider` gets an optional `voiceParameters(settings)`, which returns the parameters the provider reads for the given merged settings: key, label, kind (number or on-off), range, and step, or a list of allowed values. Settings matter because a model can limit values: `eleven_v3` accepts only 0, 0.5, and 1 for `stability`. A provider without it shows no sliders. This adds to the provider interface of 0004, and approving this plan approves it.

For ElevenLabs: `stability`, `similarityBoost`, and `style` from 0 to 1 in steps of 0.05 (`stability` limited by model as above), `speed` from 0.7 to 1.2 in steps of 0.05, and `useSpeakerBoost` on or off.

### Retake screen

The route is `#/line/<id>` under the project's route (`#/p/<name>/line/<id>` in projects mode). It opens from a "Retake" button on each line, which replaces the plain regenerate button of 0005 on lines. On a phone it is full screen; on PC it is a side panel next to the scene list.

It shows:

- The line in context: the line before and the line after, with their speakers, and a button to play the three in a row.
- The current take, with play.
- **Ask the agent**: a text box for the instruction, up to 1,000 characters, and "Send". While the agent works, the screen shows that it is working and can be cancelled.
- **Proposal**, when the agent answers: the old and new direction, text, and settings side by side, with the agent's short reason. "Accept", "Edit", and "Discard". "Edit" moves the proposal into the fields below.
- **Adjust**: the text, the direction, and the parameter sliders, each showing the speaker's value and whether this line overrides it. "Reset" removes the line's override for one parameter.
- **Generate take**: saves the fields, raises the take, and generates the line. With a paid provider, the confirm step of 0005 shows the characters first. If the user cancels it, the fields are restored as they were, as regenerate does today.
- **Takes**: the earlier versions of this line whose audio is still in the project, each with play and "Use this take". A version is the whole request it was made from: text, direction, merged settings, and take, read from the project's `cache.json`. "Use this take" writes all of these back to the line in one PATCH, so the line's cache key matches the old asset and nothing is generated. A version whose audio was removed by `vd clean` is not listed.

### Agent proposals

The server runs the agent; the UI never does. Which agent runs is set in the user's `config.yaml` (0008), not in the request:

```yaml
agent:
  command: claude     # claude or codex
  timeoutSec: 120
```

Without `agent`, the "Ask the agent" box is hidden and the rest of the screen works.

For each instruction the server:

1. Builds a prompt from fixed text, the line, its speaker's name and settings, the lines before and after it, the provider's parameters, and the user's instruction. The prompt tells the agent to answer with JSON only.
2. Runs the agent in a new empty temporary folder, with the command and arguments fixed by the server, without a shell. The prompt goes in through stdin, never as an argument. The agent must have no tools, so it cannot read files or run commands:
   - `claude`: print mode with JSON output, all built-in tools turned off, no MCP servers (`--strict-mcp-config` with an empty config), no user or project settings or hooks, and no saved session.
   - `codex`: `codex exec` with an ephemeral session, user config ignored, and the git check skipped. Codex's read-only sandbox blocks writes but not reads, so it does not meet the rule above by itself. The task must find a way to run codex with no command execution at all. If there is none, the task supports `claude` only and reports that codex is not supported yet, and `command: codex` is a config error.
   The task checks the exact flags against each tool's current documentation, and records them in the config docs.
3. Unwraps the answer: for claude, the `result` string of the JSON envelope; for codex, the last message from its output file. Then it parses that text as JSON and checks it against a strict schema: `{ direction?: string, text?: string, settings?: object, reason: string }`, with every setting one of the provider's parameters and inside its range, `text` up to 500 characters, and `reason` up to 300. Text around the JSON fails the check. A failed answer is reported to the UI as "the agent's answer could not be used", with no detail from the agent's output.
4. Returns the proposal with an ID. Nothing is written to `scenario.yaml` at this point.

Limits: one agent run at a time per server, the timeout from `config.yaml`, and cancel from the UI, which ends the process. A run can be cancelled only through its own project. The agent's own usage is billed by its provider, so the UI says which agent runs before the first send in a session.

Text from the scenario reaches the agent, and the agent's answer reaches the scenario only after the user accepts it. Because the agent has no tools, a line written to steer it can at worst produce a strange proposal, which the user sees before anything changes.

### Retake log

Each instruction and its outcome is appended to `retakes.jsonl` in the project folder: the time, the line ID, the instruction, the outcome (accepted, edited, or discarded), and, for accepted or edited proposals, the changes that were applied. Discarded proposals are logged without their content. The scenario format guide tells agents that the file exists, so an agent working on the drama later can read what the user asked for. `vd clean` keeps it.

### API additions

All under the project's base (0011) unless noted:

| Method and path | Purpose |
|---|---|
| `POST <project>/api/items/:id/proposals` | Body `{ instruction: string }`. Runs the agent and returns `{ proposal: { id, direction?, text?, settings?, reason } }`. 409 with the new code `busy` when another agent run is in progress, 404 when no agent is set, 504 with the new code `timeout` when it times out. |
| `POST <project>/api/agent-run/cancel` | Body `{}`. Cancels the agent run of this project, if any. |
| `POST <project>/api/proposals/:proposalId/outcome` | Body `{ outcome: "accepted" \| "edited" \| "discarded", applied?: object }`, for the retake log. |
| `GET <project>/api/items/:id/takes` | Earlier versions of the line with audio, each with its text, direction, merged settings, take, file, and duration. |
| `GET /api/server` (0010) | Gains `agent?: { command }`. |
| `GET <project>/api/project` | Gains the provider's `voiceParameters` for each line, from its merged settings. |

`ItemPatchRequest` gains `direction` and `voiceSettings`, the line's override, where a `null` value removes one key.

## Tasks

Run in order. The scenario task's first review uses `gpt-6-astra`, because it changes the scenario format and the cache key. The agent task's first review uses Codex `gpt-6.1-sol`, because the server starts a process from a request. Fix rounds and the other tasks use a Claude reviewer.

- [ ] Line voice settings
  - Target: `packages/scenario/`, `packages/core/`, `docs/scenario-format.md`
  - Change: the optional `voice.settings` on lines with the plain-JSON check and the JSON Schema, `updateItem` support for the nested map, the merge over the speaker's settings in planning and generation, the merged settings in the cache key, and the guide. Also fix the guide's speaker example, which writes `similarity`, a key the ElevenLabs adapter ignores, to `similarityBoost`.
  - Constraints: no new dependencies. A line without `voice` must give the same cache key as today, so no asset is generated again. Use the mock provider in tests.
  - Ownership: `packages/scenario/`, `packages/core/`, `docs/scenario-format.md`.
  - Acceptance: the standard acceptance chain passes, with tests that a line override wins over the speaker one key at a time, that a change to the override changes the cache key, that a scenario without overrides keeps its cache keys, and that `updateItem` sets and removes one key and keeps comments.
- [ ] Voice parameters and the retake API without the agent
  - Target: `packages/providers/`, `apps/server/`
  - Change: `voiceParameters` on `TtsProvider` and for ElevenLabs and the mock, `direction` and `voiceSettings` in `PATCH /api/items/:id`, `GET .../takes`, and `voiceParameters` in the project response, with types in `api.ts`.
  - Constraints: no new dependencies. Never call a paid API in tests. Depends on the first task.
  - Ownership: `packages/providers/src/`, `apps/server/`, and the API table in plan 0005.
  - Acceptance: `npm test -w packages/providers && npm test -w apps/server` pass, with tests that ElevenLabs lists the five parameters and limits `stability` for `eleven_v3`, that a PATCH sets and removes one override key and keeps comments, that takes list only versions whose audio exists, and that a PATCH with a listed version's fields plans no generation.
- [ ] Agent proposals
  - Target: `apps/server/`, `apps/cli/`
  - Change: `agent` in the config schema, passed by `vd serve` to `startServer`; the prompt; the agent runner; the answer unwrapping and schema; the limits and cancel; the retake log; the proposal routes; and the `busy` and `timeout` error codes.
  - Constraints: no new dependencies. No shell, and no request text in arguments. The agent runs with no tools, as above. Tests use a fake agent command, never a real agent. Depends on the second task.
  - Ownership: `apps/server/`, `apps/cli/src/config/`, the `serve` part of `apps/cli/src/cli.ts`, and the docs page for `config.yaml` keys.
  - Acceptance: `npm test -w apps/server && npm test -w apps/cli` pass, with tests that the instruction reaches the fake agent only through stdin; that the argument list holds the no-tools flags; that an answer with an unknown parameter, a value out of range, or text around the JSON is refused with fixed text; that a second run during the first returns 409 `busy`; that a timeout ends the process and returns 504; that cancel from another project does nothing; that a discarded proposal is logged without its content; and that nothing in `scenario.yaml` changes before an accept. The coordinator runs one proposal with the real `claude` command and checks that it cannot read a file in the temporary folder's parent.
- [ ] Retake screen
  - Target: `apps/web/src/`
  - Change: the route, the screen with context, the agent box, the proposal diff, the sliders from `voiceParameters` with reset, generate with restore on cancel, and the list of versions with "Use this take".
  - Constraints: no new dependencies. The phone rules of 0005 apply. Paid generation goes through the existing confirm step. Depends on the third task.
  - Ownership: `apps/web/src/`.
  - Acceptance: `npm run build -w apps/web && npm test -w apps/web` pass, with tests that an accepted proposal sends one PATCH with exactly its changes, that a discarded one sends none, that reset removes only that key, that "Use this take" sends all fields of the version, that a cancelled paid confirm restores the fields, and that the agent box is hidden without an agent. Before the plan is closed, the coordinator runs a retake with the mock provider and a fake agent in a browser at 1280 px and 375 px widths, and the human tries one real instruction with their agent.

## Open questions

- Should a proposal be able to split a line in two, or add a pause item before it? The default is no; structural edits stay with agents in a terminal.
- Should the agent see more of the scene than one line before and after? The default is one each way, to keep the prompt small.
- Should accepted instructions also be written as comments in `scenario.yaml`? The default is no; the retake log holds them.

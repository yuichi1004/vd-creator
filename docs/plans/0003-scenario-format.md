# 0003: Scenario format

- Status: Done
- Date: 2026-10-29

## Background

[0002](0002-architecture.md) made `scenario.yaml` the source of truth for a drama, edited by agents and by the UI, but left its schema to this plan. Every later plan depends on it: generation (0004) turns its items into provider requests, the UI (0005) edits it, and rendering (0006) lays it out on a timeline.

## Goals / Non-goals

Goals:

- Decide between YAML and JSON (0002 open question).
- Define schema version 1 of `scenario.yaml`: speakers, scenes, lines, SFX, BGM, pauses, and still images.
- Load, validate, and save scenarios in `packages/scenario`, keeping comments and formatting when a program edits the file.
- Export a JSON Schema so that agents and editors can validate the file without running vd.
- Add the first CLI commands, `vd init` and `vd validate`.
- Write a reference document for agents that write scenarios.

Non-goals:

- The cache file and asset metadata. They belong to 0004.
- Timing beyond what a scenario states, such as computed start times. 0004 computes the timeline.
- Migrations between schema versions. Version 1 is the only version for now.
- The shared sound library and license checks. They are designed in [0007](0007-sound-library.md). This plan only fixes how a scenario refers to a library entry.

## Design

### YAML, not JSON

The scenario is YAML. Agents and humans both annotate drafts with comments ("TODO: shorter?", "voice too bright"), and YAML keeps them. The cost is a parser dependency and the need to keep comments when the UI saves, which `yaml` (the `eemeli/yaml` package) supports through its Document API. JSON would be stricter but would lose comments on every UI save.

New runtime dependencies: `zod` (named in 0002) and `yaml` (named here).

### Schema version 1 (outline)

```yaml
version: 1
title: The Lighthouse Keeper
publish:
  use: private                    # private | non-commercial | commercial; used by license checks (0007)
speakers:
  - id: mira                      # Stable ID, referenced by lines
    name: Mira
    voice:
      provider: elevenlabs        # Provider ID; "mock" is always available
      voiceId: 21m00Tcm4TlvDq8ikWAM
      settings: { stability: 0.4, similarity: 0.8 }   # Provider-specific, optional
images:
  - id: shore
    file: images/shore.png        # Relative to assets/
scenes:
  - id: s1
    title: Arrival
    bgm:                          # Optional, loops under the whole scene
      prompt: "quiet piano, rain"
      volume: 0.3                 # 0..1, default 0.3
    items:
      - image: shore              # Shows from here until the next image
      - sfx: "waves on rocks"     # A string is a prompt: the sound is generated
        id: s1-waves
        durationSec: 4
        overlap: true             # Plays under the next items instead of before them
      - sfx: { library: door-creak-wood-01 }   # An entry in the shared library (0007)
        id: s1-door
      - line: "Is anyone up there?"
        id: s1-l1
        speaker: mira
        direction: "shouting against the wind"   # Hint for TTS and for humans
      - pause: 1.5
      - line: "..."
        id: s1-l2
        speaker: mira
        take: 2                   # Selected generation, see below
        gapBeforeSec: 0.2
```

Rules:

- Every scene, line, and SFX has an `id`, unique in the file. IDs are what the UI, the cache, and agents use to refer to an item, so they must stay stable when text changes. `vd validate` reports missing and duplicate IDs. `vd init` and agents create short slugs.
- An item is exactly one of `line`, `sfx`, `pause`, or `image`, identified by which key it has.
- References must resolve: `speaker` to a speaker ID, `image` to an image ID.
- An SFX is either a prompt string or `{ library: <entry-id> }`. A BGM has exactly one of `prompt` or `library`. The schema checks only the shape. Whether the entry exists, and whether its license fits `publish.use`, is checked against the library by 0007.
- `take` is a non-negative integer, default 0. It selects which generation of an item is used. Regenerating an item increments it (see 0004).
- `gapBeforeSec` defaults to 0.3 for lines and 0 for other items. Negative values are allowed down to -1.0, for overlapping dialogue.
- Unknown keys are errors, so that typos are caught. Provider-specific `settings` is the only free-form object.

The exact field list is fixed by the Zod schema in the first task. Changing it after this plan is accepted needs a decision gate (see 0001).

### Library API (`@vd-creator/scenario`)

```ts
type Scenario = z.infer<typeof ScenarioSchema>;
type Issue = { path: (string | number)[]; message: string; severity: "error" | "warning" };

function parseScenario(text: string): { scenario?: Scenario; issues: Issue[] };
function loadScenario(projectDir: string): Promise<{ scenario?: Scenario; issues: Issue[]; doc: ScenarioDocument }>;
function saveScenario(projectDir: string, doc: ScenarioDocument): Promise<void>;
// Edit helpers that change the YAML document in place, so comments survive
function updateItem(doc: ScenarioDocument, id: string, patch: ItemPatch): void;
```

`ScenarioDocument` wraps the `yaml` Document. Programs edit through it rather than by serializing a fresh object, so a UI save changes only the edited lines.

### JSON Schema

`packages/scenario/schema/scenario.schema.json` is generated from the Zod schema with Zod's built-in JSON Schema export and committed. A test fails when the committed file is out of date. `vd init` writes a `# yaml-language-server: $schema=...` comment so that editors pick it up.

### CLI

`apps/cli` gets its first commands, parsed with `node:util` `parseArgs` (no new dependency):

- `vd init <dir>`: creates the project folder from 0002 with a minimal valid `scenario.yaml`, and empty `assets/` and `out/` folders.
- `vd validate [dir]`: prints issues as `path: message` and exits 1 on any error.

## Tasks

The schema task fixes a file format, so it is reviewed with `gpt-6-astra` (see the review section of the [workflow guide](../development-workflow.md)). The other tasks use the default reviewer. The CLI and the guide can run in parallel once the schema is merged.

- [x] Scenario schema and I/O
  - Target: `packages/scenario/`
  - Change: Zod schema and types for version 1 as described in this plan, `parseScenario`, `loadScenario`, `saveScenario`, `updateItem`, cross-reference and ID checks, the generated `schema/scenario.schema.json` with an up-to-date test, and a sample at `packages/scenario/fixtures/sample.yaml` that uses every item type.
  - Constraints: runtime dependencies `zod` and `yaml` only. No dependency on other workspaces. No network access.
  - Ownership: `packages/scenario/`, plus the root `package-lock.json`.
  - Acceptance: `npm run build && npm run lint && npm run typecheck && npm test -w packages/scenario` passes. The tests include: the sample is valid, every rule above has a failing case, and `updateItem` followed by `saveScenario` keeps the comments and changes only the edited line.
- [x] CLI init and validate
  - Target: `apps/cli/`
  - Change: a `vd` bin entry, and the `init` and `validate` commands described in this plan.
  - Constraints: no new dependencies. Depends on the schema task being merged.
  - Ownership: `apps/cli/`, plus the root `package-lock.json` (npm records workspace `bin` entries there).
  - Acceptance: `npm test -w apps/cli` passes, with tests that run `init` into a temporary folder, `validate` the result (exit 0), and `validate` a broken copy (exit 1, issue printed).
- [x] Scenario reference for agents
  - Target: `docs/scenario-format.md`, and a link from `AGENTS.md`.
  - Change: a guide for agents that write scenarios: every field, the ID rules, a full example, and common mistakes. Generated from reading the merged schema, not from this plan alone.
  - Constraints: depends on the schema task being merged. English.
  - Ownership: `docs/scenario-format.md`, `AGENTS.md`.
  - Acceptance: the example in the guide passes `vd validate`.

## Open questions

- Should a scenario be splittable into several files, such as one per scene, for long dramas? The default is a single file.
- Should lines support inline markup for emphasis or pauses, such as SSML-like tags, or should `direction` be enough? The default is `direction` only.

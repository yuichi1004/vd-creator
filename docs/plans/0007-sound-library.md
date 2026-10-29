# 0007: Shared sound library and licenses

- Status: In progress
- Date: 2026-10-29
- Depends on: [0003](0003-scenario-format.md). The project integration task also needs [0004](0004-providers-and-generation.md).

Suggested order: 0003, then the first two tasks of this plan alongside 0004, then the integration task, then 0005 and 0006.

## Background

Plans 0003 and 0004 generate every SFX and BGM from a prompt. In practice a creator builds up a collection of sounds over many dramas: good generated takes worth keeping, and sounds downloaded from free sound sites. Reusing them saves money and keeps a consistent sound across a series.

Sounds from outside sites come with licenses: some need attribution, some forbid commercial use, and sites change their terms. A published drama must be able to show where every sound came from and under which terms. Generated sounds also have terms, set by the provider's plan.

This plan adds a master library of sounds, shared by all projects, with license records that rendering and publishing can check.

## Goals / Non-goals

Goals:

- A library folder, outside any project, holding SFX and BGM with their metadata.
- Two ways in: promote a generated sound from a project, and import a file from an outside source with its license.
- License records per entry, a license registry, and evidence of the terms at the time of download.
- Scenarios refer to library entries by ID. Projects stay self-contained and reproducible.
- Checks: missing or unverified licenses, and licenses that do not fit the drama's intended use.
- A credits file for published dramas.
- Search, so that agents use the library before paying for generation.

Non-goals:

- Downloading from sound sites or scraping them. A human or agent downloads the file under the site's terms, then imports it.
- Syncing the library between machines. The library is a plain folder, so git (with LFS) or a synced folder works. vd does not manage either.
- Still images and voices. The same design can extend to images later (see Open questions).
- Legal advice. vd records what the user states and flags gaps. It does not judge whether a license is valid.

## Design

### Library location and layout

The library is a folder set by `VD_LIBRARY`, or `--library` on any command. There is no default inside the repository or a project. If neither is set, library features are off and scenarios that use them fail validation with a clear message.

```
vd-library/
├── library.yaml            # version, name
├── licenses.yaml           # License registry: terms the entries refer to
├── evidence/               # Copies of license pages or terms, by content hash
│   └── 3f2a…e1.html
├── sfx/
│   └── door-creak-wood-01/
│       ├── entry.yaml      # Metadata and license record
│       └── sound.wav
└── bgm/
    └── rain-piano-01/
        ├── entry.yaml
        └── sound.mp3
```

One folder per entry keeps metadata next to its file and makes git diffs and merges simple. Entry IDs are slugs, unique within a kind, and never reused.

### Entry metadata

```yaml
id: door-creak-wood-01
kind: sfx                     # sfx | bgm
title: Old wooden door creak
tags: [door, wood, creak, indoor]
file: sound.wav
sha256: 9c1e…                 # Of the audio file; checked by `vd library check`
durationSec: 2.4
loopable: false               # For BGM: whether it loops cleanly
source:
  type: downloaded            # generated | downloaded | recorded | other
  url: https://example.com/sounds/12345
  site: Example Sounds
  author: Jane Doe
  retrievedAt: 2026-10-29
  # For type: generated, instead:
  # provider: elevenlabs
  # request: { prompt: "...", durationSec: 3 }
  # project: lighthouse-keeper, item: s1-door
license:
  id: CC-BY-4.0               # Key in licenses.yaml
  attribution: '"Old door" by Jane Doe, CC BY 4.0'   # Required when the license requires attribution
  evidence: evidence/3f2a…e1.html   # Copy of the terms as seen at retrievedAt
  verified: true              # A human confirmed this record
  verifiedAt: 2026-10-29
notes: Trimmed the first 0.3 s of silence.
modified: true                # The file differs from the original download
```

### License registry

`licenses.yaml` defines each license once, so entries stay short and a change to terms is made in one place:

```yaml
CC0-1.0:
  name: Creative Commons Zero 1.0
  url: https://creativecommons.org/publicdomain/zero/1.0/
  attribution: none           # none | required | appreciated
  commercialUse: allowed      # allowed | forbidden | conditional | unknown
  modification: allowed       # allowed | forbidden | unknown
  shareAlike: false
example-sounds-standard:      # A site-specific license, written by the user
  name: Example Sounds standard license
  url: https://example.com/license
  attribution: appreciated
  commercialUse: conditional
  conditions: Not for resale as sound effects on their own.
  modification: allowed
  shareAlike: false
generated-elevenlabs:         # Terms of the user's provider plan
  name: ElevenLabs generated output
  url: https://elevenlabs.io/terms-of-use
  attribution: none
  commercialUse: conditional
  conditions: Depends on the subscription plan at generation time.
  modification: allowed
  shareAlike: false
```

`vd library init` writes the standard Creative Commons licenses (CC0, BY, BY-SA, BY-NC, BY-NC-SA, version 4.0), whose terms are fixed. Site-specific and provider licenses are written by the user, because vd cannot know them reliably. Any field may be `unknown`.

### Verification

An entry is `verified` only when a human has confirmed its license record. Entries that an agent imports or promotes start as `verified: false`. A human verifies them with `vd library verify <id>` or in the UI (0005), after checking the evidence. This keeps an agent's guess about a license from silently reaching a published video.

### Scenario references

0003 is extended so that SFX and BGM take either a prompt (generate) or a library reference:

```yaml
publish:
  use: commercial             # private | non-commercial | commercial; default private
scenes:
  - id: s1
    bgm: { library: rain-piano-01, volume: 0.25 }
    items:
      - sfx: { library: door-creak-wood-01 }
        id: s1-door
      - sfx: "distant thunder"            # Still generated, as before
        id: s1-thunder
```

### Projects stay self-contained

When a project uses a library entry, `vd generate` copies the file into `assets/library/<sha256 prefix>.<ext>` and records it in `credits.json` in the project, together with a copy of its license record. After that the project renders without the library, and a later change in the library does not change an existing drama silently. `vd library status [dir]` lists entries whose library copy changed, and `vd library sync [dir]` updates the project on request.

`credits.json` also records every generated asset's provider, so that provider terms are covered as well.

### Checks

`vd library check` checks the library: each file matches its hash, each license ID exists in the registry, attribution text is present when required, evidence exists for downloaded entries, and no ID is duplicated.

The project check, run by `vd validate` and before `vd render`, uses `credits.json` and `publish.use`:

| Situation | `private` | `non-commercial` | `commercial` |
|---|---|---|---|
| Entry not verified | warning | error | error |
| `commercialUse: forbidden` | ok | ok | error |
| `commercialUse: conditional` or `unknown` | ok | warning | error, unless the entry has `license.approvedFor: commercial` set by a human |
| Attribution required but missing | warning | error | error |

`vd render --allow-license-warnings` does not override errors. Errors are fixed in the library or in the scenario.

### Credits output

`vd render` writes `out/credits.txt`: the attribution lines of every used entry that requires or appreciates attribution, then the generation providers used. It is meant to be pasted into a video description. The format is a template in the project (`credits.template.txt`) with a default.

### Commands

```
vd library init <path>
vd library import <file> --kind sfx|bgm --id <id> --license <license-id> \
    [--url <url>] [--site <name>] [--author <name>] [--attribution <text>] \
    [--evidence <file>] [--tags a,b] [--title <text>]
vd library promote [dir] --item <item-id> --id <new-id> --license <license-id>
vd library search <words> [--kind sfx|bgm] [--json]
vd library verify <id> [--approve-commercial]
vd library check
vd library status [dir]
vd library sync [dir]
```

`search` matches the title, tags, and notes, and lists the license and verification status. AGENTS.md will tell agents to search the library before writing a prompt for an SFX or BGM, and to import downloaded sounds only with the source URL and evidence.

### Module

A new package, `packages/library`, sits between `scenario` and `core`: it depends on `scenario`, and `core` depends on it. `apps/server` uses it for the library panel. This adds a module to the list in 0002, which is part of approving this plan.

## Tasks

The library package task fixes a file format and the license checks, so it is reviewed with `gpt-6-astra`. The others use the default reviewer.

- [x] Library package
  - Target: `packages/library/` (new), root `package.json` workspaces list
  - Change: Zod schemas for `library.yaml`, `licenses.yaml`, and `entry.yaml`; reading the library; `importEntry`, `promoteEntry` (from a file plus a generation record), `verifyEntry`, `searchEntries`, `checkLibrary`, `buildCreditsText(credits, template)` (used by `vd render` in 0006); the standard Creative Commons registry written by `initLibrary`; and `checkProjectLicenses(credits, use)` implementing the table above.
  - Constraints: runtime dependencies `zod` and `yaml` only, which 0003 already adds. Depends on `packages/scenario` from 0003. No network access.
  - Ownership: `packages/library/`, the `workspaces` field of the root `package.json`, and the root `package-lock.json`. It must not touch `packages/core/`, which 0004 may be editing at the same time.
  - Acceptance: the full acceptance chain from AGENTS.md passes. Tests cover every row of the check table, hash mismatch, missing evidence, an unverified agent import, and search by tag.
- [x] Library commands
  - Target: `apps/cli/`
  - Change: the `vd library` commands above, except `promote`, `status`, and `sync`, which need the generation pipeline.
  - Constraints: no new dependencies. Depends on the library package task and on the 0003 CLI task. Must not run at the same time as another task that owns `apps/cli/`, such as `vd generate` in 0004.
  - Ownership: `apps/cli/`.
  - Acceptance: `npm test -w apps/cli` passes, with a test that runs `init`, `import` with a license and evidence, `search`, `verify`, and `check` in a temporary folder.
- [ ] Project integration
  - Target: `packages/core/`, `apps/cli/`
  - Change: a library `AssetResolver` (the hook from 0004) that copies entries into `assets/library/` and writes `credits.json`, so the plan and the timeline use library durations; `vd validate` runs the project license check; `vd library promote`, `status`, and `sync`.
  - Constraints: no new dependencies. Do not change the pipeline itself; only add a resolver. Depends on the 0004 core and CLI tasks. `--library` is already accepted by `validate`, `generate`, and `clean` but ignored; this task makes it choose the library root for them.
  - Ownership: `packages/core/src/library/` (new), the line in `packages/core/src/index.ts` that registers default resolvers, the `dependencies` field of `packages/core/package.json`, the root `package-lock.json`, and `apps/cli/`.
  - Notes from implementation: `defaultResolvers` stays unchanged. The CLI puts the library resolver first when a library root is set, and `vd serve` passes it through the server's `resolvers` option. The duration of each project copy is kept in `assets/library/durations.json`, keyed by SHA-256, because a credits entry has no duration; a missing or broken entry means the copy is made again from the library.
  - Acceptance: `npm test -w packages/core && npm test -w apps/cli` pass, with tests that render-check a project using one verified CC-BY entry (ok, attribution in credits) and one unverified entry under `use: commercial` (error).
- [x] Agent guidance
  - Target: `AGENTS.md`, `docs/scenario-format.md`
  - Change: tell agents to search the library before generating SFX or BGM, how to reference entries, and the rules for importing downloaded sounds (source URL, evidence, never mark as verified). Agents must never run `vd library verify` or answer its prompt: an agent terminal is a pseudo-terminal, so the TTY check alone cannot stop it.
  - Constraints: depends on the library commands task.
  - Ownership: `AGENTS.md`, `docs/scenario-format.md`.
  - Acceptance: the coordinator checks that the documented commands match `vd library --help`.
  - Review notes: only `init`, `import`, `search`, `verify`, and `check` are documented. When project integration merges, add `promote`, `status`, and `sync`, and remove the "Not everything is built yet" note in the scenario guide.

## Open questions

- Should still images use the same library and license records? They have the same licensing problem. The default is to extend this design to an `image` kind in a later plan.
- Should the library support several roots, such as a personal library plus a team library? The default is one root.
- `lookupBlockers` in `packages/library` blocks an entry on any issue whose file is `<kind>/<id>`, whatever its severity. That is right for the "not a folder" warning, but a later warning on that file would make the entry unfindable. Should it match that issue more narrowly? The default is to narrow it when another warning is added.
- Should `vd library import` be able to fetch a URL itself, saving the evidence automatically? It would add network access and site-specific behavior. The default is no.

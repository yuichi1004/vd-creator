# 0002: Architecture and project skeleton

- Status: In progress
- Date: 2026-10-29

## Background

vd-creator has no code yet. Before features can be built, and especially before several agents can build them in parallel (see [0001](0001-agent-development-workflow.md)), we need:

- a tech stack,
- a data model that both agents and the UI work on,
- module boundaries that let parallel tasks own separate files, and
- a skeleton that builds and tests, so that workers have acceptance commands to run.

## Goals / Non-goals

Goals:

- Choose the language, runtime, and main libraries.
- Define the overall data flow: how an agent creates a drama, how the UI edits it, and how it is rendered.
- Define the modules and the interfaces between them.
- Set up a monorepo skeleton with build, lint, and test commands, plus a worktree setup script.

Non-goals:

- The detailed scenario format. It is covered by a follow-up plan. This plan fixes only where the format lives and how it is used.
- Any real feature, such as ElevenLabs calls, UI screens, or rendering. They are covered by follow-up plans.
- Packaging and distribution, such as installers, Docker, or Electron.
- CI, which is added in a follow-up once there is code to test.

## Design

### Principles

1. **The project folder is the source of truth.** A drama is a folder of plain files: a scenario file plus generated assets. There is no database. Agents, the CLI, and the UI all read and write the same files, and the folder can be versioned with git.
2. **Agents use a CLI. Humans use the UI.** Coding agents are good at editing text files and running commands. The CLI covers everything an agent needs, such as validating, generating, and rendering. The UI is for listening, reviewing, and small edits.
3. **One core, three front ends.** The CLI, the local server, and the UI share one core library, so behavior cannot drift between them.
4. **Providers are pluggable and mockable.** Every generation service, such as ElevenLabs TTS, SFX, or music, sits behind an interface and has a mock implementation. Development and tests never need a paid API (see 0001).
5. **Generation is cached by content.** An asset is regenerated only when its inputs change, such as the text, voice, or settings. This keeps re-edits cheap.

### Data flow

```
         ┌──────────── agent (Claude Code) ─────────────┐
         │ writes scenario.yaml, runs `vd generate`      │
         ▼                                               │
  project folder  ◄──── vd CLI ────► core ────► providers (ElevenLabs | mock)
  ├─ scenario.yaml        ▲            │
  ├─ assets/              │            └──► renderer (ffmpeg) ──► out/drama.mp3 | .mp4
  └─ out/                 │
         ▲                │
         └── local server (HTTP API) ◄──── web UI (browser)
```

1. An agent writes `scenario.yaml` (speakers, scenes, lines, SFX and BGM cues, still images) and runs `vd generate`.
2. The core resolves each line or cue to a provider request, checks the cache, calls the provider, and stores the result under `assets/`, together with metadata that records the inputs and the provider.
3. The user runs `vd serve` and opens the UI. The UI plays the drama in the browser from the generated assets, and shows the still images on a timeline.
4. The user edits lines, timing, and asset choices in the UI. The server writes the changes back to `scenario.yaml` and regenerates only what changed.
5. `vd render` mixes everything with ffmpeg into an audio file, or into a video with still images, for example for YouTube.

### Project folder (outline)

```
my-drama/
├── scenario.yaml     # The drama: edited by agents and by the UI
├── assets/           # Generated and imported files, named by content hash
│   ├── voice/
│   ├── sfx/
│   ├── bgm/
│   └── images/
├── cache.json        # Maps generation inputs to assets
└── out/              # Render output
```

The exact schema of `scenario.yaml` and of the cache is defined in a follow-up plan.

### Tech stack

| Area | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | Types are shared by the core, server, and UI. One toolchain is easier for agents to work in. |
| Runtime | Node.js 22 or later (LTS) | Already installed. Good ffmpeg and HTTP tooling. |
| Monorepo | npm workspaces | Comes with Node, so no extra tool to install. |
| Schema | Zod | Runtime validation of `scenario.yaml` plus TypeScript types, and JSON Schema export for agents and editors. |
| Server | Hono on Node | Small, TypeScript-first, and easy to test. |
| UI | React + Vite | Widely known, so agents produce good code for it. Web Audio API for in-browser preview. |
| Tests | Vitest | Fast, and works with Vite. |
| Lint / format | Biome | A single tool covers both. |
| Rendering | ffmpeg (system dependency) | Standard for mixing audio and turning still images plus audio into video. |
| Providers | ElevenLabs first, through its official JavaScript SDK or its REST API | Covers TTS, SFX, and music. Other providers can be added behind the same interface. |

Alternative considered: Python (FastAPI) for the backend. It has strong audio libraries, but it would split the code into two languages and two toolchains, and the scenario types would have to be defined twice. We pick TypeScript and use ffmpeg for the heavy audio work.

### Modules

```
packages/
  scenario/    # Zod schema, types, load/save/validate scenario.yaml. No I/O beyond files.
  providers/   # Provider interfaces + mock + elevenlabs. Depends on scenario.
  core/        # Generation pipeline, cache, timeline computation. Depends on scenario, providers.
  render/      # ffmpeg-based mixing and video export. Depends on scenario, core.
apps/
  cli/         # `vd` command: init, validate, generate, render, serve. Depends on core, render.
  server/      # Local HTTP API used by the UI. Depends on core, render.
  web/         # React UI. Talks to the server only; imports types from scenario.
```

Dependencies only point downward in this list. Each module is a separate ownership unit, so tasks for different modules can run in parallel waves.

### Main interfaces (sketch)

```ts
// packages/providers
interface TtsProvider {
  synthesize(req: { text: string; voiceId: string; settings?: VoiceSettings }): Promise<AudioResult>;
}
interface SfxProvider { generate(req: { prompt: string; durationSec?: number }): Promise<AudioResult>; }
interface MusicProvider { generate(req: { prompt: string; durationSec: number }): Promise<AudioResult>; }
type AudioResult = { data: Uint8Array; format: "mp3" | "wav"; durationSec: number; meta: Record<string, unknown> };
```

The follow-up plans finalize these interfaces. Changing them after that requires a decision gate (see 0001).

### Configuration and secrets

- API keys come from environment variables, such as `ELEVENLABS_API_KEY`, or from a gitignored `.env` file in the user's working folder. They are never stored in a project folder or in this repository.
- The provider defaults to `mock` unless it is set explicitly, so that running `vd generate` by accident costs nothing.

### Worktree setup

`scripts/setup.sh` installs dependencies (`npm ci`) and checks that `node` and `ffmpeg` are available. Orca runs it when it creates a worktree. The script uses no absolute paths and no personal settings.

## Tasks

This plan is carried out by a single implementer, as the 0001 pilot, with one Codex reviewer.

- [ ] Monorepo skeleton
  - Target: repository root, `packages/*`, `apps/*`, `scripts/setup.sh`
  - Change: npm workspaces with the seven modules above, each with a `package.json`, a TypeScript config, an `src/index.ts` placeholder, and one passing Vitest test. Root scripts `build`, `test`, `lint`, and `typecheck` run across all workspaces. Biome config. `.nvmrc` with Node 22. `scripts/setup.sh` as described above. Update `.gitignore` for `node_modules/`, build output, `.env`, and `out/`.
  - Constraints: no feature code. Only the dependencies named in this plan. Module dependencies must follow the direction above.
  - Ownership: everything except `docs/`, `AGENTS.md`, and `CLAUDE.md`.
  - Acceptance: on a fresh clone, `scripts/setup.sh && npm run build && npm run lint && npm run typecheck && npm test` succeeds.
- [ ] Document the commands
  - Target: `README.md`, `AGENTS.md`
  - Change: add setup and the build, lint, typecheck, and test commands to the README. Add a "Commands" section to AGENTS.md so that workers know the acceptance commands.
  - Constraints: keep the existing sections.
  - Ownership: `README.md`, `AGENTS.md`.
  - Acceptance: the documented commands match the root `package.json` scripts.
- [ ] Write follow-up plans: scenario format (0003), providers and generation pipeline (0004), review UI (0005), and rendering (0006). The coordinator writes these after the skeleton is merged.

## Open questions

- Should the scenario file be YAML (comments allowed, friendlier for humans) or JSON (simpler, stricter)? The default is YAML. It is decided in 0003.
- Should agents get an MCP server in addition to the CLI? The default is CLI only, and MCP can wrap the core later.
- Should the UI be able to trigger regeneration through paid providers directly, or only through an explicit "approve cost" step? This is decided in 0005.
- Is a desktop wrapper, such as Electron or Tauri, ever wanted, or is a browser tab on localhost enough?

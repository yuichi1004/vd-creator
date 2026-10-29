# vd-creator

A local web app for making voice dramas with generative AI voice tools such as ElevenLabs.

## Concept

vd-creator is built around an agent-first workflow:

1. **An agent drafts the drama.** A coding agent such as Claude Code writes the scenario and generates the voices, sound effects, and BGM.
2. **You review and refine it in a simple UI.** Listen to the result, check timing, fix lines, regenerate takes, and swap assets without building anything from scratch.

You don't assemble the drama by hand from an empty timeline. You start from what the agent produced and edit from there.

## Goals

- **Runs locally.** The app runs on your own machine. There is no hosted service.
- **Agent-first creation.** Scenarios and audio are produced by an agent first. The UI is for review and re-editing.
- **Generated assets.** Supports AI-generated voices, sound effects, and BGM.
- **Still images.** Supports showing still images alongside the audio, in the style common on YouTube voice-drama videos.

## Status

Early development. Expect rough edges and breaking changes. These parts work now:

- **Scenario format.** A drama is a `scenario.yaml` with speakers, scenes, lines, SFX, BGM, and still images. `vd validate` checks it. See the [scenario format guide](docs/scenario-format.md).
- **Generation.** `vd generate` makes the voices, SFX, and BGM with the mock provider, which is free and makes placeholder tones, or with ElevenLabs.
- **Review UI.** `vd serve` serves a web UI to listen to the drama, fix lines, and regenerate takes.
- **Rendering.** `vd render` mixes the audio into one file, and can also write a video with the still images and an SRT subtitle file.
- **Sound library.** A shared folder of SFX and BGM with license records, managed with `vd library`. See [plan 0007](docs/plans/0007-sound-library.md).
- **User directory.** Your own settings and notes, outside the repository. See [Your own settings](#your-own-settings).

See [`docs/plans/`](docs/plans/) for design and implementation plans.

## Repository layout

```
.
├── README.md        # This file
├── AGENTS.md        # Guidance for coding agents working in this repo
├── CLAUDE.md        # Loads AGENTS.md for Claude Code
├── package.json     # npm workspaces and root scripts
├── packages/        # Libraries: scenario, providers, core, render
├── apps/            # Front ends: cli, server, web
├── scripts/
│   └── setup.sh     # Installs dependencies and checks prerequisites
└── docs/
    ├── development-workflow.md  # How agents build this project with Orca
    ├── phone-access.md          # Opening the review UI from a phone
    └── plans/       # Design and implementation plans
```

## Getting started

Prerequisites:

- Node.js 22 or later (see [`.nvmrc`](.nvmrc))
- ffmpeg on your `PATH`

Run the setup script from the repository root. It checks the prerequisites and installs dependencies with `npm ci`. Then build the workspaces, which `vd` needs:

```sh
scripts/setup.sh
npm run build
```

## Using vd

`vd` is the command-line tool. Run it with `npx vd` from the repository root. `npx vd --help` lists every command and option. A typical flow:

1. Create a project folder with a minimal scenario:

   ```sh
   npx vd init my-drama
   ```

2. Edit `my-drama/scenario.yaml`, or have an agent write the drama in it. Follow the [scenario format guide](docs/scenario-format.md).
3. Check it:

   ```sh
   npx vd validate my-drama
   ```

4. Generate the audio. The mock provider is the default. ElevenLabs needs your API key in the `ELEVENLABS_API_KEY` environment variable. A paid provider such as ElevenLabs prints the plan and its estimated cost first, and runs only with `--yes`:

   ```sh
   npx vd generate my-drama
   npx vd generate my-drama --provider elevenlabs --yes
   ```

5. Review and edit the drama in the UI. Open the URL it prints, and stop it with Ctrl+C:

   ```sh
   npx vd serve my-drama
   ```

6. Render the result into `my-drama/out/`. `--video` adds a video with the still images, and `--srt` adds subtitles:

   ```sh
   npx vd render my-drama --video --srt
   ```

To review from a phone, see [Using a phone](#using-a-phone). If you use a sound library, set it with `--library`, `VD_LIBRARY`, or `library` in your `config.yaml`, and search it with `npx vd library search <words>` before you write an SFX or BGM prompt. [`AGENTS.md`](AGENTS.md#sound-library) and the [scenario format guide](docs/scenario-format.md#sound-library) explain how to use it.

## Commands

Run these from the repository root:

| Command | What it does |
|---|---|
| `npm run build` | Compiles every workspace with TypeScript. |
| `npm run lint` | Checks formatting, import order, and lint rules with Biome. |
| `npm run typecheck` | Type-checks every workspace, including tests. |
| `npm test` | Runs the Vitest tests of every workspace. |
| `npm run format` | Rewrites files with the Biome formatter. |

To run `build`, `typecheck`, or `test` for a single workspace, add `-w` with the workspace path or package name, for example `npm test -w packages/core` or `npm run build -w @vd-creator/core`.

## Using a phone

`vd serve` opens the review UI on your PC only. To use it from your phone, follow the [phone access guide](docs/phone-access.md). Tailscale is the recommended way.

## Your own settings

Settings and notes that belong to you and your machine go in a user directory, never in the repository. vd-creator uses the first of these that exists:

1. The folder named by the `VD_USER_DIR` environment variable, if it is set. It can be any folder, such as a private repository you keep elsewhere.
2. `local/` at the root of this repository. It is gitignored, so nothing in it is committed. A symbolic link named `local` to another folder works the same way.
3. `$XDG_CONFIG_HOME/vd-creator/`, or `~/.config/vd-creator/` when `XDG_CONFIG_HOME` is not set.

Only one directory is used; they are not merged. If none exists, vd-creator uses its built-in defaults. `local/` suits a single clone. The other two suit several clones or worktrees, which do not share `local/` unless it is a link.

The user directory can hold these files, all optional:

```
<user dir>/
├── config.yaml   # Defaults for vd commands
├── AGENTS.md     # Your own instructions for coding agents
└── docs/         # Free-form private notes for you and your agents
```

Agents read your `AGENTS.md` and `docs/` before working, as described in [`AGENTS.md`](AGENTS.md). Your `AGENTS.md` can add rules but cannot loosen the repository's rules. Don't put API keys in the user directory; keep them in environment variables or a gitignored `.env`. See [plan 0008](docs/plans/0008-user-config.md) for the design.

## Development

vd-creator is developed by coding agents coordinated with Orca orchestration. See [`docs/development-workflow.md`](docs/development-workflow.md).

## Language

English is the primary language of this repository: code, comments, commit messages, issues, pull requests, and documentation.

## License

TBD

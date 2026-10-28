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

Planning. No application code yet. See [`docs/plans/`](docs/plans/) for design and implementation plans.

## Repository layout

```
.
├── README.md        # This file
├── AGENTS.md        # Guidance for coding agents working in this repo
├── CLAUDE.md        # Loads AGENTS.md for Claude Code
└── docs/
    ├── development-workflow.md  # How agents build this project with Orca
    └── plans/       # Design and implementation plans
```

## Development

vd-creator is developed by coding agents coordinated with Orca orchestration. See [`docs/development-workflow.md`](docs/development-workflow.md).

## Language

English is the primary language of this repository: code, comments, commit messages, issues, pull requests, and documentation.

## License

TBD

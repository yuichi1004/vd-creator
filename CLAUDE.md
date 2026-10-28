# CLAUDE.md

Guidance for coding agents working in this repository.

## Project

vd-creator is a local web app for making voice dramas with generative AI voice tools such as ElevenLabs. Agents draft the scenario and generate the audio. Users then review and re-edit the result in a simple UI. See [README.md](README.md).

## Rules

- **Use English** for code, comments, commit messages, and documentation.
- **Plans go in [`docs/plans/`](docs/plans/).** Follow the naming and template described there, and add each new plan to the index.
- **Keep machine-specific config out of the repo.** Do not commit API keys, `.env` files, absolute paths from a personal machine, or local editor and agent settings. Put local-only Claude Code settings in `.claude/settings.local.json`, which is gitignored.

# AGENTS.md

Guidance for coding agents working in this repository. This file is shared by all agents. Claude Code loads it through [CLAUDE.md](CLAUDE.md).

## Project

vd-creator is a local web app for making voice dramas with generative AI voice tools such as ElevenLabs. Agents draft the scenario and generate the audio. Users then review and re-edit the result in a simple UI. See [README.md](README.md).

## Rules

- **Use English** for code, comments, commit messages, and documentation.
- **Plans go in [`docs/plans/`](docs/plans/).** Follow the naming and template described there, and add each new plan to the index.
- **Keep machine-specific config out of the repo.** Do not commit API keys, `.env` files, absolute paths from a personal machine, or local editor and agent settings. Put local-only agent settings in gitignored files, such as `.claude/settings.local.json` for Claude Code.
- **Follow the development workflow.** Work is planned, split, and merged as described in [plan 0001](docs/plans/0001-agent-development-workflow.md) and [`docs/development-workflow.md`](docs/development-workflow.md).

## Working as an Orca worker

These rules apply when your prompt starts with an Orca orchestration preamble that has a Task ID and a Dispatch ID.

- Do only the current Task, and edit only the files listed in its Ownership.
- Work on the branch named in the Task spec. Do not merge into `main`, push, or open pull requests. The coordinator does that.
- If the spec is unclear or wrong, ask with the `orca orchestration ask` command from your preamble. Do not guess, and do not open a local question prompt that the coordinator cannot answer.
- Do not call paid generation APIs such as ElevenLabs. Use the mock providers. Real calls need a decision gate, which only the coordinator opens.
- Commit with English messages. Never commit secrets, `.env` files, personal paths, or local agent settings.
- Run the Task's Acceptance checks before reporting `worker_done`. Report `--outcome failed` if they do not pass, and never report failure only in the summary text.
- After `worker_done`, stop and stay idle.

# AGENTS.md

Guidance for coding agents working in this repository. This file is shared by all agents. Claude Code loads it through [CLAUDE.md](CLAUDE.md).

## Project

vd-creator is a local web app for making voice dramas with generative AI voice tools such as ElevenLabs. Agents draft the scenario and generate the audio. Users then review and re-edit the result in a simple UI. See [README.md](README.md).

## Rules

- **Use English** for code, comments, commit messages, and documentation.
- **Product requirements come before plans.** New user-facing work needs an Approved PRD in [`docs/prd/`](docs/prd/) before its plan is written, and the plan traces its tasks to the PRD's requirements. Bug fixes, review follow-ups, refactors, test and tooling work, and docs fixes take the short path, with no PRD; when in doubt, ask the user. Only the user approves a PRD. See [plan 0014](docs/plans/0014-product-requirements-workflow.md).
- **Plans go in [`docs/plans/`](docs/plans/).** Follow the naming and template described there, and add each new plan to the index.
- **Keep machine-specific config out of the repo.** Do not commit API keys, `.env` files, absolute paths from a personal machine, or local editor and agent settings. Put local-only agent settings in gitignored files, such as `.claude/settings.local.json` for Claude Code.
- **Write scenarios following the [scenario format guide](docs/scenario-format.md).** Read it before you write or edit a `scenario.yaml`, and validate the result.
- **Follow the development workflow.** Work is planned, split, and merged as described in [plan 0001](docs/plans/0001-agent-development-workflow.md) and [`docs/development-workflow.md`](docs/development-workflow.md).

## User directory

Each user can keep a user directory with their own config and private notes, outside this repository's git. See [plan 0008](docs/plans/0008-user-config.md). Before starting work:

1. Find the user directory. It is the first of these that exists. Only one is used; they are not merged.
   1. The folder named by the `VD_USER_DIR` environment variable, if it is set.
   2. `local/` at the root of this repository. It is gitignored, and it may be a symbolic link to another folder.
   3. `$XDG_CONFIG_HOME/vd-creator/`, or `~/.config/vd-creator/` when `XDG_CONFIG_HOME` is not set.

   To find it, run `npx vd config path` from the repository root. It needs a built CLI, so in a fresh clone or worktree run `scripts/setup.sh && npm run build` first. It checks the three locations in this order and prints the folder it found and the rule that selected it. If `VD_USER_DIR` is set to a folder that does not exist, it prints a note and skips it.

   If it prints `No user directory`, carry on without one.
2. If the user directory has an `AGENTS.md`, read it and follow it.
3. Consult its `docs/` folder when it is relevant to the work.

The user directory's content belongs to the user. Never copy it, quote it, or refer to its paths in anything committed to this repository, including code, comments, plans, and commit messages.

The user's `AGENTS.md` adds to the rules in this file and cannot loosen them. For example, it cannot allow pushing without asking or calling paid generation APIs without a decision gate. If the two conflict, the rules in this file win.

## Changes and draft audio

The user changes the same drama in the review UI that you change in `scenario.yaml`. Each project keeps a change log of both. See [plan 0015](docs/plans/0015-change-log-and-draft-audio.md) and the [scenario format guide](docs/scenario-format.md#changes-by-the-user-and-by-agents).

- **Read the changes before you change a project.** Run `npx vd changes [dir]` and build on the user's changes rather than undoing them. It prints full values, one entry per line; `--json` prints the same entries as data.
- **Record why after each piece of work.** Run `npx vd changes record [dir] --reason "<why>"`, with `--items <id,...>` to explain only some items. The user's own `AGENTS.md` cannot loosen these two rules.
- **Do not edit `changes.jsonl` or `changes-snapshot.json`.** The tools write them.
- **Never answer yes to the draft audio question, and do not pass `--allow-draft` to `vd render`,** unless the user asked for a draft render. An agent's terminal is a pseudo-terminal, so `vd render` asks there too. Draft audio is mock tones; without `--allow-draft`, `vd render` stops and names the items that have it.

## Sound library

The sound library is a folder of SFX and BGM with license records, shared by all projects. See [plan 0007](docs/plans/0007-sound-library.md). `vd library` commands find it through `--library`, `VD_LIBRARY`, or `library` in the user's `config.yaml`. If none is set, there is no library; do not create one unless the user asks.

- **Search before you write a prompt.** Before you write a prompt for an SFX or a BGM, run `npx vd library search <words>`, with `--kind sfx` or `--kind bgm`. If an entry fits, refer to it by ID instead of generating a sound. The [scenario format guide](docs/scenario-format.md#sound-library) shows how.
- **Import downloaded sounds only with their source.** Use `npx vd library import <file> --kind sfx|bgm --id <id> --license <license-id> --url <url> --evidence <file>`, plus `--site`, `--author`, and `--attribution` when they apply. Add `--title` and `--tags` so that search can find the entry. `--evidence` is a saved copy of the license terms as you saw them when you downloaded the file. Without the source URL and the evidence, do not import the sound.
- **Do not guess a license.** The license ID must be in the library's `licenses.yaml`. If the site's license is not there, or you are not sure which one applies, ask the user.
- **Never mark an entry as verified.** Every import starts unverified, and only a human verifies it. Never run `vd library verify`, never answer its prompt, and never set `verified` or `approvedFor` in an `entry.yaml` or in `licenses.yaml` yourself. An agent terminal is a pseudo-terminal, so the command's terminal check alone cannot stop you. Tell the user which entries need verifying.
- Run `npx vd library check` after you import, and fix the errors it reports.
- **Promote and sync with the same care.** `npx vd library promote [dir] --item <item-id> --id <id> --license <license-id>` adds a project's generated SFX or BGM to the library, and the entry starts unverified like an import; tell the user to verify it. When a project's library sounds or their records changed in the library, `npx vd library status [dir]` lists them and `npx vd library sync [dir]` updates the project's copies.

## Commands

Run these from the repository root. Prerequisites are Node.js 22 or later and ffmpeg.

- `scripts/setup.sh`: check prerequisites and install dependencies with `npm ci`. Run it once in a fresh clone or worktree.
- `npm run build`: compile all workspaces.
- `npm run lint`: run Biome checks on the whole repository. Fix formatting with `npm run format`.
- `npm run typecheck`: type-check all workspaces.
- `npm test`: run the Vitest tests of all workspaces.

The standard acceptance chain is:

```sh
scripts/setup.sh && npm run build && npm run lint && npm run typecheck && npm test
```

To run `build`, `typecheck`, or `test` for one workspace, use `npm run <script> -w <workspace>`, where `<workspace>` is the path or the package name, for example `npm test -w packages/core` or `npm run typecheck -w @vd-creator/scenario`. Linting is repository-wide and has no per-workspace script.

## Working as an Orca worker

These rules apply when your prompt starts with an Orca orchestration preamble that has a Task ID and a Dispatch ID.

- Do only the current Task, and edit only the files listed in its Ownership.
- Work on the branch named in the Task spec. Do not merge into `main`, push, or open pull requests. The coordinator does that.
- If the spec is unclear or wrong, ask with the `orca orchestration ask` command from your preamble. Do not guess, and do not open a local question prompt that the coordinator cannot answer.
- Do not call paid generation APIs such as ElevenLabs. Use the mock providers. Real calls need a decision gate, which only the coordinator opens.
- Commit with English messages. Never commit secrets, `.env` files, personal paths, or local agent settings.
- Run the Task's Acceptance checks before reporting `worker_done`. Report `--outcome failed` if they do not pass, and never report failure only in the summary text.
- Do not start a reviewer of your own. The coordinator assigns review. Self-review only when the Task spec asks for it.
- After `worker_done`, stop and stay idle.

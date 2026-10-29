# 0008: User config and private docs

- Status: In progress
- Date: 2026-10-29
- Depends on: none for the first task. The second task needs the CLI from [0003](0003-scenario-format.md).

## Background

Each user runs vd-creator on their own machine in their own way: where the sound library lives, which port and host `vd serve` uses, how they reach the UI from a phone, which notes their agents should follow. None of this belongs in the repository. AGENTS.md already forbids committing personal paths and local settings, but there is no agreed place to put them, so they end up in shell history, in the head of the user, or by mistake in a commit.

This plan adds a user directory: one place, never tracked by this repository's git, for the user's config file and private docs, which both the `vd` CLI and coding agents read.

## Goals / Non-goals

Goals:

- A user directory that can live inside this repository (gitignored) or in any other folder.
- A config file with defaults for `vd` commands, so flags such as `--library` and `--host` need not be repeated.
- A place for private docs and agent instructions, which agents read before working.
- Commands to find, create, and inspect the user directory.

Non-goals:

- Secrets. API keys stay in environment variables or a gitignored `.env`, as in [0002](0002-architecture.md). The config file has no field for them.
- Syncing or backing up the user directory. It is a plain folder. The user may keep it in a private git repository of their own.
- Per-project settings. Those belong in the project folder.
- Changing the safety defaults. Config cannot make a paid provider the default (see below).

## Design

### Location

The user directory is the first of these that exists:

1. `VD_USER_DIR`, if set. Any folder, for example a private repository the user keeps elsewhere.
2. `local/` at the root of this repository. The root `.gitignore` lists `/local` (without a trailing slash, so that a symbolic link named `local` is ignored too), so nothing in it is ever committed. A symbolic link named `local` to another folder works the same way.
3. `$XDG_CONFIG_HOME/vd-creator/`, or `~/.config/vd-creator/` when `XDG_CONFIG_HOME` is not set.

Only one directory is used; they are not merged. If none exists, `vd` runs with built-in defaults and no error. `vd config path` prints which directory is used and why.

The in-repository option suits a user who works in one clone. The outside options suit several clones, Orca worktrees (which do not share `local/` with the main checkout unless it is a link), and keeping the folder under a separate git history.

### Layout

```
<user dir>/
├── config.yaml        # Defaults for vd commands
├── AGENTS.md          # The user's own instructions for coding agents
└── docs/              # Free-form private notes: hosting, workflows, voices to use, ...
```

All three are optional.

### `config.yaml`

```yaml
version: 1
library: ~/sounds/vd-library        # Default for --library / VD_LIBRARY
serve:
  port: 5310
  host: 127.0.0.1                   # Same rules and warnings as --host in 0005
init:
  publishUse: private               # Default publish.use for `vd init` (0007)
render:
  creditsTemplate: credits.template.txt   # Relative to the user dir
```

- The schema is a strict Zod schema, like the scenario: unknown keys are errors, so a typo or a pasted API key is caught.
- `~` at the start of a path expands to the home directory. Relative paths are relative to the user directory.
- Precedence: command-line flag, then environment variable, then `config.yaml`, then the built-in default. `vd config show` prints each effective value and where it came from.
- There is no `provider` field. The provider stays `mock` unless a command names another, so that 0002's rule that an accidental run costs nothing holds. Adding such a field later needs a decision gate.

### Agent instructions and docs

AGENTS.md gets a rule: before starting work, run `vd config path` (or check the three locations by hand before the CLI exists), and if the user directory has an `AGENTS.md`, read it and follow it, and consult `docs/` when relevant. Its content is the user's, so agents must not copy it, quote it, or refer to its paths in anything committed to this repository, including plans, commit messages, and code comments.

The user's `AGENTS.md` adds to the repository's rules and cannot loosen them. For example, it cannot allow pushing without asking or calling paid APIs without a decision gate.

For Claude Code, a gitignored `CLAUDE.local.md` is also possible, but it works only for Claude Code and only inside this repository, so the user directory is the shared mechanism.

### Commands

```
vd config path                 # Prints the user dir and which rule selected it
vd config init [--dir <path>]  # Creates the layout with a commented config.yaml; default is local/
vd config show [--json]        # Effective config with sources
```

`vd config init` refuses to create the directory inside this repository at any path other than `local/`, so that the gitignore always covers it.

### Where the code lives

Config loading is in `apps/cli/src/config/`. The CLI passes the resolved values to `core`, `render`, and `startServer` (0005) as plain options, so no package other than the CLI reads the user directory. This keeps the packages free of hidden machine state and easy to test.

## Tasks

Both tasks use the default reviewer.

- [x] Repository side
  - Target: `.gitignore`, `AGENTS.md`, `README.md`
  - Change: add `/local` to `.gitignore`. Add the agent rule above to AGENTS.md, including how to find the user directory by hand before `vd config` exists. Add a short "Your own settings" section to the README that explains the three locations.
  - Constraints: no code. Keep the existing sections. No example paths from a real machine.
  - Ownership: `.gitignore`, `AGENTS.md`, `README.md`.
  - Acceptance: `git check-ignore local/config.yaml` succeeds, and the coordinator checks that the three documents agree on the locations.
- [ ] `vd config` and config loading
  - Target: `apps/cli/`
  - Change: the location rules, the `config.yaml` schema, precedence, `~` expansion, and the three commands. Wire `library`, `serve.*`, `init.publishUse`, and `render.creditsTemplate` into the commands that exist at the time; later plans read the same loader.
  - Constraints: no new dependencies (`zod` and `yaml` come from 0003). Tests set `VD_USER_DIR` and `XDG_CONFIG_HOME` to temporary folders and never read the real home directory. Must not run at the same time as another task that owns `apps/cli/`.
  - Ownership: `apps/cli/`.
  - Acceptance: `npm test -w apps/cli` passes, with tests for each location rule and their order, precedence of flag over environment over file, an unknown key (such as `apiKey`) rejected, and `vd config init` refusing a path inside the repository other than `local/`.

## Open questions

- Should the user directory also hold project templates for `vd init`? The default is not now; `docs/` can describe them.
- Should several user directories be merged, such as a team one and a personal one? The default is one directory.

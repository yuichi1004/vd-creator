# 0001: Agent development workflow

- Status: Done
- Date: 2026-10-29

## Background

vd-creator will be built mostly by coding agents. We want to try running several agents in parallel, coordinated through Orca orchestration, instead of a single agent working in one checkout.

Orca provides the runtime pieces: worktrees, agent terminals, orchestration Runs and Tasks with dependencies, inter-agent messages, and decision gates. It does not decide how this project plans work, splits it, reviews it, or integrates it. This plan defines those conventions before any application code exists, so that later plans (starting with 0002, architecture) can be carried out with this workflow.

## Goals / Non-goals

Goals:

- Define the roles of the human, the coordinator agent, and worker agents.
- Define where tasks are tracked, from the long-term backlog down to a single running attempt.
- Define how a plan becomes Orca Tasks, how workers are placed, and how their results are reviewed and merged.
- Define when a human decision is required, especially before calls to paid generation APIs.
- Keep everything machine-independent, so that the repository contains no personal paths or local settings.

Non-goals:

- Application architecture and tech stack. These are covered by 0002.
- CI. It will be added once the repository is on GitHub and there is code to test.
- Tuning Orca itself, such as models, effort levels, or UI settings. Those choices are local and stay out of the repo.

## Design

### Roles

| Role | Who | Responsibilities |
|---|---|---|
| Human | The project owner | Approves plans, resolves decision gates, approves paid API usage, does final review of anything user-facing. |
| Coordinator | One Claude Code session running in an Orca terminal on the main checkout | Turns accepted plans into Orca Tasks, starts workers, answers worker questions, reviews or assigns review, merges to `main`, updates plan checkboxes. Writes little code itself. |
| Implementer | A worker agent started with `orca orchestration worker-start` | Completes exactly one Task in its own worktree and branch, runs the acceptance checks, and reports `worker_done`. |
| Reviewer | A worker agent, preferably a different model from the implementer | Reviews an implementer's branch against the Task spec and repository rules. Reports findings and does not edit the branch. |

The coordinator must run inside an Orca terminal, because orchestration inbox commands identify the caller by its Orca session.

### Task tracking layers

| Layer | Tool | Source of truth for |
|---|---|---|
| Backlog | Checkboxes in the `## Tasks` section of each plan in `docs/plans/` | What needs to be done, versioned in git. |
| Execution | Orca orchestration Run, Tasks, and Dispatches | What is running now, its dependencies, who owns it, and whether it succeeded. |
| Workspace | Orca worktree, with its status card and comment | Where the work happens and a one-line progress note. |

Orca state is local to one machine and can be reset, so it is never the permanent record. When a Task succeeds and is merged, the coordinator ticks the matching checkbox in the plan in the same commit as the merge, or in the commit right after it. GitHub Issues may be added as a backlog layer later (see Open questions).

### Lifecycle

1. **Plan.** Someone writes `docs/plans/NNNN-*.md` with `Status: Draft`. Usually the coordinator writes it, with input from the human.
2. **Approve.** The human reviews the plan. When they accept it, the status becomes `Accepted`.
3. **Decompose.** The coordinator creates one Orca Run for the plan and one Orca Task for each task in the plan, adding dependencies only where ordering is real. The status becomes `In progress`.
4. **Execute in waves.** The coordinator starts all Tasks whose dependencies are met, with at most three implementers at a time to begin with. Each worker gets a new child worktree.
5. **Review.** For each finished implementation, the coordinator either reviews it directly (for small or mechanical changes) or starts a reviewer worker on the branch. Findings go back to the implementer as a follow-up Dispatch on the same Task branch.
6. **Integrate.** The coordinator rebases the branch onto `main`, re-runs the acceptance checks, and merges with `--ff-only`. Once the repo is on GitHub, this step can become a pull request.
7. **Close.** The coordinator releases settled worker terminals, removes merged worktrees, ticks plan checkboxes, and sets the plan to `Done` when every task is complete.

### Task spec

Every task in a plan's `## Tasks` section must be detailed enough to become a self-contained Orca Task spec. Workers see only the spec, not the conversation that produced it. Each task states:

- **Target:** the files, modules, or components in scope.
- **Change:** the concrete result to produce.
- **Constraints:** invariants, compatibility rules, and boundaries the worker must not touch.
- **Ownership:** what the worker may edit. Tasks in the same wave must not own overlapping files.
- **Acceptance:** the command, test, or output that proves the task is complete.

Example:

```markdown
- [ ] Scenario schema
  - Target: `packages/scenario/`
  - Change: JSON Schema and TypeScript types for scenes, lines, speakers, SFX, BGM, and still images.
  - Constraints: no dependency on the UI or on any voice provider.
  - Ownership: `packages/scenario/` only.
  - Acceptance: `npm test -w packages/scenario` passes, including round-trip tests on the sample scenario.
```

The plan template in `docs/plans/README.md` will be extended to show this format.

### Worktrees and branches

- One Task attempt uses one child worktree of the main checkout, created by `worker-start --worktree new-child`.
- Branch name: `task/<plan-number>-<short-name>`, for example `task/0002-scenario-schema`.
- Branches start from the current `main`, not from each other. Stacked branches are used only when a plan says so explicitly.
- Each worktree is set up by a repository setup script. Its location and contents will be defined by 0002 once there is a toolchain. The script must not contain machine-specific paths.
- Secrets such as API keys are never copied into a worktree by a committed file. A worker that needs a key reads it from the environment. How the environment reaches the worktree is a local Orca setting outside the repo.

### Decision gates

The coordinator opens an Orca decision gate, and waits, before:

- Moving a plan from `Draft` to `Accepted`.
- Any change that alters a public interface or file format defined in an accepted plan.
- Any call to a paid generation API, such as ElevenLabs TTS, SFX, or music.
- Adding a runtime dependency that a plan does not already name.
- Anything outward-facing, such as pushing to GitHub, opening PRs, or publishing.

### Paid API policy

Development and tests use mock providers by default. Each generation provider has a mock implementation that returns fixture audio. A real API call is allowed only after a decision gate, and the gate must state the expected number of calls or characters. Generated audio from real calls is not committed unless a plan asks for it, such as a small, licensed sample.

### Worker rules

These rules live in `AGENTS.md`, which `CLAUDE.md` imports:

- Do only the current Task, and edit only the files the Task owns.
- If the spec is unclear or wrong, ask the coordinator through the orchestration `ask` command. Do not guess, and do not open a local question prompt that the coordinator cannot answer.
- Commit on the Task branch with English messages. Never commit secrets, `.env` files, personal paths, or local agent settings.
- Run the Task's acceptance checks before reporting `worker_done`, and report `--outcome failed` if they do not pass.
- Do not merge into `main`, push, or open PRs. The coordinator does that.

### Scaling up

Parallelism only pays off once modules and interfaces exist. Plan 0002 (architecture and project skeleton) is therefore carried out by a single implementer, or by the coordinator directly. Parallel waves start with the first plan after 0002.

Suggested first parallel run, which will be confirmed in a later plan: scenario schema, a voice-provider adapter with a mock, and a UI skeleton, plus one reviewer.

## Tasks

- [x] Extend the plan template in `docs/plans/README.md` with the task spec format.
  - Target: `docs/plans/README.md`
  - Change: add Target, Change, Constraints, Ownership, and Acceptance to the `## Tasks` example.
  - Ownership: `docs/plans/README.md` only.
  - Acceptance: the template matches the Task spec section of this plan.
- [x] Add `docs/development-workflow.md`, a short operational guide for the coordinator.
  - Target: `docs/development-workflow.md`, and a link from `README.md`.
  - Change: a step-by-step version of the lifecycle with example `orca orchestration` commands, using a generic `orca` executable name.
  - Constraints: no machine-specific paths.
  - Acceptance: a fresh coordinator session can run one wave by following the guide alone.
- [x] Add worker rules to `CLAUDE.md`.
  - Target: `CLAUDE.md`
  - Change: a "Working as an Orca worker" section with the Worker rules above.
  - Acceptance: rules match this plan.
- [x] Decide on non-Claude agents. If they are used, add an `AGENTS.md` that mirrors `CLAUDE.md`.
  - Decision: Claude Code implements and Codex reviews. The shared rules moved to `AGENTS.md`, and `CLAUDE.md` imports it so the two cannot drift.
- [x] Pilot: run plan 0002 through this workflow, with a single implementer and one reviewer, and record lessons learned in this plan.

## Lessons learned

From the pilot on 2026-10-29: plan 0002 was run with one Claude implementer, reused for both tasks, and one Codex reviewer. Both tasks passed acceptance and were merged with `--ff-only`. Codex found no issues in the skeleton. The coordinator reviewed the small docs task itself.

What worked:

- The spec fields (Target, Change, Constraints, Ownership, Acceptance) were enough. Neither worker asked a question.
- Asking the implementer to verify acceptance on a fresh `git clone` caught nothing this time, but it is cheap and proves `npm ci` and the lockfile work.
- One implementer terminal can serve several Tasks in sequence: `worker-retain` after the first `worker_done`, then `worker-start --task <next> --terminal <handle>`. The first Dispatch then reports `retained` with reason `ownership_transferred`, which is its final state.
- A reviewer started on the implementer's worktree stayed read-only as instructed.

Problems and fixes (applied to [`docs/development-workflow.md`](../development-workflow.md) unless noted):

1. **New worktrees start from `origin/main`, not from the local `main`.** Unpushed commits, such as accepting a plan or the coordinator's status commit, were missing in the worker's checkout. If a plan or spec changed locally, the worker would see the old version. Fix: pass `--base-branch main` to `worker-start`, or push first.
2. **The guide's integration step fails as written.** `git switch task/...` in the main checkout is refused while the branch is checked out in the worker's worktree. Fix: rebase inside the worktree (`git -C <worktree> rebase main`), then run `merge --ff-only` from the main checkout.
3. **The branch rename step is not needed.** `--name task-NNNN-<short-name>` already creates the branch `task/NNNN-<short-name>`. Workers reusing a worktree for a later Task create the new branch from `main` themselves.
4. **Orca dependencies settle on `worker_done`, not on merge.** A dependent Task that needs the merged code becomes ready before the code is on `main`. The coordinator must start it only after integration.
5. **Ownership overlapped across tasks in the plan.** Task 1 owned "everything except `docs/`, `AGENTS.md`, `CLAUDE.md`", which included `README.md`, owned by task 2. They ran in sequence, so this was harmless, but the coordinator narrowed it in the spec. Plans should list Ownership so that tasks do not overlap even when they run in sequence. (Plan authoring, not fixed in the guide.)
6. **"Only the dependencies named in this plan" was ambiguous for dev dependencies.** It did not say whether `@types/node` or the runtime libraries (Zod, Hono, React) belonged in a skeleton. The coordinator listed the allowed dev dependencies in the spec. Plans should name dev dependencies explicitly. (Plan authoring.)
7. **`task-create` has no spec-file option.** The spec must be passed inline. If the coordinator's shell permissions block command substitution, write the spec with no single quotes and pass it in single quotes.
8. **No Orca setup hook is configured.** `worker-start --setup run` reported `hookFound: false`, so workers ran `scripts/setup.sh` themselves. Configure the Orca repo setup to run `scripts/setup.sh`. This is a local Orca setting, not a repository change.
9. **`orca worktree rm` deleted the branch checked out in the worktree, but not earlier task branches made in it.** Delete merged branches with `git branch -d` after removing the worktree.
10. **Workers may make small edits beyond the spec, inside their Ownership.** The docs worker also updated the README status and layout. It was correct here, but the reviewer or coordinator should check such edits explicitly.

From running plans 0003 to 0008 on 2026-10-29, with up to three Claude implementers in parallel:

1. **Reviewer routing by size used up Codex.** Codex hit its usage limit in the middle of the run, and reviews waited. Fix: route by risk instead. Codex reviews security-sensitive code, Astra reviews hard-to-undo format and interface changes, and Claude reviews the rest and every fix round.
2. **Fix rounds kept finding new low-severity issues.** Fix: cap fix rounds at two. After that, only a P1 or a secret leak blocks a merge, and the rest becomes follow-ups in the plan's review notes.
3. **Parallel tasks were safe when Ownership split by workspace.** For example, `vd render` owned `apps/cli` while provider records owned `packages/core`. A worker that needed a change in the other workspace asked instead of editing it.
4. **A `--help` check in the main checkout read stale compiled output.** It made a merged command look missing. Fix: rebuild after each merge.
5. **Health checks every few minutes were too frequent for the human.** A watchdog every 10 minutes, with one-line replies to heartbeat-only relays, was enough.
6. **A worker that wanted to shadow a shared export was redirected.** The integration worker proposed replacing `defaultResolvers` with a re-export. The coordinator kept the shared API and had the CLI and server pass the extra resolver explicitly. Specs should name the integration point when two packages meet.
7. **To check the UI without a browser extension, drive headless Chrome over the DevTools protocol.** `--screenshot` never finished, because the review UI keeps an event stream open. A small script that sets the viewport, navigates, waits, and calls `Page.captureScreenshot` worked at both desktop and phone widths.

## Open questions

- Should GitHub Issues become the backlog once the repository is public, or should plans stay the only backlog?
- After the repo is on GitHub, should integration move to pull requests, or stay as local fast-forward merges by the coordinator?
- What is the right number of parallel implementers after the pilot: two, three, or more?

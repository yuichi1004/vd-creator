# Development workflow

This guide explains how to run one plan through Orca orchestration, step by step. The rules behind it are in [plan 0001](plans/0001-agent-development-workflow.md). If this guide and the plan disagree, the plan wins.

Commands use `orca` as the executable name. Replace it with the Orca CLI on your machine. On Linux, outside an Orca terminal, a bare `orca` may launch the GNOME screen reader instead. Run `orca <command> --help` for every flag, and prefer `--json` when an agent reads the output.

## Before you start

- Run the coordinator as a Claude Code session inside an **Orca terminal** on the main checkout, on branch `main`. Orchestration inbox commands identify the caller by its Orca session.
- `orca status --json` must succeed. If it reports that Orca is not running, start it with `orca open --json`.
- The plan must have `Status: Accepted`, and every task in it must have Target, Change, Constraints, Ownership, and Acceptance. See the [plan template](plans/README.md).
- `main` must be clean and up to date.

## 1. Create a Run

Create one Run per plan:

```sh
orca orchestration run-create --objective "Plan NNNN: <title>" --json
```

Record the returned Run ID in the coordinator session. After a coordinator restart, resume it with `orca orchestration run-use --id <run_id> --json`.

Set the plan's status to `In progress` and commit.

## 2. Create Tasks

Create one Orca Task for each unchecked task in the plan. Copy the task's fields into the spec, then add the branch and the worker rules, because the worker sees nothing else:

```text
Plan: docs/plans/NNNN-<title>.md, task "<short task name>"
Branch: task/NNNN-<short-name>. (A Task that reuses an earlier worktree creates it with: git switch -c task/NNNN-<short-name> main.)
Target: ...
Change: ...
Constraints: ...
Ownership: ...
Acceptance: ...
Rules: follow AGENTS.md, "Working as an Orca worker".
```

```sh
orca orchestration task-create --task-title "<short task name>" --spec "<spec>" --json
orca orchestration task-create --task-title "<later task>" --spec "<spec>" --deps '["<task_id>"]' --json
```

Add `--deps` only for real ordering. Tasks that can run at the same time must not have overlapping Ownership.

`task-create` has no option to read the spec from a file, so pass it inline. If your shell permissions block command substitution, write the spec without single quotes and wrap it in single quotes.

An Orca dependency is met when the earlier Task reports `worker_done`, not when it is merged. If a later Task needs the earlier Task's code on `main`, start it only after step 6.

## 3. Start a wave

Start every Task whose dependencies are met, up to three implementers at once. Each implementer gets a new child worktree:

```sh
orca orchestration worker-start --task <task_id> --worktree new-child \
  --name task-NNNN-<short-name> --base-branch main --agent claude --setup run --json
```

`--name task-NNNN-<short-name>` creates the branch `task/NNNN-<short-name>`. `--base-branch main` starts it from the local `main`. Without it, Orca starts from `origin/main`, and the worker misses unpushed commits such as plan or spec changes.

To reuse an idle implementer for the next Task, keep it with `worker-retain --dispatch <dispatch_id>` after its `worker_done`, then start the next Task in the same terminal:

```sh
orca orchestration worker-start --task <next_task_id> --terminal <agent_terminal_handle> \
  --worktree <implementer_worktree_selector> --json
```

The command exits 0 only when the worker is ready. If it fails, do not run it again blindly. Read `failedStage` and `residualResources` in the receipt and follow its recovery commands.

## 4. Wait and answer

Start the whole wave before waiting. Then loop:

```sh
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

For each message in the returned batch:

- **question**: answer with `orca orchestration reply --id <message_id> --body "<answer>" --json`. If the answer needs the human, ask them first.
- **escalation**: decide whether to answer, re-scope the Task, or stop it.
- **worker_done**: check that it comes from the expected Dispatch, then go to step 5.

Acknowledge the batch only after processing every message in it, and keep waiting:

```sh
orca orchestration check --ack <delivery_id> --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

A timeout means "nothing yet", not failure. After three empty waits in a row, inspect the fleet with `orca orchestration worker-list --run <run_id> --json` and follow each row's `nextAction`. Never stop, retry, or release a worker without positive proof that it has exited.

## 5. Review

When a worker reports `--outcome succeeded`, start a reviewer on the same worktree. Every change gets a reviewer, including small documentation changes. The coordinator still reads the diff (`git diff main...<task branch>`), but that does not replace the review.

Codex usage is limited, so choose the reviewer by the size of the change:

- **Large changes** get a Codex reviewer: the first review of a new task's code, and any other change of roughly 150 or more non-test lines. Code that handles secrets, such as API keys, always gets a Codex reviewer.
- **Small changes** get a Claude reviewer (`--agent claude`): fix rounds on a task that Codex has already reviewed, documentation and plan changes, and other changes under roughly 150 non-test lines.

A Codex reviewer is started like this:

```sh
orca orchestration worker-start --worktree <implementer_worktree_selector> --agent codex \
  --model gpt-6.1-sol --effort high \
  --task-title "Review: <short task name>" \
  --spec "Review branch task/NNNN-<short-name> against this spec: <spec>. Check AGENTS.md rules. Report findings in worker_done. Do not edit files." --json
```

Always pass `--model` and `--effort` for a Codex reviewer. Without them, Codex may run with no reasoning effort. Choose the model by what a wrong review would cost:

| Model | Use for |
|---|---|
| `gpt-6.1-sol`, effort `high` | The default for every review. Close to Astra in quality, with about three times the usage limit. |
| `gpt-6-astra`, effort `high` | Reviews where a mistake is expensive later: architecture, public interfaces, file formats such as the scenario schema, and security. Its usage limit is low, so use it only for these. |

`gpt-6.1-terra` is meant for writing and images, and `gpt-6-luna` is too light for review. Neither is used for code review.

A Claude reviewer uses the same command with `--agent claude` and without `--model` and `--effort`.

If a Codex reviewer stops at a usage limit, it does not resume by itself and sends no message. Close its terminal after the limit resets, and start the review again on the same Task with `worker-start --task <review_task_id>` and the same model.

If there are findings, send them back as a follow-up on the same Task branch. Reuse the implementer's terminal if it is still live, or start a new implementer with `--retry-of`.

When a worker reports `--outcome failed`, read its summary, then fix the spec and retry, or ask the human.

## 6. Integrate

The Task branch is checked out in the worker's worktree, so rebase it there, then merge from the main checkout:

```sh
git -C <worktree_path> rebase main
# re-run the task's Acceptance command in the worktree, or in a fresh clone of the branch
git merge --ff-only task/NNNN-<short-name>
```

In the same commit, or the one right after it, tick the task's checkbox in the plan. Pushing to GitHub is outward-facing, so the human must approve it.

## 7. Clean up

For every settled worker, do exactly one of the following: reuse it for an immediate follow-up, keep it with `worker-retain` if the human asked to, or release it:

```sh
orca orchestration worker-release --dispatch <dispatch_id> --json
```

Then remove merged worktrees, using the `id` from `orca worktree list --json`:

```sh
orca worktree rm --worktree id:<repoId>::<worktreePath> --json
```

This deletes only the branch that is checked out in the worktree. Delete other merged Task branches with `git branch -d task/NNNN-<short-name>`.

Before ending the coordinator turn, this must return nothing:

```sh
orca orchestration worker-list --run <run_id> --terminal-state reclaimable --json
```

When every task in the plan is checked, set the plan's status to `Done`, update the [plans index](plans/README.md), and commit.

## Decision gates

Before any action listed under "Decision gates" in plan 0001, such as a paid API call or a public interface change, block the Task and ask the human:

```sh
orca orchestration gate-create --task <task_id> --question "<question, including expected API calls or characters if paid>" \
  --options '["approve","reject"]' --json
```

After the human answers, record the answer:

```sh
orca orchestration gate-resolve --id <gate_id> --resolution "<answer>" --json
```

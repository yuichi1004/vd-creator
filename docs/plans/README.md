# Plans

This directory holds design and implementation plans for vd-creator.

## Naming

Name each plan `NNNN-short-title.md`, where `NNNN` is the next free four-digit number:

```
0001-architecture.md
0002-scenario-format.md
```

Numbers are never reused, even if a plan is dropped.

## Plan template

```markdown
# NNNN: Title

- Status: Draft | Accepted | In progress | Done | Superseded by NNNN
- Date: YYYY-MM-DD

## Background

Why this plan is needed.

## Goals / Non-goals

What this plan covers and what it deliberately leaves out.

## Design

The proposed approach.

## Tasks

- [ ] Short task name
  - Target: files, modules, or components in scope.
  - Change: the concrete result to produce.
  - Constraints: invariants, compatibility rules, and boundaries not to touch.
  - Ownership: what the worker may edit. Tasks that run in parallel must not overlap.
  - Acceptance: the command, test, or output that proves the task is done.

## Open questions

Decisions that still need to be made.
```

Each task must be self-contained: an agent working on it sees only the task, not the discussion behind it. See [0001](0001-agent-development-workflow.md) for how tasks become Orca orchestration Tasks.

## Index

| Plan | Title | Status |
|---|---|---|
| [0001](0001-agent-development-workflow.md) | Agent development workflow | In progress |
| [0002](0002-architecture.md) | Architecture and project skeleton | In progress |

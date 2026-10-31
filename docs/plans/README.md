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
- PRD: [PNNNN](../prd/PNNNN-short-title.md), R1, R4 | none (short path: <reason>)

## Background

Why this plan is needed.

## Goals / Non-goals

What this plan covers and what it deliberately leaves out.

## Design

The proposed approach.

## Tasks

- [ ] Short task name
  - Requirements: the PRD requirement IDs this task builds, or "none" on the short path.
  - Target: files, modules, or components in scope.
  - Change: the concrete result to produce.
  - Constraints: invariants, compatibility rules, and boundaries not to touch.
  - Ownership: what the worker may edit. Tasks that run in parallel must not overlap.
  - Acceptance: the command, test, or output that proves the task is done.

## Open questions

Decisions that still need to be made.
```

Each task must be self-contained: an agent working on it sees only the task, not the discussion behind it. See [0001](0001-agent-development-workflow.md) for how tasks become Orca orchestration Tasks.

A plan for new user-facing work is written only after its PRD is Approved; see [`docs/prd/`](../prd/) and [plan 0014](0014-product-requirements-workflow.md). Bug fixes, review follow-ups, refactors, test and tooling work, and docs fixes take the short path and have no PRD.

## Index

| Plan | Title | Status |
|---|---|---|
| [0001](0001-agent-development-workflow.md) | Agent development workflow | Done |
| [0002](0002-architecture.md) | Architecture and project skeleton | Done |
| [0003](0003-scenario-format.md) | Scenario format | Done |
| [0004](0004-providers-and-generation.md) | Providers and generation pipeline | Done |
| [0005](0005-review-ui.md) | Review UI | Done |
| [0006](0006-rendering.md) | Rendering | Done |
| [0007](0007-sound-library.md) | Shared sound library and licenses | Done |
| [0008](0008-user-config.md) | User config and private docs | Done |
| [0009](0009-follow-ups-0003-0008.md) | Follow-ups from plans 0003 to 0008 | In progress |
| [0010](0010-settings-and-playback-speed.md) | Settings screen and playback speed | Done |
| [0011](0011-project-picker.md) | Several projects in one server | Accepted |
| [0012](0012-library-screen.md) | Library screen | Accepted |
| [0013](0013-voice-retake-with-agent.md) | Voice retakes with an agent | In progress |
| [0014](0014-product-requirements-workflow.md) | Product requirements before plans | Done |
| [0015](0015-change-log-and-draft-audio.md) | Change log, agent changes, and draft audio | Done |

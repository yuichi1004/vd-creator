# Product requirements

This directory holds product requirements documents (PRDs) for vd-creator. A PRD says who a feature is for, what it lets them do, and how we will know it worked. It says nothing about how it is built; that is the job of a [plan](../plans/). The workflow is described in [plan 0014](../plans/0014-product-requirements-workflow.md), which was tried first on [P0001](#index).

PRDs follow the repository rules: English, and no content from a user directory, a user's own drafts, or their paths. A persona describes a kind of user, never a real person.

## When a PRD is needed

New user-facing work needs an Approved PRD before its plan is written. The short path skips the PRD for bug fixes, follow-ups from reviews, refactors, test and tooling work, and docs fixes; such a plan says `- PRD: none (short path: <reason>)`. When in doubt, the coordinator asks the human. A change of scope after approval goes back to the PRD first, with a line in its change log.

## Naming

Name each PRD `PNNNN-short-title.md`, where `NNNN` is the next free four-digit number. PRD numbers are separate from plan numbers and are never reused.

Reviews of a PRD go in `reviews/PNNNN/<role>.md`, one file per reviewer, and are committed with the PRD.

## Lifecycle

`Draft` → `In review` → `Approved` → `Superseded by PNNNN` or `Withdrawn`. Only the human sets `Approved`. A change after approval adds a line to the change log.

## Template

```markdown
# PNNNN: Title

- Status: Draft | In review | Approved | Superseded by PNNNN | Withdrawn
- Date: YYYY-MM-DD
- Owner: the human who approves it
- Plans: links to the plans that build it

## Summary

One paragraph: who it is for, what it lets them do, and why it matters now.

## Problem

What the user cannot do today, or what is slow, risky, or confusing. Facts about the
current product, with how we know them.

## Users

The personas from personas.md that this serves, the main one first, and what each needs.

## Before and after

A short story of one persona doing the task today, then the same task with this feature.

## Jobs and user stories

- As <persona>, I want <goal>, so that <reason>.

## Requirements

| ID | Requirement | Priority | Acceptance (from the user's view) | Today |
|---|---|---|---|---|
| R1 | What the user can do | Must / Should / Could | Given ..., when ..., then the user ... | Built / Partial / Missing |

Requirements say what the user can do and see, never how it is built. The "Today" column
is used when a PRD describes a product that already exists in part.

## Experience

The screens or commands the user meets, and what must hold on a phone and on a PC.
The mockup link goes here during review.

## Constraints

Cost and paid generation, privacy, licenses, accessibility, performance as the user feels
it, and what must keep working.

## Success

How we will know it worked: a task the user can do, and how fast or how easily.

## Non-goals

What this PRD does not cover, and why.

## Assumptions and risks

What we believe without proof, and what could make this fail.

## Decisions

| Date | Question | Decision | By |
|---|---|---|---|

## Open questions

## Change log

- YYYY-MM-DD: what changed after approval, and why.
```

## Index

| PRD | Title | Status |
|---|---|---|
| [P0001](P0001-product-baseline.md) | vd-creator product baseline | Approved |

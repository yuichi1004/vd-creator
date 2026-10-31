# 0014: Product requirements before plans

- Status: Draft
- Date: 2026-10-31
- Depends on: [0001](0001-agent-development-workflow.md)

## Background

Plans in this repository go straight from a request to a design: screens, routes, schemas, and tasks. A plan answers "how do we build it" well, but nothing written down answers "who is this for, what problem does it solve, and how will we know it worked". Plans 0010 to 0013 show the gap: each was written from a one-line request, and their reviews found design problems but could not ask whether the design served the user, because no document said what the user needed.

This plan adds a product step in front of planning: a product requirements document (PRD) written from the user's point of view, reviewed in a way that puts the reviewer in the user's place, and approved by the human before any plan or architecture is written.

## Goals / Non-goals

Goals:

- A PRD template for this repository, and a place for PRDs.
- A product manager (PM) role, played by an agent, that turns a request into a PRD by asking the human about intent rather than guessing.
- A PRD review that is easy for the human: short to read, answered mostly by choosing, and tried on a phone through a clickable mockup.
- Reviews that take the user's point of view: persona walkthroughs and a pre-mortem, not only a technical review.
- Traceability from each requirement to the plan tasks that build it.
- The whole flow run with Orca orchestration, within the existing worker, reviewer, and decision-gate rules of 0001.

Non-goals:

- Market research, pricing, or business cases. vd-creator is a local tool for its users.
- Changing how plans become Tasks, or how Tasks are reviewed and merged. 0001 and `docs/development-workflow.md` keep that.
- A PRD for every change. Small work takes the short path below.

## Design

### Where the PRD sits

```
Request ──▶ PRD (what and why) ──▶ Plan (how) ──▶ Tasks ──▶ Merge
            PM agent, human        plan author,   workers,
            approves               human approves reviewers
```

- No plan for new user-facing work is written until its PRD is Approved. A plan names its PRD in its header (`- PRD: [P0003](../prd/P0003-....md)`), and each task names the requirement IDs it builds (`- Requirements: R1, R4`).
- **Short path, no PRD:** bug fixes, follow-ups from reviews, refactors, test and tooling work, and docs fixes. Such a plan says `- PRD: none (short path: <reason>)`. When in doubt, the coordinator asks the human.
- A change of scope after approval goes back to the PRD first, as a new revision with a line in its change log, then to the plan.

PRDs live in `docs/prd/`, named `PNNNN-short-title.md` with their own numbering, and listed in `docs/prd/README.md` with their status. Shared personas live in `docs/prd/personas.md`, so that every PRD and every review uses the same people.

PRDs follow the repository rules: English, and no content from the user directory, the user's drafts, or their paths. A persona describes a kind of user, never the real user.

### Roles

| Role | Played by | Does |
|---|---|---|
| Product owner | The human | Brings the request, answers the PM's questions, makes the decisions, approves the PRD. |
| Product manager (PM) | A Claude worker | Interviews, writes and revises the PRD, owns its consistency. Writes no design or code. |
| Persona reviewers | Claude workers, one per persona | Walk through the PRD as that persona and report where they get stuck, confused, or worried. |
| Pre-mortem reviewer | A Claude worker | Imagines the feature shipped and failed six months later, and explains why. |
| Feasibility reviewer | A Codex worker (`gpt-6.1-sol`) | Flags requirements that are impossible, very costly, unsafe, or in conflict with the code. Proposes no design. |
| Mockup maker | A Claude worker | Builds a clickable HTML mockup of the main screens from the PRD. |
| Coordinator | The main agent | Runs the orchestration, relays questions to the human, merges the reviews into one review card. |

### Lifecycle

`Draft` → `In review` → `Approved` → (`Superseded by PNNNN` or `Withdrawn`)

1. **Intake.** The coordinator writes the request in the human's own words into a new PRD stub (Summary and Problem only), and starts a Run.
2. **Discovery.** The PM reads the stub, the personas, the README, and the code that matters, to learn how the product behaves today. It then asks the human 3 to 6 questions about intent, each with options and a recommended answer, through `orca orchestration ask`. The coordinator relays them in one batch, as choices.
3. **Draft.** The PM writes the PRD from the template below.
4. **Review.** Persona walkthroughs, the pre-mortem, the feasibility check, and the mockup run in parallel. The coordinator merges them into the review card.
5. **Revise.** The PM answers every finding: changed, or not changed with a reason. At most two rounds, as for code.
6. **Approval gate.** The human reads the review card, tries the mockup, answers the decisions, and approves or sends it back. Only the human sets `Approved`.
7. **Hand-off.** A plan author writes the plan from the Approved PRD. A traceability check, below, runs before the plan's own review.

### The review card

The human should not have to read every review. The coordinator writes one page, as a private Artifact so that it opens on a phone, holding:

- **The pitch:** the PRD's summary and its "before and after" story, in under 150 words.
- **Try it:** the link to the mockup, with the two or three things to try.
- **Decisions for you:** each open product question as a choice with a recommended option, which the human answers by tapping. Usually 2 to 5.
- **What the personas felt:** one line per persona, with its biggest friction, shown as a short quote in the persona's voice.
- **Risks:** the top three from the pre-mortem and the feasibility check, each with what the PRD now does about it.
- **Verdict buttons:** Approve, Approve with the chosen answers, or Send back with a note.

The full reviews stay linked for anyone who wants detail. The human's answers are written back into the PRD's decision log by the PM.

### Creative review techniques

- **Table read.** As actors read a script aloud before filming, each persona reviewer reads the PRD's user journey step by step, as a story told in the first person ("I open the app on the train, and I want to..."). They stop at each point where they would hesitate, and say what they expected instead.
- **Pre-mortem.** "It is six months later, and nobody uses this feature. What happened?" This finds wrong assumptions that a checklist misses.
- **Clickable mockup.** Plain HTML with fake data, made to be tapped on a phone, with no real backend. Reviewing a screen is faster and more honest than reading about one. The mockup is thrown away after approval. It is not a design spec, and the plan may change the layout.
- **Five-second test.** The coordinator shows the human only the pitch, then asks "what does this do, and for whom?". If the answer differs from the PRD's summary, the summary is rewritten.

### Traceability check

After the plan is written, a Claude reviewer checks it against the PRD and reports:

- Every Must requirement that no task builds.
- Every task that serves no requirement (a sign of scope creep, or a short-path task in the wrong plan).
- Every acceptance check of a Must requirement that no task acceptance proves.
- Every non-goal of the PRD that the plan builds anyway.

The plan's own review (0001) starts only after these are resolved or accepted by the human.

### Orchestration

One Run per PRD, named `prd-PNNNN`. Within the session's guideline of fewer than ten agents per run:

| Step | Workers | Agent | Parallel |
|---|---|---|---|
| Discovery and draft | PM | Claude | — |
| Review | 2 to 3 personas, pre-mortem, feasibility, mockup | Claude, Codex | yes |
| Revise | PM, same Dispatch where possible | Claude | — |
| Plan and traceability | plan author, traceability reviewer | Claude | — |

- The PM owns only its PRD file. Each reviewer writes only its review file, `docs/prd/reviews/PNNNN/<role>.md`, which is committed with the PRD so the reasoning stays. The mockup maker writes to the scratchpad and is published as an Artifact; it is not committed.
- Workers ask the human only through the coordinator. The coordinator batches questions, so that the human gets one set of choices, not a stream.
- No worker calls a paid generation API. A mockup uses no real audio, or the mock provider's tones.
- The human's approval is a decision gate in the sense of 0001: no plan Task starts before it.

### PRD template

```markdown
# PNNNN: Title

- Status: Draft | In review | Approved | Superseded by PNNNN | Withdrawn
- Date: YYYY-MM-DD
- Owner: the human who approves it
- Plans: links to the plans that build it, added after approval

## Summary

One paragraph: who it is for, what it lets them do, and why it matters now.

## Problem

What the user cannot do today, or what is slow, risky, or confusing. Facts about the
current product, with how we know them.

## Users

The personas from personas.md that this serves, the main one first, and what each needs
from this feature.

## Before and after

A short story of one persona doing the task today, then the same task with this feature.

## Jobs and user stories

- As <persona>, I want <goal>, so that <reason>.

## Requirements

| ID | Requirement | Priority | Acceptance (from the user's view) |
|---|---|---|---|
| R1 | What the user can do | Must / Should / Could | Given ..., when ..., then the user ... |

Requirements say what the user can do and see, never how it is built.

## Experience

The screens or commands the user meets, as a list or a rough sketch, and what must hold
on a phone and on a PC. The mockup link goes here during review.

## Constraints

Cost and paid generation, privacy, licenses, accessibility, performance as the user feels
it, and what must keep working.

## Success

How we will know it worked: a task the user can do, and how fast or how easily, checked
by the human after release.

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

### Personas

`docs/prd/personas.md` starts with three personas, each with a goal, a setting, what they fear, and what success looks like. The PM may propose more, and the human approves them like a PRD change:

- **The weekend creator:** writes voice dramas as a hobby, reviews on a phone on the train, wants to hear progress fast, and fears surprise costs.
- **The careful publisher:** posts finished dramas publicly, and needs every sound's license to be right before publishing.
- **The agent driver:** has agents draft and generate, steps in only to judge and fix, and wants every fix to be one tap or one sentence.

## Tasks

Run in order. Each task uses a Claude reviewer; the coordinator may review small doc diffs directly.

- [ ] PRD docs and template
  - Target: `docs/prd/` (new)
  - Change: `docs/prd/README.md` with the naming, lifecycle, short path, template, and index; `docs/prd/personas.md` with the three personas; `docs/prd/reviews/` with a README saying what goes there.
  - Constraints: no code. No content from the user directory or any real person.
  - Ownership: `docs/prd/`.
  - Acceptance: the coordinator checks that the template matches this plan and that the README links work.
- [ ] Workflow and rules
  - Target: `AGENTS.md`, `docs/development-workflow.md`, `docs/plans/README.md`
  - Change: an AGENTS.md rule that new user-facing work needs an Approved PRD before a plan, with the short path; a "Product step" section in the development workflow describing the roles, the lifecycle, the review card, the creative review techniques, the traceability check, and the orchestration table; and in the plan template, the `PRD:` header line and the `Requirements:` task field.
  - Constraints: no code. Keep the rules of 0001 unchanged except for the new step in front.
  - Ownership: `AGENTS.md`, `docs/development-workflow.md`, `docs/plans/README.md`.
  - Acceptance: the coordinator checks that the rules, the workflow, and the template agree with each other and with this plan.
- [ ] First PRD as a trial
  - Target: `docs/prd/P0001-*.md`
  - Change: run the full flow once on a real request, chosen by the human, including the review card and the mockup. Record what was slow or awkward in "Lessons learned" in this plan, and adjust the docs.
  - Constraints: follows the new workflow. Ends at the approval gate; the plan for it is separate work.
  - Ownership: `docs/prd/`, the "Lessons learned" section of this plan.
  - Acceptance: the human approves the PRD through the review card.

## Lessons learned

From P0001, a baseline PRD written after the product, on 2026-10-31:

- A baseline PRD of an existing product needs a "Today" column (Built, Partial, Missing). It turned the PRD into a gap list, and the feasibility reviewer corrected 12 of its 33 entries against the code. Keep the column in the template.
- The reviews ran as five parallel Claude subagents without an Orca Run, because they only read and each wrote one file. That was enough for a PRD review. The feasibility check ran on Claude, not Codex, and still found the most facts; Codex can stay optional for PRDs that touch security.
- No mockup was made, because the product exists and the owner can try it. A mockup is for PRDs of new screens.
- The review card worked best as decisions with a recommended answer, answered in chat. The owner answered several by asking for an opinion instead, so the card should state the coordinator's opinion and the design principle behind each recommendation.
- Numbered questions drifted: the owner's numbers did not match the card's after a skipped question. Give each decision a short name as well as a number.
- Writing a design principle (agent first, UI for what agents do badly) settled several decisions at once. A PRD for a new area should ask early whether such a principle exists.

## Open questions

- What happens to the draft plans 0010 to 0013, which came before this step? The suggestion is to use their four requests as the trial: one PRD for the review experience that covers speed, projects, library, and retakes, then revise the plans to trace to it.
- Should the PM interview the human live in the terminal, rather than through batched questions? The default is batched, so the human can answer from a phone.
- Should the review card collect the human's answers by itself, through an artifact with saved state, so that no chat reply is needed? The default is yes if the artifact capability is available, otherwise the answers come back in chat.

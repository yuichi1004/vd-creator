# P0001: vd-creator product baseline

- Status: Draft
- Date: 2026-10-31
- Owner: the project owner
- Plans: written after the product, as a baseline: [0002](../plans/0002-architecture.md) to [0009](../plans/0009-follow-ups-0003-0008.md). Draft plans [0010](../plans/0010-settings-and-playback-speed.md) to [0013](../plans/0013-voice-retake-with-agent.md) wait for this PRD.

This PRD is written after the fact. It describes the whole product from the user's point of view, marks what exists today in the "Today" column, and makes the gaps visible so that the next plans start from the user rather than from a feature request.

## Summary

vd-creator lets one person make a voice drama, the kind posted on YouTube with still images and subtitles, from a script they wrote, without recording anyone. Coding agents turn the script into a scenario and generate the voices, sound effects, and music; the creator listens, judges, and fixes what sounds wrong, on a PC or a phone; and the result is a finished audio or video file whose sounds are all cleared for the way it will be published. It matters now because AI voices are good enough to carry a drama, but the tools around them are made for single clips, not for a story with many lines, many takes, and licenses to track.

## Problem

Making a voice drama with AI voices by hand means:

- Generating each line in a vendor's web page, one clip at a time, and keeping track of which take of which line is the good one.
- Assembling the clips, sound effects, and music in an audio editor, on a timeline built from nothing, and doing it again whenever a line changes.
- Paying for every attempt, often without knowing the cost until after.
- Collecting the license of every sound from many sites, and hoping the record is right when the drama is published.
- Doing all of this at a desk. The moments when a creator has time to listen, such as a commute, are lost.

Coding agents can do most of the mechanical work, but only if the drama is written down in a form they can read and change, and only if a human can easily check and correct what they made.

## Users

Developers who work with agents come first. The product then grows toward creators who are at home with agentic content tools, such as ElevenLabs users, but who may not program. Requirements are written so that such a creator could meet them, even where today's product still needs a developer.

From [personas](personas.md):

- **The weekend creator** (main): wants to hear a first draft of an episode quickly, review it on a phone, and fix it in small steps, without surprise costs.
- **The agent driver**: wants agents to do the drafting and generation, and to step in only to judge and correct, with every change visible.
- **The careful publisher**: wants to know before rendering that every sound may be used as planned, and to have the credits ready.

## Before and after

**Before.** Aki finishes a ten-minute script on Saturday. On Sunday they paste lines into a voice site one by one, download forty clips with names like `audio (17).mp3`, and lay them out in an audio editor. Two lines sound flat; regenerating them means finding the clip, the settings, and the place on the timeline again. The music they found has a license page they forgot to save. By Sunday night the episode is half done, and they have spent more credits than they meant to.

**After.** Aki gives the script to an agent on Saturday evening. The agent writes the scenario, picks sounds from Aki's library, and generates a free placeholder version, then tells Aki what a real generation would cost. Aki approves, and listens to the drama on the train on Sunday morning. Two lines sound flat; Aki types "more tired, slower" on each, hears the new takes, and keeps the better ones. At home they render the video with subtitles. The credits file lists every sound and voice, and the license check passed before the render started.

## Jobs and user stories

1. **Start a drama.** As the weekend creator, I want to turn my script into a drama project with little setup, so that I spend my time on the story.
2. **Let an agent draft it.** As the agent driver, I want an agent to write the scenario and generate the audio from my script and notes, so that I start from a full draft, not an empty timeline.
3. **Control cost.** As the weekend creator, I want to hear a free placeholder version first and see the cost before any paid generation, so that I never pay by surprise.
4. **Listen and judge.** As the weekend creator, I want to play the drama with its images, on a PC or a phone, from any point, so that I can judge it where I have time.
5. **Fix what sounds wrong.** As the agent driver, I want to fix a line by editing it, asking for a new take, or saying what is wrong, so that each fix is quick.
6. **Compare takes.** As the weekend creator, I want to hear earlier takes of a line and go back to one, so that a new take never loses a good one.
7. **Reuse sounds.** As the weekend creator, I want to find and reuse sound effects and music from earlier dramas, so that I do not pay for or search for them again.
8. **Stay cleared to publish.** As the careful publisher, I want every sound's source and license recorded and checked against how I will publish, so that I am not surprised after publishing.
9. **Finish.** As the careful publisher, I want an audio file, a video with the still images, subtitles, and a credits text, so that I can upload the episode.
10. **Work across episodes.** As the weekend creator, I want to switch between my dramas and episodes easily, so that a series feels like one body of work.

## Requirements

"Today" says what the product does now: Built, Partial, or Missing. Priorities are proposals for the owner to confirm.

### Start and draft

| ID | Requirement | Priority | Acceptance (from the user's view) | Today |
|---|---|---|---|---|
| R1 | The user can create a drama project in one step. | Must | Given a new folder name, when the user or an agent creates a project, then it has a valid starter scenario. | Built (`vd init`) |
| R2 | An agent can write and change the whole drama in a readable text form, and is told when it got the format wrong. | Must | Given a script, when an agent writes the scenario, then validation reports each mistake with where it is and how to fix it. | Built (scenario format, `vd validate`) |
| R3 | The drama holds speakers, scenes, lines with direction, sound effects, music, pauses, and still images. | Must | Given a scenario with all of these, when it is played or rendered, then each appears at its place. | Built |
| R4 | The user can choose and audition a voice for each speaker before generating the whole drama. | Should | Given a speaker, when the user tries candidate voices on a sample line, then they hear each and can pick one. | Missing: voices are set by ID in the scenario |
| R5 | The user can set up the tool without knowing its internals. | Should | Given a new machine with the prerequisites, when the user follows the README, then they can serve the UI in under 15 minutes. | Partial: needs a repository checkout, Node.js, and ffmpeg |

### Generate and control cost

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R6 | The user can hear a free placeholder version of the whole drama. | Must | Given a scenario, when generated with the free provider, then every item has audio with the right length and place. | Built (mock provider) |
| R7 | Before any paid generation, the user sees what will be generated and its cost, and must confirm. | Must | Given a paid provider, when generation starts from the CLI or the UI, then nothing is billed until the user confirms the shown plan. | Built (`--yes`, UI confirm) |
| R8 | Nothing already generated is generated again unless the user changed it or asked for a new take. | Must | Given an unchanged line, when generation runs again, then it is not billed. | Built (cache) |
| R9 | The user can see how much they have spent on a drama. | Could | Given a drama, when the user asks, then they see the characters and credits used so far. | Missing |

### Listen and review

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R10 | The user can play the drama with its still images, from the start or from any item, on a PC or a phone. | Must | Given a phone on the same private network, when the user taps play on an item, then playback starts there and the image follows. | Built (review UI over Tailscale) |
| R11 | The UI shows changes an agent makes while the user is reviewing. | Must | Given the UI is open, when an agent edits the scenario, then the UI updates without losing the place. | Built |
| R12 | The user can listen faster or slower to review efficiently. | Should | Given a drama, when the user sets 1.5x, then playback is faster and voices keep their pitch. | Missing (draft plan 0010) |
| R13 | The user can tell at a glance which items are missing, generating, or ready, and which are paid. | Must | Given a partly generated drama, when the user opens it, then each item's status is visible. | Built |
| R14 | The user can leave a note on a line for later or for an agent, without changing it. | Could | Given a line, when the user adds a note, then an agent working later can read it. | Missing |

### Fix

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R15 | The user can edit a line's text, speaker, and timing in the UI. | Must | Given a line, when the user edits it and saves, then the scenario changes and the line is marked to regenerate. | Built |
| R16 | The user can ask for a new take of a line. | Must | Given a line, when the user taps regenerate, then a new take is made after any cost confirm. | Built |
| R17 | The user can change a line's direction and voice settings in the UI. | Should | Given a line, when the user changes its direction or a voice parameter, then the next take uses it. | Missing (draft plan 0013) |
| R18 | The user can say what is wrong in their own words, and get a proposed fix to accept or reject. | Should | Given an instruction such as "more surprised", when the user sends it, then they see the proposed change before anything changes. | Missing (draft plan 0013) |
| R19 | The user can hear earlier takes of a line and go back to one without paying again. | Should | Given a line with three takes, when the user picks the first, then it plays in the drama and nothing is generated. | Missing (draft plan 0013) |
| R20 | The user can undo a change made in the UI. | Could | Given an edit saved by mistake, when the user undoes it, then the line is as before. | Missing |
| R21 | Structural changes, such as adding or moving scenes and lines, are made by agents, not in the UI. | Must | Given a request to add a scene, when the user asks an agent, then the agent edits the scenario and the UI shows it. | Built (by design) |

### Sounds and licenses

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R22 | The user keeps one library of sound effects and music, shared by all dramas, with the source and license of each. | Must | Given a downloaded sound, when it is imported, then its source, license, and saved license terms are recorded. | Built (`vd library`) |
| R23 | Agents look in the library before generating or searching for a sound. | Must | Given a matching entry, when an agent needs that sound, then it uses the entry. | Built (agent rule) |
| R24 | The user can browse the library by kind, tag, and words, preview sounds, and use one in the drama. | Should | Given a library of 100 sounds, when the user filters by a tag, then they can preview and use one in under a minute. | Partial: search from one item only (draft plan 0012) |
| R25 | The user can add a sound generated for a drama to the library. | Should | Given a generated sound effect, when the user adds it, then it is in the library with the provider's license. | Partial: CLI only (draft plan 0012) |
| R26 | Only a human can mark a license record as checked. | Must | Given an imported sound, when an agent works with it, then it stays unchecked until the user verifies it. | Built |
| R27 | The user states how they will publish, and the tool checks every sound and voice against it before rendering. | Must | Given a drama for monetized video, when a sound's license forbids that, then validation and rendering stop and say which sound. | Built (`publish.use`) |

### Finish

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R28 | The user can render the drama to one audio file, a video with the still images, and subtitles. | Must | Given a fully generated drama, when the user renders it, then they get the files they asked for. | Built (`vd render`) |
| R29 | The user gets a credits text listing every voice and sound with its attribution. | Must | Given a render, then a credits file is written that can be pasted into a video description. | Built |
| R30 | The user can render from the UI. | Could | Given a finished review on a PC, when the user taps render, then the files are written. | Missing (non-goal of 0005) |

### Work across dramas

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R31 | The user can pick a drama from a list in the UI, without restarting anything. | Should | Given several projects, when the user opens the UI, then they choose one from a list. | Missing (draft plan 0011) |
| R32 | Personal settings, notes, and keys stay outside the shared code and are never published by the tool. | Must | Given a user directory, when the user works with agents, then nothing from it is committed or uploaded. | Built (user directory) |
| R33 | A new episode can start from another project's speakers and voices. A series is several projects, not a separate thing. | Could | Given episode 2, when an agent creates it from episode 1, then it starts with episode 1's speakers. | Missing |

## Experience

### Design principle: agent first, UI for what agents do badly

The drama is made through agents. Anything that needs judgment in many steps, such as writing, restructuring, choosing sounds, or a complex fix, is asked of an agent in plain words. The UI covers the work where an agent is a poor fit:

- **Hearing and seeing:** playback, preview, speed, and following the images. An agent cannot listen for the user.
- **Quick, single-step actions:** regenerate a take, pick an earlier take, swap a sound for a library entry, adjust one parameter.
- **Small text fixes:** a typo or a word in one line, where explaining the change would take longer than making it.
- **Human-only decisions:** confirming a paid generation and verifying a license.

A UI feature that would need several steps of judgment is a sign the work belongs to an agent. The UI may hand such work to an agent, as a proposal the user accepts, but it does not grow its own editor for it.

### Where the user works

- **Agents in a terminal** do the drafting, generation, structural edits, library imports, and rendering, through the `vd` commands and the scenario format guide.
- **The review UI** in a browser on a PC, or on a phone over a private network, is for listening, judging, and small fixes. On a phone it is one column with the image at the top and the player at the bottom, and every control works by tap.
- **The human** makes every decision that costs money or concerns rights: paid generation, license verification, publishing use, and pushing changes.

## Constraints

- **Cost:** no paid generation without the user seeing and confirming the plan. Agents never decide to spend.
- **Privacy:** everything runs on the user's machine. Phone access goes over a private network; nothing is hosted on the internet by the tool.
- **Rights:** licenses are recorded with evidence, never guessed, and verified only by a human.
- **Phone use:** playback and fixes work on current iOS Safari and Android Chrome, by tap only.
- **Agent-readable:** the drama stays a text file that agents and people can read and change with ordinary tools.

## Success

- A new episode goes from a finished script to a first full listen, with placeholder audio, in one evening.
- Fixing a line that sounds wrong takes under a minute on a phone, from hearing it to hearing the new take.
- No paid generation happens without a confirm. No published drama has a sound whose license is unknown.
- After a review session, the user can say which lines changed and why.

## Non-goals

- Recording real voices, or editing waveforms by hand.
- A hosted service, user accounts, or collaboration between several people.
- Generating still images. The user or an agent provides them.
- A full timeline editor. Agents make structural changes.
- Publishing to video sites from the tool.

## Assumptions and risks

- **Assumption:** creators are comfortable letting a coding agent run in a terminal. If not, the product needs a way to start a drama from the UI.
- **Assumption:** the review happens mostly on a phone, so phone playback quality and latency matter as much as features.
- **Risk:** voice quality and direction depend on one paid vendor; a price or model change affects every drama.
- **Risk:** the split between agent work and UI work may confuse users who expect to do everything in the UI.
- **Risk:** setup from a repository checkout may stop non-developers before they start.

## Decisions

| Date | Question | Decision | By |
|---|---|---|---|
| 2026-10-31 | Who is the user? | Developers who use agents first; later, creators at home with agentic content tools who may not program. | Owner |
| 2026-10-31 | Where does a drama start? | From an agent only. The UI follows the design principle in Experience. | Owner |
| 2026-10-31 | Is setting voices by ID enough for now (R4)? | Yes for now. R4 stays Should. | Owner |
| 2026-10-31 | Is a series its own thing (R33)? | No. A series is several projects. | Owner |

## Open questions

1. **Order of the missing pieces.** Which gaps to build first. Suggested: speed (R12); then fixing lines with direction, settings, and earlier takes (R17 to R19); then the library screen (R24, R25); then the project picker (R31); then the rest (R4, R9, R14, R20, R30, R33).

## Change log

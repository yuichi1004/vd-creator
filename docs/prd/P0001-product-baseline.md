# P0001: vd-creator product baseline

- Status: In review
- Date: 2026-10-31
- Owner: the project owner
- Plans: written after the product, as a baseline: [0002](../plans/0002-architecture.md) to [0009](../plans/0009-follow-ups-0003-0008.md). Draft plans [0010](../plans/0010-settings-and-playback-speed.md) to [0013](../plans/0013-voice-retake-with-agent.md) wait for this PRD.
- Reviews: [reviews/P0001/](reviews/P0001/)

This PRD is written after the fact. It describes the whole product from the user's point of view, marks what exists today in the "Today" column, and makes the gaps visible so that the next plans start from the user rather than from a feature request.

## Summary

vd-creator lets one person make a voice drama, the kind posted on YouTube with still images and subtitles, from a script they wrote, without recording anyone. Coding agents turn the script into a scenario and generate the voices, sound effects, and music; the creator listens, judges, and fixes what sounds wrong, on a PC or a phone; and the result is a finished audio or video file whose voices, sounds, and images are all cleared for the way it will be published. It matters now because AI voices are good enough to carry a drama, but the tools around them are made for single clips, not for a story with many lines, many takes, and licenses to track.

## Problem

Making a voice drama with AI voices by hand means:

- Generating each line in a vendor's web page, one clip at a time, and keeping track of which take of which line is the good one.
- Assembling the clips, sound effects, and music in an audio editor, on a timeline built from nothing, and doing it again whenever a line changes.
- Paying for every attempt, often without knowing the cost until after.
- Collecting the license of every voice, sound, and image from many sites, and hoping the record is right when the drama is published.
- Doing all of this at a desk. The moments when a creator has time to listen, such as a commute, are lost.

Coding agents can do most of the mechanical work, but only if the drama is written down in a form they can read and change, and only if a human can easily check and correct what they made.

## Users

Developers who work with agents come first. The product then grows toward creators who are at home with agentic content tools, such as ElevenLabs users, but who may not program. Requirements are written so that such a creator could meet them, even where today's product still needs a developer.

From [personas](personas.md):

- **The weekend creator** (main): wants to hear a first draft of an episode quickly, review it on a phone, and fix it in small steps, without surprise costs.
- **The agent driver**: wants agents to do the drafting and generation, and to step in only to judge and correct, with every change visible.
- **The careful publisher**: wants to know before rendering that every voice, sound, and image may be used as planned, and to have the credits ready.

## Before and after

**Before.** Aki finishes a ten-minute script on Saturday. On Sunday they paste lines into a voice site one by one, download forty clips with names like `audio (17).mp3`, and lay them out in an audio editor. Two lines sound flat; regenerating them means finding the clip, the settings, and the place on the timeline again. The music they found has a license page they forgot to save. By Sunday night the episode is half done, and they have spent more credits than they meant to.

**After (the target).** Aki gives the script to an agent on Saturday evening. The agent writes the scenario, picks sounds from Aki's library, and makes a free draft with real words, so Aki hears the script and the pacing that night. The agent then makes one pilot scene with the real voices; Aki judges the casting and the acting, and approves the full run after seeing its cost in characters. On Sunday morning Aki listens on the train. Two lines sound flat; Aki types "more tired, slower" on each, hears the new takes, compares them with the old ones, and keeps the better ones. Back home, the agent reads the change log to see what Aki changed. Aki renders the video with subtitles; the license check covered every voice, sound, and image, and the credits list them all.

Today, the scenario, the library, the paid run with its confirm, listening on a phone with the screen on, regenerating a line, and the render work. The free draft is tones, not words. The pilot scene can be made by generating chosen lines only. The instruction box, the list of takes, the change log, and licenses for voices and images are missing.

## Design principle: agent first, UI for what agents do badly

The drama is made through agents. Anything that needs judgment in many steps, such as writing, restructuring, choosing sounds, changing how a line is acted, or a complex fix, is asked of an agent in plain words. The UI covers the work where an agent is a poor fit:

- **Hearing and seeing:** playback, preview, speed, comparing takes, and following the images. An agent cannot listen for the user.
- **Quick, single-step actions:** regenerate a take, go back to an earlier take, swap a sound for a library entry.
- **Small text fixes:** a typo or a word in one line, or its short direction, where explaining the change would take longer than making it.
- **Human-only decisions:** confirming a paid generation and verifying a license.

A UI feature that would need several steps of judgment is a sign the work belongs to an agent. The UI may hand such work to an agent, as an instruction whose result the user hears and accepts, but it does not grow its own editor for it. The two sides stay in step through a change log: agents read what the user changed in the UI before they work on the drama.

## Jobs and user stories

1. **Start a drama.** As the weekend creator, I want to turn my script into a drama project with little setup, so that I spend my time on the story.
2. **Let an agent draft it.** As the agent driver, I want an agent to write the scenario and generate the audio from my script and notes, so that I start from a full draft, not an empty timeline.
3. **Hear it before I pay.** As the weekend creator, I want a free draft with real words, then a paid pilot scene, before the full paid run, so that I judge the script and the casting without paying for the whole drama.
4. **Control cost.** As the weekend creator, I want to see what a paid run will use from my plan before it starts, so that I never pay by surprise.
5. **Listen and judge.** As the weekend creator, I want to play the drama with its images, on a PC or a phone, from any point, so that I can judge it where I have time.
6. **Fix what sounds wrong.** As the agent driver, I want to say in one line what is wrong with a line and hear the result, so that each fix is quick.
7. **Compare takes.** As the weekend creator, I want to hear earlier takes of a line and go back to one, so that a new take never loses a good one.
8. **Keep agents in step.** As the agent driver, I want agents to know what I changed in the UI, so that they build on my fixes instead of undoing them.
9. **Reuse sounds.** As the weekend creator, I want to find and reuse sound effects and music from earlier dramas, so that I do not pay for or search for them again.
10. **Stay cleared to publish.** As the careful publisher, I want every voice, sound, and image's source and license recorded and checked against how I will publish, so that I am not surprised after publishing.
11. **Finish.** As the careful publisher, I want an audio file, a video with the still images, subtitles, and a credits text, so that I can upload the episode.
12. **Work across episodes.** As the weekend creator, I want to switch between my dramas and episodes easily, so that a series feels like one body of work.

## Requirements

"Today" says what the product does now: Built, Partial, or Missing, with the review's evidence in [feasibility](reviews/P0001/feasibility.md). Priorities are proposals for the owner to confirm. IDs are never reused; new requirements get new numbers.

### Start and draft

| ID | Requirement | Priority | Acceptance (from the user's view) | Today |
|---|---|---|---|---|
| R1 | The user can create a drama project in one step. | Must | Given a new folder name, when the user or an agent creates a project, then it has a valid starter scenario. | Built (`vd init`) |
| R2 | An agent can write and change the whole drama in a readable text form, and is told when it got the format wrong. | Must | Given a script, when an agent writes the scenario, then validation reports each mistake with where it is and how to fix it. | Partial: every mistake has its place, but some have no fix hint |
| R3 | The drama holds speakers, scenes, lines with direction, sound effects, music, pauses, and still images. | Must | Given a scenario with all of these, when it is played or rendered, then each appears at its place. | Built |
| R4 | The user can choose and audition a voice for each speaker before generating the whole drama. | Should | Given a speaker, when the user tries candidate voices on a sample line, then they hear each and can pick one. | Missing: voices are set by ID in the scenario, which is enough for now |
| R5 | The user can set up the tool and open a drama on their phone without knowing its internals. | Should | Given a new machine with the prerequisites, when someone other than the owner follows the README, copying commands but writing none, then they open a drama on their phone within 30 minutes. | Partial: needs a repository checkout, Node.js, ffmpeg, and a private network such as Tailscale |

### Generate and control cost

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R6 | The user can hear a free placeholder of the whole drama with its timing. | Must | Given a scenario, when generated with the free provider, then every item has audio at its place. | Built (tones, not words) |
| R34 | The user can hear a free draft with real words, to judge the script and the pacing. | Should | Given a scenario, when the free draft is made, then each line is spoken in an understandable voice, at no cost. | Missing |
| R35 | The user can have a pilot scene made with the real voices before the full run, and the pilot is never paid for twice. | Should | Given an approved pilot of one scene, when the full run starts, then the pilot's lines are not generated again. | Partial: chosen lines can be generated alone, and the cache keeps them |
| R7 | Before any paid generation, the user sees what will be generated and its cost, and must confirm. The cost is shown in characters first, then as an estimate in US dollars, and with the characters left on the user's plan where the vendor reports them. | Must | Given a paid provider, when generation starts from the CLI or the UI, then nothing is billed until the user confirms the shown plan, which shows characters, an estimate in dollars, and what is left. | Partial: characters and requests only; the CLI confirm is a flag that an agent could pass |
| R8 | Nothing already generated is generated again unless the user changed it or asked for a new take. | Must | Given an unchanged line, when generation runs again, then it is not billed. | Built (cache) |
| R9 | The user can see how many characters a drama has used so far. | Could | Given a drama, when the user asks, then they see the characters used and the estimate in dollars. | Missing |

### Listen and review

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R10 | The user can play the drama with its still images, from the start or from any item, on a PC or a phone with the screen on. When the screen locks or the page goes to the background, playback stops and keeps its place. | Must | Given a phone on the same private network, when the user taps play on an item, then playback starts there and the image follows; when the screen locks, it stops, and play resumes from there. | Partial: works on a PC browser; not yet checked on a real phone (plan 0009 checklist) |
| R11 | The UI shows changes an agent makes while the user is reviewing. | Must | Given the UI is open, when an agent edits the scenario, then the UI updates and keeps the playback position. | Built: the position is kept in seconds, so an edit earlier in the drama shifts what plays |
| R12 | The user can listen faster or slower to review efficiently. | Should | Given a drama, when the user sets 1.5x, then playback is faster and voices keep their pitch. | Missing (draft plan 0010) |
| R13 | The user can tell at a glance which items are missing, generating, or ready, and which have draft audio rather than final audio. | Must | Given a drama with some draft and some paid audio, when the user opens it, then each item's state and its kind of audio are visible. | Partial: states are shown; draft and final audio look the same |
| R14 | The user can leave a note on a scene or the whole drama for an agent, without changing it. | Could | Given a scene, when the user adds a note, then an agent working later can read it. Notes on one line are covered by R18. | Missing |

### Fix

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R15 | The user can fix a line's text, speaker, and timing in the UI. | Must | Given a line, when the user edits it and saves, then the scenario changes and a changed text or speaker is marked to regenerate. | Built: text, speaker, and take on PC and phone; timing on PC only. The UI also edits SFX and BGM prompts and BGM volume |
| R16 | The user can ask for a new take of a line. | Must | Given a line, when the user taps regenerate, then a new take is made after any cost confirm. | Built |
| R18 | The user can say in one line what is wrong with a line, and an agent proposes a change to its text, direction, or voice settings. The user hears the new take and keeps or rejects it. | Must | Given an instruction such as "more tired, slower", when the user sends it, then they see the proposed change and hear the new take before anything is kept. | Missing (draft plan 0013) |
| R19 | The user can hear earlier takes of a line and go back to one without paying again. | Must | Given a line with three takes, when the user picks the first, then it plays in the drama and nothing is generated. | Partial: setting the take number back plays the cached take, until `vd clean` removes it; there is no list to hear and pick from |
| R17 | The user can edit a line's direction as a short text. | Should | Given a line, when the user changes its direction, then the next take uses it. | Missing |
| R37 | The user can adjust a line's voice settings directly, such as stability or speed. | Could | Given a line, when the user changes one setting, then the next take uses it. Agents can change settings through R18 meanwhile. | Missing |
| R38 | Every change made in the UI is kept in a change log that agents read before they work on the drama. | Must | Given the user changed three lines on the phone, when an agent starts work, then it can list those changes with their old and new values and their time. | Missing |
| R39 | After an agent changes the drama, the user can see what it changed and why. | Must | Given an agent run, when the user opens the UI, then the items changed since their last visit are marked, with the agent's reason. | Missing |
| R20 | The user can undo a change made in the UI. | Could | Given an edit saved by mistake, when the user undoes it, then the line is as before. | Missing |
| R21 | Structural changes, such as adding or moving scenes and lines, are made by agents, not in the UI. | Must | Given a request to add a scene, when the user asks an agent, then the agent edits the scenario and the UI shows it. | Built (by design) |

### Voices, sounds, images, and licenses

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R22 | The user keeps one library of sound effects and music, shared by all dramas, with the source and license of each. | Must | Given a downloaded sound, when it is imported, then its source, license, and saved license terms are recorded. | Built (`vd library`) |
| R23 | Agents look in the library before generating or searching for a sound. | Must | Given a library entry tagged for a sound the scenario needs, when an agent writes that sound, then the scenario refers to the entry instead of a new prompt. | Built as an agent rule |
| R24 | The user can browse the library by kind, tag, and words, preview sounds, and use one in the drama. | Should | Given a library of 100 sounds, when the user filters by a tag, then they can preview and use one in under a minute. | Partial: search from one item only (draft plan 0012) |
| R25 | The user can add a sound generated for a drama to the library. | Should | Given a generated sound effect, when the user adds it, then it is in the library with the provider's license. | Partial: CLI only (draft plan 0012) |
| R26 | Only a human marks a license record as checked, and only a human confirms paid generation. | Must | Given an imported sound, when an agent works with it, then it stays unchecked until the user verifies it. | Partial: the CLI and the UI ask a human, but nothing stops an agent that ignores the rules; see Constraints |
| R27 | Every voice, sound effect, piece of music, and still image has its source and license recorded, and is checked against how the user will publish before rendering. A video render needs the publishing use to be set, and shows it. | Must | Given a drama for monetized video, when a voice, sound, or image's license forbids that or is unknown, then validation and rendering stop and say which one. | Partial: library sounds and each provider as a whole are checked; single voices and images have no record |
| R40 | Each speaker's voice records what it is (a vendor's stock voice, a shared voice, or a cloned voice), who owns it, and the terms it was used under. | Must | Given a cloned voice, when it is used, then its owner and the consent are recorded, and the license check uses them. | Missing |
| R41 | Each still image records its source, author, and license, like a library sound. | Must | Given an image without a license record, when the user renders a video, then the render stops and names it. | Missing |

### Finish

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R28 | The user can render the drama to one audio file, a video with the still images, and a subtitle file. | Must | Given a fully generated drama, when the user renders it, then they get the files they asked for. | Built: subtitles are a separate file, not burned in |
| R36 | A render warns about every item that still has draft audio. | Must | Given a drama with one line of draft audio, when the user renders it, then the render names that line and asks before going on. | Missing: render accepts draft audio silently |
| R29 | The user gets a credits text listing every voice, sound, and image with its attribution. | Must | Given a render, then a credits file is written that names each speaker's voice, each sound, and each image, and can be pasted into a video description. | Partial: provider names and library attributions only |
| R30 | The user can render from the UI. | Could | Given a finished review on a PC, when the user taps render, then the files are written. | Missing (non-goal of 0005) |

### Work across dramas

| ID | Requirement | Priority | Acceptance | Today |
|---|---|---|---|---|
| R31 | The user can pick a drama from a list in the UI, without restarting anything. | Should | Given several projects, when the user opens the UI, then they choose one from a list. | Missing (draft plan 0011) |
| R32 | Personal settings, notes, and keys stay outside the shared code and are never published by the tool. | Must | Given a user directory, when the tool writes files, then none of them land in the repository, and a scan of committed files finds no user directory path. | Partial: the user directory is kept out of the repository by the tool; "never committed" is otherwise an agent rule |
| R33 | A new episode can start from another project's speakers and voices. A series is several projects, not a separate thing. | Could | Given episode 2, when an agent creates it from episode 1, then it starts with episode 1's speakers. | Missing |

## Experience

- **Agents in a terminal** do the drafting, generation, structural edits, changes to how lines are acted, library imports, and rendering, through the `vd` commands and the scenario format guide.
- **The review UI** in a browser on a PC, or on a phone over a private network, is for listening, judging, comparing takes, one-line instructions, and small fixes. On a phone it is one column with the image at the top and the player at the bottom, and every control works by tap. The screen stays on while listening; locking it pauses playback.
- **The human** makes every decision that costs money or concerns rights: paid generation, license verification, publishing use, and pushing changes.

## Constraints

- **Cost:** no paid generation without the user seeing and confirming the plan. Characters are the main unit, because most users pay through a subscription; dollars are a secondary estimate.
- **Human-only steps:** paid generation and license verification are confirmed by a human. Agents follow this as a rule, backed by their tool's permission checks, such as an AI classifier; vd-creator itself does not stop an agent that breaks the rule. The PRD says so plainly, and a later PRD may change it.
- **Privacy:** the drama, its files, and the user's settings stay on the user's machine. The voice vendor receives the text of each line it speaks, and coding agents send what they read to their own model vendor. Phone access goes over a private network; the tool hosts nothing on the internet.
- **Rights:** licenses are recorded with evidence, never guessed, and verified only by a human.
- **Phone use:** playback and fixes work on current iOS Safari and Android Chrome, by tap only, with the screen on.
- **Agent-readable:** the drama and its change log stay text files that agents and people can read and change with ordinary tools.

## Success

- A new episode goes from a finished script to a first full listen with real words, at no cost, in one evening.
- Fixing a line that sounds wrong takes under three minutes on a phone, from hearing it to hearing the new take, through a one-line instruction.
- In a test project, a paid run started without the confirm bills nothing, and a render with an unknown license or draft audio stops and names the item.
- After a review session, an agent can list which lines the user changed, from the change log alone.
- One real episode of at least ten minutes has been made end to end with paid voices and reviewed on a phone.
- Someone other than the owner sets the tool up from the README and opens a drama on their phone.

## Non-goals

- Recording real voices, or editing waveforms by hand.
- A hosted service, user accounts, or collaboration between several people.
- Generating still images. The user or an agent provides them, with their license.
- A full timeline editor. Agents make structural changes.
- Publishing to video sites from the tool.
- Listening with the screen locked or the page in the background.

## Assumptions and risks

- **Assumption:** creators are comfortable letting a coding agent run in a terminal. If not, the product needs a way to start a drama from the UI.
- **Assumption:** the review happens mostly on a phone, so phone playback quality and latency matter as much as features.
- **Assumption:** agents' tools keep their own permission checks, which stand in for enforcement of the human-only steps.
- **Assumption:** a free speech engine that is good enough for a draft exists for the languages users write in, with terms that allow a draft.
- **Risk:** voice quality and direction depend on one paid vendor; a price or model change affects every drama.
- **Risk:** the paid path, phone review, and a full-length episode have not yet been tested end to end.
- **Risk:** the split between agent work and UI work may confuse users who expect to do everything in the UI.
- **Risk:** setup from a repository checkout, and a private network for the phone, may stop non-developers before they start.

## Decisions

| Date | Question | Decision | By |
|---|---|---|---|
| 2026-10-31 | Who is the user? | Developers who use agents first; later, creators at home with agentic content tools who may not program. | Owner |
| 2026-10-31 | Where does a drama start? | From an agent only. The UI follows the design principle above. | Owner |
| 2026-10-31 | Is setting voices by ID enough for now (R4)? | Yes for now. R4 stays Should. | Owner |
| 2026-10-31 | Is a series its own thing (R33)? | No. A series is several projects. | Owner |
| 2026-10-31 | How are lines' acting fixed (R17 to R19)? | By a one-line instruction to an agent (R18, Must), with earlier takes in the UI (R19, Must). Direction as text is Should (R17); direct voice settings are Could (R37). | Owner |
| 2026-10-31 | How do agents learn what changed in the UI? | A change log of UI edits that agents read (R38, Must). | Owner |
| 2026-10-31 | Should the UI show what an agent changed and why (R39)? | Yes, Must: the counterpart of the change log. | Owner |
| 2026-10-31 | Which assets need license records? | Voices, music, sound effects, and images (R27, R40, R41, Must). | Owner |
| 2026-10-31 | Are the human-only steps enforced by the tool? | Not for now. They stay agent rules, backed by the agent tool's own permission checks. | Owner |
| 2026-10-31 | How does the user judge a drama before paying? | A free draft with real words (R34), a paid pilot scene (R35), then the full run; render warns about draft audio (R36). | Owner |
| 2026-10-31 | Should playback continue with the screen locked? | No. It stops and keeps its place. | Owner |
| 2026-10-31 | Which cost unit is shown? | Characters first, an estimate in dollars second, and the plan's remaining characters where the vendor reports them. | Owner |

## Open questions

1. **Order of the missing pieces.** Suggested: the review loop first (R18, R19, R38, R39, R12, R13, R36), then rights (R27, R40, R41, R29), then the draft and pilot (R34, R35), then the library screen (R24, R25), the project picker (R31), and the rest.

## Change log

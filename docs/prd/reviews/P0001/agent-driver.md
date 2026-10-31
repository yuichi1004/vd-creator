# Table read: the agent driver

P0001 gets the hard guarantees right: agents never decide to spend, never verify a license, and the drama stays a text file I can diff. But the PRD treats the agent and the UI as two separate rooms and never describes the doorway between them: what I notice on the phone has no path to the agent, and what the agent changed has no path back to me except "the UI updates". Until the hand-off, the change trail, and remembered preferences are requirements, my success criterion, "every fix is one tap or one sentence, and I can see what changed and why", is not testable.

## The journey

1. **I hand my script to Claude Code** and ask for a drama project. It runs `vd init`, writes `scenario.yaml`, and fixes what `vd validate` reports (R1, R2).
   **Friction:** the script has gaps, such as an unnamed speaker or an unclear scene break. Nothing says the agent must ask instead of guessing, or list the guesses it made. "Agents that guess" is my first fear, and the PRD only rules out guessing about money and licenses.
2. **The agent picks sounds** from my library and generates the free placeholder version (R23, R6).
   **Friction:** I am not told which sounds came from the library, which are new prompts, and why. I find out by reading YAML.
3. **The cost gate.** The agent shows the plan and stops (R7). I approve.
   **Friction:** today the CLI gate is `--yes`, and the agent can type `--yes` itself. "Must confirm" is a rule in AGENTS.md, not a property of the tool. The acceptance criterion should say how the tool knows the human confirmed, or at least that the agent shows the plan and waits for my words. SFX and music show as "1 request, 0 characters" (0004 open question), so the plan I approve understates their size.
4. **I review on my phone** on the train (R10, R13). Playback works and the images follow.
   **Friction:** I cannot see which lines changed since my last listen, or which the agent touched in its last run. R11 shows changes live but does not mark them.
5. **I notice three problems:** a flat line, a wrong sound in scene 2, and a scene that drags. Only the first fits the UI.
   **Friction:** the scene that drags is agent work by the design principle, but I am on a phone with no terminal. R14 (notes) is only a Could and Missing, so my observation dies in my head. This is the core loop of my persona and it has no requirement.
6. **I fix the flat line** with "more tired, slower" (R18) and keep the better take (R19).
   **Friction:** fine once 0013 lands. But the retake log in 0013 is per line and kept only for later agents; the PRD does not require that I can read it.
7. **Back at the PC, I tell the agent what to fix.** I re-type my phone notes from memory.
   **Friction:** the agent cannot see what I edited in the UI either. It finds out by reading the file, without knowing which edits were mine and must not be overwritten.
8. **The agent edits the scenario.** **Friction:** no requirement says it summarizes what it changed and why, or that I can undo one agent run as a whole. R20 covers UI edits only. The PRD suggests nothing about git in the project folder.
9. **Next episode.** **Friction:** "Aki speaks quickly," "no laugh tracks," "this voice needs stability 0.3": nothing carries these forward except the speaker copy in R33. The user directory holds notes, but no requirement says agents write learned preferences there or that I approve them.
10. **Final render** (R27 to R29). The license check passes and credits are written. **Friction:** I must go back to the terminal, which is fine at a PC.

## Findings

| ID | Severity | Finding | Affects | Suggestion |
|---|---|---|---|---|
| AD1 | High | No hand-off from the UI to the agent. What I notice on the phone that is not a one-line fix cannot be passed on. | R14, missing requirement | Raise R14 to Should or Must, and make it a queue: notes on a line, scene, or the whole drama that an agent lists, acts on, and marks done. Note whether a note may ask for structural work. |
| AD2 | High | No change trail from the agent. I cannot see what an agent run changed or why. The "Success" bullet "say which lines changed and why" has no requirement behind it. | R11, Success, missing requirement | Add: each agent run leaves a readable summary of its changes with reasons, and the UI marks items changed since my last review. |
| AD3 | High | Undo covers only UI edits (Could). An agent run cannot be rolled back as a unit. | R20 | Add undo of a whole agent run, for example by keeping the project under git or saving a scenario snapshot per run, and raise the priority. |
| AD4 | Medium | The cost gate on the CLI is enforced by agent obedience (`--yes`), not by the tool. | R7, Constraints | State the acceptance for agent runs: the agent shows the plan and waits for the user's explicit approval; consider a confirm the agent cannot give itself. Fix the SFX and music cost display. |
| AD5 | Medium | "Agents that guess" is addressed only for money and licenses. | R2, missing requirement | Add: when the script is ambiguous, the agent asks or records each assumption where I can see and correct it. |
| AD6 | Medium | Preferences are not learned across episodes. | R33, R32, missing requirement | Add: agents propose preferences to save in the user directory or the project, and save them only after I agree. |
| AD7 | Medium | The design principle lists what the UI does, but not how work moves between UI and agent in both directions, or who wins when both edit. | Experience | Add a hand-off subsection: UI to agent (notes, proposals), agent to UI (change marks, summaries), and a rule that agents keep the user's UI edits unless told otherwise. |
| AD8 | Low | The 0013 retake log is written for agents, not for me. | R18, R19 | Require that the user can read the history of instructions and outcomes per line. |
| AD9 | Low | Library picks and new prompts are not explained to me. | R23 | Have the agent report which sounds came from the library and which were generated. |

## Biggest friction

"I heard exactly what was wrong on the train, and by the time I got home the only way to tell the agent was to remember it."

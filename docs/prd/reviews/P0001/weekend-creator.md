# Table read: the weekend creator

The PRD describes the evening I want: script in, free draft out, fixes on the train, credits ready. But the "After" story depends on things marked Missing (fixing a line by saying what is wrong, picking an earlier take) or left out entirely (phone setup, keeping the PC awake, cost in money). The priorities are written from a developer's desk, not from a phone on a train, so the most-used train actions are rated Should or Could.

## The journey

1. **I just finished my script.** I open the agent and say "make this into a drama." The agent runs `vd init` and writes `scenario.yaml`.
   **Friction:** I do not know where the project lives or that it has to be inside a repository checkout for `npx vd` to work. R1 and R5 cover an agent or a README reader, not me.
2. **The agent picks voices.** It writes voice IDs into the scenario.
   **Friction:** I cannot hear the candidates before the agent commits (R4 Missing, decided "fine for now"). If the whole draft is in the wrong voice, I find out only after generating.
3. **I hear the free draft.** The agent generates with the mock provider.
   **Friction:** The mock makes placeholder tones, not speech. "A first full listen in one evening" (Success) tells me only about timing, not whether the drama works. The PRD should say so plainly.
4. **The agent tells me the cost.** The CLI prints characters and requests.
   **Friction:** I think in ElevenLabs credits or money, and in what is left on my plan. R7 says "its cost" but does not say in what units, or against which balance.
5. **I approve, and the agent runs the paid generation.** It needs `ELEVENLABS_API_KEY` in my shell.
   **Friction:** No requirement covers giving my key safely without editing shell files. R32 says keys stay out of the repo, not how I put them in.
6. **I set up my phone.** I follow `docs/phone-access.md`: Tailscale on both devices, `sudo tailscale serve --bg 5310`, an HTTPS consent page, a warning about the Certificate Transparency log.
   **Friction:** This is where I would lose my evening. R5's acceptance stops at "serve the UI" on the PC; R10 says "Built" but only for someone who can do this.
7. **Sunday, on the train, I tap play.**
   **Friction:** Nothing tells me the PC at home must stay on, awake, and running `vd serve`. If it slept, the page shows an error and I have no idea why. Missing requirement.
8. **Two lines sound flat.** In the story I type "more tired, slower."
   **Friction:** That is R18, Missing. Today I can edit the text or tap regenerate, which makes the same line with the same direction (R17 Missing). The heart of the "After" story cannot happen.
9. **I regenerate a take on the phone.**
   **Friction:** If the agent started `vd serve` without `--provider elevenlabs`, the UI uses the mock and I get a tone. I cannot switch it from the phone. Nothing in the PRD says which provider the review session uses or who chooses it.
10. **I want the first take back.** There is a "take" number field.
    **Friction:** I do not know which number was the good one or whether it still exists. R19 is Should, but losing a paid take is exactly the surprise cost I fear.
11. **I want to mark lines to fix later at home.**
    **Friction:** No notes (R14 Could). On a train, a flag is the most useful thing I can do.
12. **At home I render.** I ask the agent to run `vd render --video --srt`.
    **Friction:** A license error stops the render, and verifying an entry is mine to do. The PRD does not say I can verify from the UI (I can) instead of the CLI.
13. **I upload the episode.** I paste the credits text.
    **Friction:** I cannot tell what changed in this session or why (Success claims I can; no requirement backs it).

## Findings

| ID | Severity | Finding | Affects | Suggestion |
|---|---|---|---|---|
| WC1 | High | The "After" story's key step (describe what is wrong, get a new take) is Missing today, but the story reads as current. | R17, R18, Before and after | Mark the story as the target, and raise R17 to Must, since a regenerate with the same direction rarely fixes "flat". |
| WC2 | High | Phone access needs Tailscale, sudo, and certificate consent; no requirement or acceptance covers it for a non-coder. | R5, R10 | Extend R5's acceptance to "open the drama on my phone", timed, following the guide without a terminal beyond copy-paste. |
| WC3 | High | Reviewing away from home needs the PC on and `vd serve` running; failure shows as an unexplained error. | missing requirement | Add a requirement: the phone tells me when the PC is unreachable, and the docs say how to keep it serving. |
| WC4 | High | The cost shown is in characters, not credits or money, and not against my remaining balance. | R7, R9 | State units in R7's acceptance; consider raising R9 to Should. |
| WC5 | Medium | The review session's provider is fixed when `vd serve` starts; a mock session silently gives tones on regenerate. | R16, R7 | Add acceptance: the user can see and choose, before reviewing, whether regenerate is paid. |
| WC6 | Medium | Getting a good take back is the safety net against wasted credits, yet only Should; today it is a bare number. | R19 | Raise to Must, with acceptance that I can play takes side by side by tap. |
| WC7 | Medium | The mock gives tones, so the "first full listen" metric does not test the drama. | R6, Success | Say what the free draft is good for (timing, structure), or add a cheap preview option. |
| WC8 | Medium | Flagging a line on the train is the main phone action, but notes are Could. | R14 | Raise to Should, phone-first. |
| WC9 | Medium | "Say which lines changed and why" has no requirement behind it. | Success, missing requirement | Add a change history per session, readable on the phone. |
| WC10 | Low | No requirement says how a non-coder gives the API key. | R32, R5 | Add setup acceptance for the key. |
| WC11 | Low | R26 does not say verification can be done in the UI. | R26 | Name the UI verify step in the acceptance. |

## Biggest friction

"I typed 'more tired, slower' on the train like the story said, and there was nowhere to type it."

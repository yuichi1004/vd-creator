# Pre-mortem

The PRD describes the owner's workflow well, and it protects money and rights with real, built gates. It fails the non-programming creator mostly in places it lists as Built or treats as somebody else's problem: the free draft is tones, not speech; phone review needs the PC, Tailscale, and a server left running; and the paid path has never made a real call. Nothing in it measures whether a creator other than the owner ever finishes an episode.

## Failure stories

Imagine it is 2027-05-01. These are the ways it went wrong.

1. **Setup ate the evening.** Creators who found the project gave up during `scripts/setup.sh`, `npm run build`, ffmpeg, and an API key set as a shell variable. The few who got through then met Tailscale. The 15-minute target in R5 was never measured with anyone but the owner.
   **Broken assumption:** creators can work from a repository checkout. **Covered by:** R5 (Should, Partial), a listed risk. It has no priority path and no packaged install.

2. **The free draft was beeps.** The "first full listen in one evening" was a run of mock tones. Creators could not judge pacing or acting from it, so the real first listen came only after paying. That made the free step feel pointless and the paid step feel like a gamble.
   **Broken assumption:** a placeholder listen lets the creator judge the drama. **Covered by:** R6 checks only length and place. Nothing covers an intelligible free or low-cost draft.

3. **The agent drafted confidently and wrongly.** Agents picked voice IDs that did not exist or did not suit the speaker, wrote directions that newer ElevenLabs models ignore, and passed `vd validate` anyway. Creators blamed the tool, because they could not read the YAML to see why.
   **Broken assumption:** valid means good, and agents follow the format guide reliably. **Covered by:** R2 (format only) and R4 (Should, Missing, deferred by decision). Plan 0009 already found that directions are dropped.

4. **"Characters" was not money.** The confirm showed a character count. Creators on different ElevenLabs plans could not turn it into money. The retakes needed to fix the acting of a 15-minute episode cost several times the first pass, and nothing showed the total.
   **Broken assumption:** seeing the plan before paying is enough cost control. **Covered by:** R7 and R8. R9 (spend so far) is only a Could, and nothing sets a budget or estimates the cost of retakes.

5. **The voices could not act.** Lines came out flat and emotion was hard to direct. The fix tools the PRD counts on (R17 to R19) were still drafts, so each fix meant a retake of unknown quality. Comparing takes was impossible, so creators lost good takes and stopped trusting regeneration.
   **Broken assumption:** a quick retake fixes most problems. **Covered by:** R16 only. R17 to R19 are Should and Missing, yet they are the heart of story 5 and the "under a minute" success measure.

6. **The phone review broke on the train.** The PC had to stay awake with `vd serve` running. Tunnels dropped, and iOS Safari paused audio when the screen locked. The phone checklist had never been run on a real phone. Reviews went back to the desk, which removed the main reason to use the tool.
   **Broken assumption:** review happens on a phone, and the PC is reachable. **Covered by:** R10 and a constraint, but no requirement covers lock-screen or background playback, offline listening, or the PC being off.

7. **Two places, no thread.** Creators heard a problem on the phone but could only fix it at the terminal later. By then they had forgotten what was wrong, because notes (R14) were missing and the UI could not hand work to an agent. Switching between the agent and the UI felt like using two products.
   **Broken assumption:** users accept the agent and UI split. **Covered by:** the design principle and a listed risk. R14 is only a Could, and R18 is Missing.

8. **A real episode did not scale.** A 15-minute episode had 300 or more items. The UI list was slow on a phone, rendering took long with no progress shown, and one failed generation in the middle left a half-paid run that was hard to resume.
   **Broken assumption:** what works for a short test works for a full episode. **Covered by:** nothing. No requirement or success measure names an episode length or item count.

9. **The vendor moved.** ElevenLabs changed its models, its prices, and its voice-library terms. Cached voices could no longer be matched for new lines, the cache key changed, and some voices' commercial terms changed after publication.
   **Broken assumption:** one vendor stays stable. **Covered by:** a listed risk only. Nothing requires a second provider, a pinned model, or a check of voice terms at publish time.

10. **Licenses became homework.** Every imported sound started unverified, and checking each one at the PC felt like paperwork. Creators either published without verifying or stopped using the library.
    **Broken assumption:** creators will verify licenses one by one. **Covered by:** R26 and R27. They enforce the gate but do nothing to make verifying quick, such as a batch view on the phone.

## Findings

| ID | Severity | Finding | Affects | Suggestion |
|---|---|---|---|---|
| PM1 | High | The free draft cannot be judged as drama. | R6, Success 1 | Add a requirement for an intelligible low-cost or free draft, such as a local TTS or a cheap model tier, or reword success measure 1. |
| PM2 | High | The paid path and the phone path have never been tested for real. | R7, R10, Today column | Mark R7 and R10 "Partial until verified". Add a success measure: one full real episode was made end to end. |
| PM3 | High | Fixing acting depends on Missing Should items. | R17–R19, Success 2 | Raise R17 and R19 to Must, because the success measures need them. |
| PM4 | High | Setup excludes the target creator. | R5 | Add an assumption with a date for packaging, such as `npx` or an installer. Measure setup with someone other than the owner. |
| PM5 | Medium | Cost is shown in characters, with no total and no budget. | R7, R9 | Show cost in money against the user's plan. Raise R9 to Should and add an optional budget per drama. |
| PM6 | Medium | Nothing addresses the scale of a real episode. | R10, R13, R28 | Add an acceptance condition for a 20-minute episode with 300 items, covering UI speed, resumable generation, and render progress. |
| PM7 | Medium | Phone review needs the PC, a tunnel, and a screen that stays on. | R10, constraints | Add background playback and a downloadable review copy for offline listening. Name "PC asleep" as a risk. |
| PM8 | Medium | Feedback from the phone does not reach the agent. | R14, R18 | Raise R14 to Should, so that a note from the phone becomes the agent's to-do list. |
| PM9 | Medium | Agent output quality is unmeasured beyond the format. | R2, R4 | Add a check that voice IDs exist and that directions work on the chosen model. Revisit the R4 decision for non-developers. |
| PM10 | Low | One vendor, and voice terms can change after publication. | Risks, R27 | Pin the model per project, and record the voice terms at render time in the credits. |
| PM11 | Low | Verifying licenses is slow, one entry at a time. | R26 | Add a requirement for a batch verification view, still done only by a human. |
| PM12 | Medium | No success measure tracks the users the product should grow toward. | Success | Add: a non-programming creator finishes and publishes an episode without help. |

## Top three risks

1. The free draft is not listenable as a drama, so every real judgement costs money (PM1).
2. The paid path, the phone path, and a full-length episode have never been tested for real, yet the PRD marks them Built (PM2, PM6).
3. Setup and the agent/UI split keep out the very creators the product is meant to grow toward (PM4, PM8).

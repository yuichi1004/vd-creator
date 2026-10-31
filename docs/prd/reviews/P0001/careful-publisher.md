# Table read: the careful publisher

The PRD takes sound licenses seriously, and the product backs that with evidence, human-only verification, and a check that blocks the render. But voices are cleared only per vendor, still images are not tracked at all, and nothing makes me state how I will publish before I render. I could upload a monetized video that passed every check and still break someone's terms.

## Journey

1. **I want to publish episode 3 on YouTube with ads.** The agent has generated everything with ElevenLabs, and the drama plays well in the review UI.
2. **I state how I will publish.** I find out that I have to know to add `publish: { use: commercial }` to the scenario. The default is `private`, under which unverified and unknown licenses are only warnings.
   **Friction:** nothing asks me. If I forget, `vd render` passes quietly and the output does not say it was checked for private use only (R27). I expected the render to ask, or at least print the use it checked against.
3. **I check the voices.** `vd validate` reports the provider `elevenlabs` as "commercial use conditional" until I set `approvedFor: commercial` on `generated-elevenlabs` in `licenses.yaml`.
   **Friction:** that one approval covers every voice from that vendor, past and future. Two speakers use shared-library voices and one is a clone of a friend's voice, each with its own terms or consent, but a speaker holds only a `voiceId`. The terms also depend on my plan *when each line was generated*, which is not recorded.
4. **I check the sounds.** The license check flags two unverified library entries. I open them in the UI's library panel, read the saved evidence, and verify them. This part works well (R22, R26).
5. **I check the still images.** The episode has six images: two I drew, three from a stock site, and one an agent found.
   **Friction:** images have only `id` and `file`: no source, license, or evidence, and no check. R27 says "every sound and voice", and plan 0007 put images off to a later plan. A video is made of its images, so this is the same risk as the sounds.
6. **I wonder if anything changed since import.** Last month I corrected a BGM record in the library that turned out to be non-commercial.
   **Friction:** the project keeps a frozen copy of the record, so validate and render pass under the old terms. Only `vd library status` shows the change, if I think to run it. I expected the render to warn.
7. **I render.** `vd render --video --srt` writes `drama.mp4`, `drama.srt`, and `credits.txt`.
8. **I do the final check before upload.** I want one page listing every voice, sound, and image, with its license, who verified it and when, and the use it was checked against.
   **Friction:** there is no such report. `credits.txt` has attribution lines and "Generated with: elevenlabs", but no voice per speaker, although R29 says "every voice and sound". The site's AI-content disclosure is left to me.
9. **I upload, paste the credits, and the video is live.**
   **Friction:** nothing records what I published under which terms. If a site changes a license next year, I cannot find the episodes that used the sound.

## Findings

| ID | Severity | Finding | Affects | Suggestion |
|---|---|---|---|---|
| CP1 | High | Still images have no source, license, or evidence, and are not checked, yet the product's main output is a video of images. | R3, R27, missing requirement | Add a Must requirement: images carry source and license like library entries, and the license check covers them. Record it as known Missing until then. |
| CP2 | High | Voices are cleared per provider, not per voice. Shared-library voices, cloned voices (consent), and the vendor plan at generation time are not recorded. | R27, R29, R4 | Add a requirement for a per-speaker voice rights record (voice type, owner or consent, terms), and record the plan or terms version with each generated asset. |
| CP3 | High | The default `publish.use: private` lets a render pass with unknown licenses, and nothing asks for or shows the intended use. The Success line "no published drama has a sound whose license is unknown" is not enforced. | R27, Success | Make the render show the use it checked against, and require an explicit `publish.use` before a video render. Change R27's acceptance to match. |
| CP4 | Medium | A changed library license does not reach projects that copied it; validate and render use the frozen copy silently. | R27, R22 | Acceptance: when a used entry's record changed, validate warns and a non-private render stops until the user syncs or confirms. |
| CP5 | Medium | No pre-upload rights report listing every asset with license, verifier, date, and the use checked. | missing requirement | Should: a rights manifest next to `credits.txt`. |
| CP6 | Medium | R29 is marked Built, but the credits list neither voices by speaker nor images, and show raw provider IDs. | R29 | Mark it Partial, or narrow the acceptance to what is built. |
| CP7 | Medium | No record of what was published, so later license changes cannot be traced to live episodes. | missing requirement | Could: record each published render (date, use, credits snapshot) and find the projects that use an entry. |
| CP8 | Low | `commercial` is one value. Platform terms, Content ID music, and AI-content disclosure are not covered. | R27 | Note in Assumptions and risks; consider a disclosure line in the credits template. |

## Biggest friction

"Every check passed and I still can't tell you who owns the cloned voice or where the cover image came from, and that is exactly what gets a monetized video taken down."

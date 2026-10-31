# 0012: Library screen

- Status: Draft
- Date: 2026-10-31
- Depends on: [0005](0005-review-ui.md), [0007](0007-sound-library.md), [0010](0010-settings-and-playback-speed.md), [0011](0011-project-picker.md)

## Background

The shared sound library (0007) holds SFX and BGM that earlier projects made or imported. Today the UI reaches it only through the library panel of 0005, which opens from one SFX or BGM item and searches by words. To find a good sound, the user must already know words that match it. There is no way to browse what is there, or to add a sound that the current project generated, except `vd library promote` in a terminal. Users want to pick earlier sounds easily.

## Goals / Non-goals

Goals:

- A library screen to browse the whole library: by kind, by tag, and by words, with a preview of each sound.
- Use a library sound for an SFX or BGM of the open project from that screen, choosing the item there.
- Add a sound that the open project generated to the library from the UI, with its license, the same as `vd library promote`.
- Show where an entry is used in the open project, and its license and verified state, as the panel does today.

Non-goals:

- Importing files from outside sources in the UI. `vd library import` with its evidence stays the way in (0007).
- Editing or deleting library entries in the UI.
- Showing which other projects use an entry. That needs reading every project, so it waits for real need.
- Changing the library format of 0007. This plan reads and writes entries as they are.
- Changing the library panel of 0005. It stays for a quick pick from one item.

## Design

### Screen

The library screen has two routes:

- `#/library`: browse only. It opens from the header in single-project mode and from the project picker (0011) in projects mode.
- `#/p/<name>/library` in projects mode, or `#/library` in single-project mode: browse with a project open, which adds "Use in this project" and the usage of each entry.

The header of the review screen and the project picker get a "Library" button when the server knows a library. Without a library, the button is hidden, as the panel is today.

Layout:

- Tabs for SFX and BGM, a search box, and a row of tag chips. The chips are the tags used by entries of that kind, most used first. Tapping chips narrows the list to entries with all chosen tags.
- A list of entries. Each row shows the title, the duration, a loop mark for loopable BGM, the license name, and an "unverified" badge when the entry is not verified. A play button previews the sound, and only one preview plays at a time.
- Sort by title, by duration, or by date, newest first by default. The date is the one the entry already records: `generatedAt` for a promoted sound and `retrievedAt` for an imported one. Entries without either sort last.
- Tapping a row opens the detail: tags, notes, source and attribution, the license record, and the items of the open project that use it. "Verify" opens the verify flow of 0005 unchanged.
- On a phone, the list is one column and the detail is a full-screen sheet. On PC, the detail is a side panel.

### Using a sound

"Use in this project" on an entry opens a list of the items it can fill: SFX items for an SFX entry, and scenes for a BGM entry. Each shows its scene, its ID, and its current source (a prompt, or another library entry). Choosing one sends the same call as the panel: `PATCH <project>/api/items/:id` with `source: { library: <id> }` for an SFX, or `PATCH <project>/api/scenes/:id` with `bgm: { library: <id> }` for a scene. The screen then shows the review screen at that item.

### Adding a generated sound

On the review screen, an SFX or BGM item that has generated audio gets "Add to library". It opens a form:

- ID: prefilled from the item ID, editable, checked against the ID rule of 0007.
- Title and tags: prefilled from the prompt, editable.
- License: chosen from the licenses in the library's `licenses.yaml`. The form preselects the provider's own license, `generated-<providerId>` (0007), when the project's `credits.json` records the provider and that license is in the registry. Otherwise nothing is selected, and the user must choose. The form never guesses a license.

Saving runs the same code as `vd library promote`. Today the part that finds the item's generated asset and its generation record lives in the CLI (`apps/cli/src/library.ts`). The first task moves it into `packages/core`, so that the CLI and the server share it. The new entry starts unverified, as every promoted entry does (0007). After saving, the form offers to verify it now, through the verify flow.

### API additions

| Method and path | Purpose |
|---|---|
| `GET /api/library/tags?kind=<kind>` | Tags of that kind with their counts. 404 without a library. |
| `GET /api/library/licenses` | IDs and names of the licenses in `licenses.yaml`, for the form. 404 without a library. |
| `GET /api/library` | Gains `sort` (`title`, `duration`, `date`) and `tags` (comma separated) in the query. Existing queries work as before. |
| `POST <project>/api/library/promote` | Body `{ item: string, id: string, license: string, title?: string, tags?: string[] }`. Promotes the item's generated audio and returns the new entry. 409 with the new code `conflict` when the ID exists. 400 `bad-request` with fixed text when the license is not in the registry, the item is not a generated SFX or BGM, or it has no audio. Runs in the server-wide library queue (0011). |

`<project>` is the per-project base of 0011: the root in single-project mode, `/p/<name>/` in projects mode. `LibraryEntryInfo` gains `date`, from the fields above.

## Tasks

Run in order. The server task's first review uses Codex `gpt-6.1-sol`, because promote writes into the shared library from a request. The other tasks use a Claude reviewer.

- [ ] Promote in core
  - Target: `apps/cli/src/library.ts`, `packages/core/src/library/`
  - Change: move the code that finds an item's generated asset and generation record for promote from the CLI into a core function, and make `vd library promote` call it. Behaviour does not change.
  - Constraints: no new dependencies. No change to the library format or to `promoteEntry`.
  - Ownership: `apps/cli/src/library.ts`, its tests, and `packages/core/src/library/`.
  - Acceptance: the standard acceptance chain passes, and the existing `vd library promote` tests pass unchanged.
- [ ] Library API additions
  - Target: `apps/server/`, `packages/library/src/` if a helper for tags is missing
  - Change: the routes and query fields above, the `conflict` error code, and `date` in `LibraryEntryInfo`, with types in `api.ts`. Update the API table of 0005 with a link to this plan.
  - Constraints: no new dependencies. Never set `verified` on promote. Never accept a license that is not in the registry. Use a temporary library in tests. Depends on the first task.
  - Ownership: `apps/server/`, `packages/library/src/`, and the API table in plan 0005.
  - Acceptance: `npm test -w apps/server && npm test -w packages/library` pass, with tests that tags count per kind, that `tags` and `sort` filter and order the list, that promote creates an unverified entry with the item's audio and generation record, that promote refuses an existing ID with 409 `conflict` and an unknown license with 400, and that a `library` item cannot be promoted.
- [ ] Library screen
  - Target: `apps/web/src/`
  - Change: the routes, the header and picker buttons, the screen with tabs, search, tag chips, sort, preview, detail, "Use in this project", and "Add to library" with its form.
  - Constraints: no new dependencies. Keep `LibraryPanel` working. The phone rules of 0005 apply. Depends on the second task.
  - Ownership: `apps/web/src/`.
  - Acceptance: `npm run build -w apps/web && npm test -w apps/web` pass, with tests that the chips narrow the list to entries with all chosen tags, that "Use in this project" offers only items of the entry's kind and sends the same PATCH as the panel, that browse-only mode has no "Use in this project", and that the promote form has no license selected when the project records none. Before the plan is closed, the coordinator uses an entry for an SFX and promotes a mock SFX on a temporary library, in a browser at 1280 px and 375 px widths.

## Open questions

- Should promoted sounds keep the project's prompt in the entry's notes, so that it can be found by the words of the prompt? The default is yes, because the prompt was written for the sound.
- Should the screen let the user preview a sound in the context of a scene, mixed under its lines? Not in this plan.

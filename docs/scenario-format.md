# Scenario format

This guide is for agents that write or edit `scenario.yaml`, the source of truth for a drama. It describes schema version 1 as the code defines it: the Zod schema in [`packages/scenario/src/schema.ts`](../packages/scenario/src/schema.ts) and the ID and reference checks in [`packages/scenario/src/validate.ts`](../packages/scenario/src/validate.ts). The design behind it is in [plan 0003](plans/0003-scenario-format.md). If this guide and the code disagree, the code wins.

## Validating

Check every scenario you write before you report it as done. The `vd validate` command is not merged yet. Until it is, build with `npm run build` and call `parseScenario(text)` from `@vd-creator/scenario`. It returns `{ scenario, issues }`. `scenario` is set only when there are no errors. Each issue has a `path` such as `["scenes", 0, "items", 2, "id"]`, a `message`, and a `severity` of `error` or `warning`. Only errors make a scenario invalid. Fix warnings too, but they do not block it.

Editors can also use the JSON Schema at [`packages/scenario/schema/scenario.schema.json`](../packages/scenario/schema/scenario.schema.json). It checks types and shapes only. It does not check that IDs are unique or that references resolve, so a file that passes the JSON Schema can still fail `parseScenario`. To make YAML editors pick the schema up, add a comment as the first line, with a path relative to the scenario file:

```yaml
# yaml-language-server: $schema=<path to>/scenario.schema.json
```

## Full example

This example passes validation and uses every field.

```yaml
version: 1
title: The Lighthouse Keeper
publish:
  use: private
speakers:
  - id: mira
    name: Mira
    voice:
      provider: elevenlabs
      voiceId: 21m00Tcm4TlvDq8ikWAM
      settings: { stability: 0.4, similarity: 0.8 } # Passed to the provider as is
  - id: keeper
    name: The Keeper
    voice:
      provider: mock
      voiceId: old-man
images:
  - id: shore
    file: images/shore.png # Relative to assets/
  - id: lamp-room
    file: images/lamp-room.png
scenes:
  - id: s1
    title: Arrival
    bgm:
      prompt: "quiet piano, rain"
      volume: 0.3
    items:
      - image: shore
      - sfx: "waves on rocks" # A string is a prompt: the sound is generated
        id: s1-waves
        durationSec: 4
        overlap: true # Plays under the next items
      - sfx: { library: door-creak-wood-01 } # An entry in the shared sound library
        id: s1-door
      - line: "Is anyone up there?"
        id: s1-l1
        speaker: mira
        direction: "shouting against the wind" # TODO: less shouty?
      - pause: 1.5
      - line: "Hello? Mister Abel?"
        id: s1-l2
        speaker: mira
        take: 2
        gapBeforeSec: 0.2

  # The keeper answers.
  - id: s2
    title: The Lamp Room
    bgm:
      library: ambient-hum-low
    items:
      - image: lamp-room
        id: s2-img
        gapBeforeSec: 0.5
      - line: "Up here. Mind the stairs."
        id: s2-l1
        speaker: keeper
      - line: "Coming!"
        id: s2-l2
        speaker: mira
        gapBeforeSec: -0.2 # Starts 0.2 seconds before the keeper's line ends
      - sfx: "footsteps on iron stairs"
        id: s2-steps
        take: 1
        gapBeforeSec: 0.5
      - pause: 0.8
        id: s2-p1
        gapBeforeSec: 0
```

## Fields

"Required" means validation fails without the field. Every object is strict: a key that is not listed here is an error, so typos are caught. The only exception is `voice.settings`, which takes any keys.

### Top level

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `version` | the number `1` | yes | | Schema version. Write `1`, not `"1"`. |
| `title` | non-empty string | yes | | Title of the drama. |
| `publish` | object | no | `{ use: private }` | How the finished drama will be used. |
| `publish.use` | `private`, `non-commercial`, or `commercial` | no | `private` | Checked against sound licenses (plan 0007). |
| `speakers` | list of speakers | no | `[]` | Voices that lines refer to. |
| `images` | list of images | no | `[]` | Still images that image items refer to. |
| `scenes` | list of scenes | yes | | The drama, in order. The list may be empty. |

### Speaker

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | ID | yes | Referred to by the `speaker` of lines. |
| `name` | non-empty string | yes | Display name. |
| `voice.provider` | non-empty string | yes | Provider ID, such as `elevenlabs`. `mock` is always available. |
| `voice.voiceId` | non-empty string | yes | Voice ID at the provider. Not an ID in the sense of this guide, so any non-empty string is fine. |
| `voice.settings` | mapping | no | Provider-specific settings, passed through as is. |

### Image

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | ID | yes | Referred to by image items. |
| `file` | asset path | yes | Image file, relative to the project's `assets/` folder. |

An asset path is relative to `assets/` and uses `/` as the separator, as in `images/shore.png`. It must not start with `/`, contain `\` or `:`, have empty segments (`a//b`), or have `.` or `..` segments. Do not start it with `assets/`: the path is already inside that folder.

### Scene

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | ID | yes | Stable ID of the scene. |
| `title` | string | no | Display title. |
| `bgm` | BGM | no | Music that loops under the whole scene. |
| `items` | list of items | yes | What happens in the scene, in order. The list may be empty. |

A BGM has exactly one of these, plus an optional volume:

| Field | Type | Meaning |
|---|---|---|
| `prompt` | non-empty string | Prompt for generated music. |
| `library` | ID | Entry ID in the shared sound library. |
| `volume` | number from 0 to 1 | Optional. Default 0.3. |

### Items

An item is exactly one of `line`, `sfx`, `pause`, or `image`. Validation decides the kind by which of these keys the item has. Each kind accepts only the fields in its own table.

Common fields:

- `gapBeforeSec`: silence before the item, in seconds. It is optional and defaults to 0.3 for lines and 0 for every other kind. A negative value, down to -1, makes the item start before the previous one ends, as in overlapping dialogue.
- `take`: a non-negative integer, default 0, on lines and SFX only. It selects which generation of the item is used. Regenerating an item increments it. Do not change it when you only edit text.

**Line**: spoken dialogue.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `line` | non-empty string | yes | Spoken text. |
| `id` | ID | yes | Stable ID of the line. |
| `speaker` | ID | yes | ID of a speaker in `speakers`. |
| `direction` | string | no | Delivery hint for TTS and for humans. |
| `take` | integer, 0 or more | no | Default 0. |
| `gapBeforeSec` | number, -1 or more | no | Default 0.3. |

**SFX**: a sound effect.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `sfx` | non-empty string, or `{ library: <ID> }` | yes | A string is a prompt for a generated sound. `{ library: ... }` is an entry in the shared sound library. |
| `id` | ID | yes | Stable ID of the SFX. |
| `durationSec` | number above 0 | no | Requested length in seconds. |
| `overlap` | boolean | no | Default `false`. When `true`, the sound plays under the following items instead of before them. |
| `take` | integer, 0 or more | no | Default 0. |
| `gapBeforeSec` | number, -1 or more | no | Default 0. |

**Pause**: silence.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `pause` | number above 0 | yes | Length of the silence in seconds. |
| `id` | ID | no | Give one if the UI or another agent needs to refer to the pause. |
| `gapBeforeSec` | number, -1 or more | no | Default 0. |

**Image**: shows a still image from this point until the next image item.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `image` | ID | yes | ID of an image in `images`. |
| `id` | ID | no | Give one if the UI or another agent needs to refer to the item. |
| `gapBeforeSec` | number, -1 or more | no | Default 0. |

Validation checks only the shape of a library reference. Whether the library entry exists, and whether its license fits `publish.use`, is checked against the library ([plan 0007](plans/0007-sound-library.md)).

## IDs

An ID is a string that starts with a letter or digit and contains only ASCII letters, digits, `-`, and `_`. The same rule applies to speaker IDs, image IDs, scene and item IDs, the `speaker` and `image` references, and library entry IDs.

- **Required**: every speaker, image, scene, line, and SFX has an `id`. Pauses and image items may have one.
- **Unique**: scenes and items share one namespace across the whole file. A line in scene `s2` cannot reuse an ID from scene `s1`, and an item cannot reuse a scene's ID. Speaker IDs must be unique among speakers, and image IDs among images. These are separate namespaces, but avoid reusing the same string anyway.
- **Resolved**: the `speaker` of a line must be a speaker's `id`, not its `name`. The `image` of an image item must be an image's `id`.
- **Stable**: the UI, the cache of generated audio, and other agents refer to items by ID. Keep an ID when you change the text, direction, or timing of its item. Give an item a new ID only when it is really a new item.
- **Short slugs**: use short, readable slugs such as `s1`, `s1-l3`, or `s2-rain`. A scene prefix makes IDs easy to keep unique. The ID does not have to stay in step with the item's position, so you do not need to renumber when you insert an item: `s1-l2b` is fine.

## Editing an existing scenario

Humans annotate drafts with comments, such as `# TODO: shorter?`. Keep every comment you did not mean to change, and change only the lines you need to. Do not regenerate the whole file from data.

Programs change items with `updateItem` from `@vd-creator/scenario`, which is also what the UI uses. It edits the YAML source in place and keeps comments and formatting. It supports the forms people usually write: block and flow mappings, comments anywhere, quoted and block scalars, trailing commas, closing braces on their own line, and empty values. It refuses the edit, and leaves the file unchanged, in these cases:

- The item, its scene, its scene's item list, or the whole `scenes` list is defined by a YAML alias (`*name`).
- The item, or a field the edit changes, has an explicit tag such as `!!str` or `!!map`.
- A field the edit changes has an anchor or tag on the line after its key.
- An alias makes a cycle, or an alias does not resolve.
- The edited item would not read back as patched. For example, the edit changes an anchored value that an alias elsewhere refers to.
- The edit removes the item's `id` or its kind key, or renames it to an ID that another scene or item already uses.
- The edit would make a valid scenario invalid.
- The file has YAML syntax errors.

So that the UI can always edit what you write, **do not use YAML anchors (`&name`), aliases (`*name`), or tags (`!!str`) in a scenario**. Repeat values instead. They are valid YAML, and validation accepts them, but the editor may refuse to change the items they touch.

## Common mistakes

- **A missing `id`** on a scene, line, or SFX.
- **A duplicate ID in another scene.** IDs are unique across the whole file, not per scene.
- **Changing an ID along with the text.** The item then loses its generated audio and its history in the UI.
- **Referring to a speaker by name**, as in `speaker: Mira` when the ID is `mira`. IDs are case-sensitive.
- **Two kind keys in one item**, such as `line` and `sfx`. Split them into two items.
- **A field on the wrong kind**, such as `overlap` on a line, `take` on a pause, or `speaker` on an SFX. Each kind accepts only its own fields.
- **Typos in keys**, such as `gap_before_sec`, `voice_id`, or `durationSecs`. Unknown keys are errors. Field names are camelCase.
- **A BGM with both `prompt` and `library`**, or with neither.
- **An SFX written as `{ prompt: ... }`.** A generated SFX is a plain string: `sfx: "waves on rocks"`.
- **Out-of-range numbers**: `gapBeforeSec` below -1, a `pause` or `durationSec` of 0, a negative or fractional `take`, or a BGM `volume` above 1.
- **An image path that starts with `./` or `/`**, or that uses `\`. Validation reports these.
- **An image path that starts with `assets/`.** Validation does not catch this one: `assets/images/shore.png` is a valid path, but it points to `assets/assets/images/shore.png`. Write the path from inside `assets/`, as in `images/shore.png`.
- **`version: "1"`** as a string. It must be the number 1.
- **An empty value**, as in `direction:` with nothing after it. YAML reads it as null, which is not a string. Leave the key out instead.
- **IDs that YAML reads as numbers**, such as `id: 01` or `id: 2`. Quote them (`id: "01"`), or better, start them with a letter.
- **Unquoted text with ` #` in it.** In YAML, a space followed by `#` starts a comment, so `line: Room #4 is empty` is read as the line `Room`. Validation does not catch this, because the shortened text is still valid. Quote any text that contains `#`: `line: "Room #4 is empty"`.
- **Unquoted text with other YAML syntax in it.** Quote lines, directions, and prompts that contain `: `, or that start with a character such as `"`, `'`, `[`, `{`, `*`, `&`, `!`, `|`, `>`, `%`, `@`, or `` ` ``. Quoting every line and prompt is the simplest habit. Inside double quotes, escape `"` and `\` with a backslash, or use single quotes and write `'` as `''`.
- **Anchors, aliases, or tags.** See the previous section.

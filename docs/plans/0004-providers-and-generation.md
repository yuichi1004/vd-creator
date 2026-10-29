# 0004: Providers and generation pipeline

- Status: In progress
- Date: 2026-10-29
- Depends on: [0003](0003-scenario-format.md)

## Background

[0002](0002-architecture.md) put every generation service behind a provider interface with a mock, and made generation content-cached. [0003](0003-scenario-format.md) defines the items to generate. This plan connects them: it finalizes the provider interfaces, builds the mock and ElevenLabs providers, the cache, the timeline, and `vd generate`.

## Goals / Non-goals

Goals:

- Finalize the provider interfaces sketched in 0002.
- A mock provider for every kind (TTS, SFX, music) that produces real, playable audio without network access.
- An ElevenLabs provider for the same three kinds.
- The content cache (`cache.json`) and the asset layout under `assets/`.
- Timeline computation: the start time and duration of every item, used by the UI (0005) and the renderer (0006).
- `vd generate`, with a dry run that reports the cost before any paid call.

Non-goals:

- Other providers. The interfaces allow them later.
- Library sounds and imported audio. [0007](0007-sound-library.md) adds them through the resolver hook below.
- Any UI. It belongs to 0005.

## Design

### Provider interfaces (final)

```ts
type AudioFormat = "mp3" | "wav";
type AudioResult = { data: Uint8Array; format: AudioFormat; durationSec: number; meta: Record<string, unknown> };
type Cost = { characters: number; requests: number };

interface Provider {
  readonly id: string;               // "mock", "elevenlabs"
  readonly paid: boolean;            // true means real money per call
}
interface TtsProvider extends Provider {
  synthesize(req: TtsRequest): Promise<AudioResult>;
  estimate(req: TtsRequest): Cost;
}
interface SfxProvider extends Provider { generate(req: SfxRequest): Promise<AudioResult>; estimate(req: SfxRequest): Cost; }
interface MusicProvider extends Provider { generate(req: MusicRequest): Promise<AudioResult>; estimate(req: MusicRequest): Cost; }

type TtsRequest = { text: string; voiceId: string; direction?: string; settings?: Record<string, unknown>; take: number };
type SfxRequest = { prompt: string; durationSec?: number; take: number };
type MusicRequest = { prompt: string; durationSec: number; take: number };
```

Changes from the 0002 sketch: `paid` and `estimate` support the cost gate, `take` is part of every request so that regenerating gives a new cache key, and `direction` carries the line's stage direction. After this plan is accepted, changing these needs a decision gate.

### Mock provider

The mock writes WAV files in code, with no dependency: a short tone pattern whose length follows the text (about 15 characters per second for TTS) or the requested duration. Different `take` values give audibly different pitches, so that a human can hear that regeneration worked. It is deterministic, so tests can compare bytes. It is the default provider everywhere.

### ElevenLabs provider

It calls the ElevenLabs REST API with the built-in `fetch`, not the SDK. This avoids a dependency, and three endpoints are easy to cover directly: text-to-speech, sound generation, and music. The API key comes from `ELEVENLABS_API_KEY`. Tests replace `fetch` and never call the real API. The first real call happens only after a decision gate that states the expected number of characters.

### Cache and assets

- The cache key is the SHA-256 of a canonical JSON of `{ kind, providerId, request }`, where `request` includes `take`.
- The asset file is `assets/<voice|sfx|bgm>/<key prefix>.<format>`, using the first 16 hex characters of the key.
- `cache.json` maps keys to `{ file, kind, providerId, request, durationSec, createdAt }`, with `version: 1` at the top. `file` is relative to `assets/`. (`kind` was added during implementation, so that an entry can be read without its key.)
- Changing a line's text, voice, settings, or take changes the key, so only that item is regenerated. Old assets stay until `vd clean` removes unreferenced ones.

### Asset resolvers

The pipeline asks a list of resolvers for each item's asset. This plan ships one resolver, for generated items. An item that no resolver handles, such as `sfx: { library: ... }` before 0007 is done, is reported as `unresolved` in the plan and the timeline, not as an error and not as a generation request. 0007 adds the library resolver without changing the pipeline.

An item whose request cannot be written as canonical JSON, such as provider `settings` holding `.inf` or a cyclic alias, is `invalid`: it has no cost, is never generated, fails alone in a run, and its reason names only its kind and ID. Every other item still plans, generates, and plays. (`invalid` was added during implementation.)

```ts
interface AssetResolver {
  handles(item: ScenarioItem): boolean;
  plan(item: ScenarioItem, ctx: ResolveContext): Promise<PlannedAsset>;   // cached | to-generate | unresolved | invalid, with cost
  resolve(item: ScenarioItem, ctx: ResolveContext): Promise<ResolvedAsset>;
}
```

### Timeline

`computeTimeline(scenario, cache, resolvers)` is async and returns, for each item, `{ id, kind, startSec, durationSec, assetFile? }`, plus image spans and BGM spans per scene. It finds assets through the same resolver list as `planGeneration`. Items play in order, separated by `gapBeforeSec`. An SFX with `overlap: true` does not push the next item. Items without an asset yet, including `unresolved` and `invalid` ones, get an estimated duration and `missing: true` (and `invalid: true` for an invalid item), so that the UI can still show a layout. A cache entry whose file is missing counts as no asset.

An image takes no time and never moves the audio. Its span starts at its own position, but never before the previous image's start. A span of zero length is dropped. With a negative gap, the next audio item can start before the image appears.

`planGeneration` counts an item as cached only for the chosen provider, so that `vd generate --provider X` makes assets from X. The timeline, and anything else that plays an asset, uses the newest asset for the item's current request from any provider. So a project generated with ElevenLabs plays and renders without a `--provider` flag.

### `vd generate`

```
vd generate [dir] [--provider mock|elevenlabs] [--only <id,...>] [--dry-run] [--yes]
```

- The provider defaults to `mock`, even if a speaker names another provider in the scenario. Real providers run only with `--provider`.
- It first prints the plan: items to generate, items already cached, unresolved and invalid items, and the estimated characters and requests.
- With a paid provider, it stops after the plan unless `--yes` is given. `--dry-run` always stops after the plan.
- At most 4 requests run at once. Each asset is written as soon as it is ready, so an interrupted run keeps its progress.

## Tasks

The interfaces task is reviewed with `gpt-6-astra`, because it fixes a public interface. The others use the default reviewer.

- [x] Provider interfaces and mock
  - Target: `packages/providers/`
  - Change: the interfaces above, the mock TTS, SFX, and music providers, a WAV encoder, and `createProviders(id)` that returns the three providers for an ID (only `mock` in this task).
  - Constraints: no new dependencies. No network access.
  - Ownership: `packages/providers/` except `src/elevenlabs/`.
  - Acceptance: `npm test -w packages/providers` passes, including: mock output is a valid WAV whose header duration matches `durationSec`, output is deterministic, and different takes give different bytes.
- [x] ElevenLabs provider
  - Target: `packages/providers/src/elevenlabs/`
  - Change: TTS, SFX, and music providers over the REST API with `fetch`, with `paid: true`, `estimate`, and error messages that name the failing item. Register it in `createProviders` through a single exported function that the interfaces task leaves a hook for.
  - Constraints: no new dependencies. Never call the real API. Tests stub `fetch`. Depends on the interfaces task.
  - Ownership: `packages/providers/src/elevenlabs/`, and the one registration line in `packages/providers/src/index.ts`.
  - Acceptance: `npm test -w packages/providers` passes, with tests for the request body, headers (key from the environment), and error handling, all against a stubbed `fetch`.
- [ ] Cache, generation pipeline, and timeline
  - Target: `packages/core/`
  - Change: the cache, the `AssetResolver` hook with the generated-item resolver, `planGeneration(scenario, cache, resolvers)` (items with cached, to-generate, unresolved, or invalid status and a cost total), `runGeneration` (concurrency 4, writes assets as they finish), and `computeTimeline`.
  - Constraints: no new dependencies. Uses only the mock provider in tests. Depends on the interfaces task. Can run in parallel with the ElevenLabs task.
  - Ownership: `packages/core/`.
  - Acceptance: `npm test -w packages/core` passes, including: generating the 0003 sample twice makes no provider calls the second time, changing one line regenerates only that line, and timeline start times follow the gap and overlap rules.
- [ ] `vd generate` and `vd clean`
  - Target: `apps/cli/`
  - Change: the commands described above.
  - Constraints: no new dependencies. Depends on the core task.
  - Ownership: `apps/cli/`.
  - Acceptance: `npm test -w apps/cli` passes, with a test that runs `init`, then `generate` with the mock, and checks `cache.json` and the asset files. A test checks that `--provider elevenlabs` without `--yes` makes no request.

## Open questions

- Should the cost gate in `vd generate` also enforce a per-run character limit from an environment variable? The default is no limit beyond `--yes`.
- `Cost` counts characters and requests, but ElevenLabs bills SFX and music by duration or generation, not by prompt characters. For now their `estimate` reports 0 characters and 1 request, so the gate shows them only as a request count. Should `Cost` gain a field such as `seconds`, so the gate can show their real size? That changes a public interface and needs a decision gate.
- Should a line's `direction` be sent to ElevenLabs, for example as a voice-design prompt, or used only by humans? The default is that it is sent only when the model supports it.

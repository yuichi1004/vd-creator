# Providers

vd generates audio through providers. The `mock` provider is free and makes test tones. The `elevenlabs` provider calls the ElevenLabs API, and each call costs real money. The code is in [`packages/providers/`](../packages/providers/).

## Live ElevenLabs check

The unit tests never call the real API. One extra test, `packages/providers/src/elevenlabs/live.test.ts`, does: it checks that the request shapes in `api.ts` still work against the live service. It is skipped unless all three of these are set, so `npm test` skips it unless you set them all:

- `VD_LIVE_ELEVENLABS=1`
- `ELEVENLABS_API_KEY`: your API key.
- `VD_LIVE_ELEVENLABS_VOICE`: the ID of a voice in your ElevenLabs account.

Two more are optional:

- `VD_LIVE_ELEVENLABS_MODEL`: the TTS model. The default is `eleven_multilingual_v2`.
- `VD_LIVE_ELEVENLABS_OUT`: a file path. The test saves the MP3 there so that you can listen to it. It must name a file, so it must not end in `/`. Its folder must exist and be writable, and nothing may be at the path yet, not even a symbolic link that points nowhere, so nothing is overwritten. The test checks all of this before the paid call. A relative path is resolved from `packages/providers`.

### What it calls

One request to `POST /v1/text-to-speech/{voice_id}` with the line "Is anyone there? Hello?" and the direction `whispers`. Models that read audio tags (`eleven_v3` and `eleven_v4`, listed in `ELEVENLABS_AUDIO_TAG_MODELS` in `api.ts`) get the direction as a tag, `[whispers] Is anyone there? Hello?`. Other models get the line only.

That is 23 characters with `eleven_multilingual_v2` and 34 with a model that reads audio tags, so each run sends under 50 characters. The test checks the estimate before it calls the API and fails without a call if the estimate is 50 or more.

The test then checks that the result is MP3, that it lasts between 0.5 and 10 seconds, that ffmpeg decodes it to the same length, and that it is not silent. On success it prints the model, the characters sent, and the duration. It never prints the API key or the voice ID. Any failure is reported with a fixed message: the step that failed, plus an error code or HTTP status from a fixed list. It never shows a path, a provider message, or ffmpeg's output. The test is never retried or repeated, even with Vitest's `--retry` or `--repeats`, so a run makes at most one paid call.

The same file has offline tests of those failure messages, which use a made-up key and voice ID. They run with every `npm test`.

### How to run it

Run it by hand, from the repository root, after `scripts/setup.sh && npm run build`. It takes two steps.

First, enter the key. Run this line on its own, and wait for the prompt before you type or paste the key:

```sh
read -rsp "ElevenLabs API key: " ELEVENLABS_API_KEY && echo && export ELEVENLABS_API_KEY
```

`read -rsp` shows the prompt and does not echo the key, so the key does not appear on the screen or land in your shell history. Do not paste this line together with the commands that follow it. If you do, `read` takes the next pasted line as the key, and the key you type afterwards runs as a command: it is echoed and saved in your shell history.

Then run the test, and unset the key at the end:

```sh
VD_LIVE_ELEVENLABS=1 VD_LIVE_ELEVENLABS_VOICE=<voice-id> \
  npm test -w packages/providers -- src/elevenlabs/live.test.ts
unset ELEVENLABS_API_KEY
```

To check whether `eleven_v4` reads the audio tag, enter the key as in the first step, then run it with that model, save the audio, and listen. The line should be whispered, and the word "whispers" should not be spoken. Pick a save path in a writable folder where no file exists yet:

```sh
VD_LIVE_ELEVENLABS=1 VD_LIVE_ELEVENLABS_VOICE=<voice-id> \
  VD_LIVE_ELEVENLABS_MODEL=eleven_v4 VD_LIVE_ELEVENLABS_OUT=/tmp/vd-live-v4.mp3 \
  npm test -w packages/providers -- src/elevenlabs/live.test.ts
unset ELEVENLABS_API_KEY
```

If it is spoken aloud, remove `eleven_v4` from `ELEVENLABS_AUDIO_TAG_MODELS`.

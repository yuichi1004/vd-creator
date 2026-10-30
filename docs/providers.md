# Providers

vd generates audio through providers. The `mock` provider is free and makes test tones. The `elevenlabs` provider calls the ElevenLabs API, and each call costs real money. The code is in [`packages/providers/`](../packages/providers/).

## Live ElevenLabs check

The unit tests never call the real API. One extra test, `packages/providers/src/elevenlabs/live.test.ts`, does: it checks that the request shapes in `api.ts` still work against the live service. It is skipped unless all three of these are set, so `npm test` always skips it:

- `VD_LIVE_ELEVENLABS=1`
- `ELEVENLABS_API_KEY`: your API key.
- `VD_LIVE_ELEVENLABS_VOICE`: the ID of a voice in your ElevenLabs account.

Two more are optional:

- `VD_LIVE_ELEVENLABS_MODEL`: the TTS model. The default is `eleven_multilingual_v2`.
- `VD_LIVE_ELEVENLABS_OUT`: a file path. The test saves the MP3 there so that you can listen to it.

### What it calls

One request to `POST /v1/text-to-speech/{voice_id}` with the line "Is anyone there? Hello?" and the direction `whispers`. Models that read audio tags (`eleven_v3` and `eleven_v4`, listed in `ELEVENLABS_AUDIO_TAG_MODELS` in `api.ts`) get the direction as a tag, `[whispers] Is anyone there? Hello?`. Other models get the line only.

That is 23 characters with `eleven_multilingual_v2` and 34 with a model that reads audio tags, so each run sends under 50 characters. The test checks the estimate before it calls the API and fails without a call if the estimate is 50 or more.

The test then checks that the result is MP3, that it lasts between 0.5 and 10 seconds, that ffmpeg decodes it to the same length, and that it is not silent. On success it prints the model, the characters sent, and the duration. It never prints the API key or the voice ID; a failed call is reported with its error code and HTTP status only.

### How to run it

Run it by hand, from the repository root, after `scripts/setup.sh && npm run build`. Read the key with `read -s` so that it does not land in your shell history:

```sh
read -rs ELEVENLABS_API_KEY && export ELEVENLABS_API_KEY
VD_LIVE_ELEVENLABS=1 VD_LIVE_ELEVENLABS_VOICE=<voice-id> \
  npm test -w packages/providers -- src/elevenlabs/live.test.ts
unset ELEVENLABS_API_KEY
```

To check whether `eleven_v4` reads the audio tag, run it with that model, save the audio, and listen. The line should be whispered, and the word "whispers" should not be spoken:

```sh
VD_LIVE_ELEVENLABS=1 VD_LIVE_ELEVENLABS_VOICE=<voice-id> \
  VD_LIVE_ELEVENLABS_MODEL=eleven_v4 VD_LIVE_ELEVENLABS_OUT=/tmp/vd-live-v4.mp3 \
  npm test -w packages/providers -- src/elevenlabs/live.test.ts
```

If it is spoken aloud, remove `eleven_v4` from `ELEVENLABS_AUDIO_TAG_MODELS`.

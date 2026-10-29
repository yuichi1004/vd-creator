// Provider interfaces with mock and ElevenLabs implementations.
//
// Each provider module, such as ./mock.js, calls registerProviders() for its ID when it loads.
// Adding a provider to createProviders() takes one line here: an export of its module.

export * from "./elevenlabs/index.js";
export * from "./mock.js";
export * from "./registry.js";
export type * from "./types.js";
export * from "./wav.js";

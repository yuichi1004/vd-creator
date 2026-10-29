// Provider registry. createProviders(id) returns the providers registered for an ID.

import type { ProviderSet } from "./types.js";

export type ProviderFactory = () => ProviderSet;

const factories = new Map<string, ProviderFactory>();

/**
 * Registers the providers for an ID. Each provider module calls this once, and src/index.ts
 * imports the module so that the registration runs.
 */
export function registerProviders(id: string, factory: ProviderFactory): void {
  if (factories.has(id)) {
    throw new Error(`Providers are already registered for "${id}"`);
  }
  factories.set(id, factory);
}

/** The registered provider IDs, in registration order. */
export function providerIds(): string[] {
  return [...factories.keys()];
}

/** Returns the TTS, SFX, and music providers for an ID. Throws for an unknown ID. */
export function createProviders(id: string): ProviderSet {
  const factory = factories.get(id);
  if (!factory) {
    throw new Error(`Unknown provider "${id}". Known providers: ${providerIds().join(", ")}`);
  }
  return factory();
}

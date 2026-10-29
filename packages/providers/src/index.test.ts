import { expect, test } from "vitest";
import {
  createProviders,
  MockMusicProvider,
  MockSfxProvider,
  MockTtsProvider,
  type ProviderSet,
  providerIds,
  registerProviders,
} from "./index.js";

test("registers the mock provider", () => {
  expect(providerIds()).toContain("mock");
});

test("createProviders returns the three mock providers", () => {
  const providers = createProviders("mock");
  expect(providers.tts).toBeInstanceOf(MockTtsProvider);
  expect(providers.sfx).toBeInstanceOf(MockSfxProvider);
  expect(providers.music).toBeInstanceOf(MockMusicProvider);
});

test("createProviders rejects an unknown ID and lists the known ones", () => {
  expect(() => createProviders("nope")).toThrow(/Unknown provider "nope".*mock/);
});

test("registerProviders adds an ID and rejects a duplicate", () => {
  const set: ProviderSet = createProviders("mock");
  registerProviders("test-registry", () => set);
  expect(createProviders("test-registry")).toBe(set);
  expect(() => registerProviders("test-registry", () => set)).toThrow(/already registered/);
  expect(() => registerProviders("mock", () => set)).toThrow(/already registered/);
});

import { describe, expect, test } from "vitest";
import {
  DEFAULT_SETTINGS,
  formatSpeed,
  loadSettings,
  normalizeSpeed,
  SETTINGS_KEY,
  type StorageLike,
  saveSettings,
} from "./settings.js";

function memoryStorage(initial?: string): StorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(SETTINGS_KEY, initial);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

const throwing: StorageLike = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("loading", () => {
  test("defaults when nothing is saved or storage is missing", () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  test("defaults when storage throws", () => {
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS);
  });

  test("defaults when the value is not valid JSON or not an object", () => {
    expect(loadSettings(memoryStorage("{nope"))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memoryStorage("42"))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memoryStorage("null"))).toEqual(DEFAULT_SETTINGS);
  });

  test("defaults when the version is unknown", () => {
    expect(loadSettings(memoryStorage(JSON.stringify({ version: 99, speed: 2 })))).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  test("bad fields fall back one by one", () => {
    const stored = JSON.stringify({ version: 1, speed: "fast", keepPitch: false });
    expect(loadSettings(memoryStorage(stored))).toEqual({ speed: 1, keepPitch: false });
  });
});

describe("saving", () => {
  test("a saved speed is read back", () => {
    const storage = memoryStorage();
    expect(saveSettings({ speed: 1.25, keepPitch: false }, storage)).toBe(true);
    expect(loadSettings(storage)).toEqual({ speed: 1.25, keepPitch: false });
  });

  test("the saved JSON has a version under one key", () => {
    const storage = memoryStorage();
    saveSettings({ speed: 0.75, keepPitch: true }, storage);
    expect(JSON.parse(storage.values.get("vd-creator.settings") ?? "")).toEqual({
      version: 1,
      speed: 0.75,
      keepPitch: true,
    });
  });

  test("a refusing or missing storage returns false and does not throw", () => {
    expect(saveSettings(DEFAULT_SETTINGS, throwing)).toBe(false);
    expect(saveSettings(DEFAULT_SETTINGS, undefined)).toBe(false);
  });
});

describe("speed", () => {
  test("values snap to the slider grid and stay in range", () => {
    expect(normalizeSpeed(1.26)).toBe(1.25);
    expect(normalizeSpeed(0.1)).toBe(0.5);
    expect(normalizeSpeed(9)).toBe(2);
    expect(normalizeSpeed(Number.NaN)).toBe(1);
    expect(normalizeSpeed("2")).toBe(1);
  });

  test("shown as text", () => {
    expect(formatSpeed(1)).toBe("x1.0");
    expect(formatSpeed(1.25)).toBe("x1.25");
    expect(formatSpeed(0.5)).toBe("x0.5");
    expect(formatSpeed(2)).toBe("x2.0");
  });
});

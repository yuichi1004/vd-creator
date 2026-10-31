// Per-device settings, kept in localStorage. See "Settings screen" in
// docs/plans/0010-settings-and-playback-speed.md. Every read and write is guarded, because
// storage can be missing, blocked, or full, and the defaults apply then.

export const SETTINGS_KEY = "vd-creator.settings";
const SETTINGS_VERSION = 1;

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
export const SPEED_STEP = 0.05;
export const SPEED_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

export type Settings = {
  /** Playback speed, from 0.5 to 2.0 in steps of 0.05. */
  speed: number;
  /** Keep the pitch of voices at any speed. */
  keepPitch: boolean;
};

export const DEFAULT_SETTINGS: Settings = { speed: 1, keepPitch: true };

/** The part of `Storage` that the store uses. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Snaps a value to the slider's grid. Anything that is not a number gives x1.0. */
export function normalizeSpeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.speed;
  const steps = Math.round(value / SPEED_STEP);
  const snapped = Math.round(steps * SPEED_STEP * 100) / 100;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, snapped));
}

/** The speed as text, such as "x1.0" or "x1.25". */
export function formatSpeed(speed: number): string {
  const text = String(normalizeSpeed(speed));
  return `x${text.includes(".") ? text : `${text}.0`}`;
}

/** The browser's storage, or undefined when it is missing or blocked. */
export function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Reads the settings. Missing, blocked, or invalid storage gives the defaults. */
export function loadSettings(storage: StorageLike | undefined = browserStorage()): Settings {
  try {
    const raw = storage?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return { ...DEFAULT_SETTINGS };
    const record = data as Record<string, unknown>;
    if (record.version !== SETTINGS_VERSION) return { ...DEFAULT_SETTINGS };
    return {
      speed: normalizeSpeed(record.speed),
      keepPitch:
        typeof record.keepPitch === "boolean" ? record.keepPitch : DEFAULT_SETTINGS.keepPitch,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Saves the settings. Returns false when storage refused, and the page goes on without it. */
export function saveSettings(
  settings: Settings,
  storage: StorageLike | undefined = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    const data = {
      version: SETTINGS_VERSION,
      speed: normalizeSpeed(settings.speed),
      keepPitch: settings.keepPitch,
    };
    storage.setItem(SETTINGS_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** The speeds that the quick speed button cycles through. */
export const QUICK_SPEEDS: readonly number[] = [1, 1.25, 1.5, 2];

/** The speed after a tap on the quick button. Other speeds, such as x0.5, go back to x1.0. */
export function nextQuickSpeed(speed: number): number {
  const index = QUICK_SPEEDS.indexOf(normalizeSpeed(speed));
  return QUICK_SPEEDS[(index + 1) % QUICK_SPEEDS.length] ?? 1;
}

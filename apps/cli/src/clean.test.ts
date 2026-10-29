// vd clean when assets/voice is swapped for a symbolic link while clean runs. node:fs/promises
// is wrapped so a test can swap the folder at a chosen step, and see every path clean touches.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CacheEntry, cacheKey } from "@vd-creator/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EXIT_FAILURE, EXIT_OK, run } from "./index.js";

const fsHook = vi.hoisted(() => ({
  /** Called with the function name and first argument before each call. */
  before: undefined as ((name: string, path: string) => void) | undefined,
  /** Called with the function name and first argument after each call returns. */
  after: undefined as ((name: string, path: string) => void) | undefined,
  paths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value !== "function" || name === "default") {
      wrapped[name] = value;
      continue;
    }
    const fn = value as (...args: unknown[]) => Promise<unknown>;
    wrapped[name] = async (...args: unknown[]) => {
      const path = String(args[0]);
      fsHook.paths.push(path);
      fsHook.before?.(name, path);
      const result = await fn(...args);
      fsHook.after?.(name, path);
      return result;
    };
  }
  return { ...wrapped, default: wrapped };
});

let tmp: string;
let dir: string;
let voice: string;
let outside: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vd-cli-clean-"));
  dir = join(tmp, "drama");
  voice = join(dir, "assets", "voice");
  outside = join(tmp, "outside");
  expect((await vd("init", dir)).code).toBe(EXIT_OK);
  expect((await vd("generate", dir)).code).toBe(EXIT_OK);
  writeFileSync(join(voice, "stray1.wav"), "stray");
  writeFileSync(join(voice, "stray2.wav"), "stray");
  // The folder a swapped assets/voice points to. Its files share names with the strays.
  mkdirSync(outside);
  writeFileSync(join(outside, "stray1.wav"), "outside");
  writeFileSync(join(outside, "stray2.wav"), "outside");
  fsHook.paths = [];
});

afterEach(async () => {
  fsHook.before = undefined;
  fsHook.after = undefined;
  chmodSync(dir, 0o755);
  await rm(tmp, { recursive: true, force: true });
});

function vd(...args: string[]) {
  return vdWith({}, ...args);
}

async function vdWith(env: Record<string, string>, ...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    env,
    // The temporary folder stands in for the repository, so no real local/ is read.
    { repoRoot: tmp },
  );
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** Returns a function that replaces assets/voice with a link to the outside folder, once. */
function swapVoiceOnce(): () => void {
  let swapped = false;
  return () => {
    if (swapped) return;
    swapped = true;
    renameSync(voice, join(tmp, "voice-moved"));
    symlinkSync(outside, voice);
  };
}

const outsideFiles = () => readdirSync(outside).sort();
const movedStrays = () =>
  readdirSync(join(tmp, "voice-moved"))
    .filter((file) => file.startsWith("stray"))
    .sort();

describe("vd clean when a folder is swapped while it runs", () => {
  test("a swap after the listing but before the first removal removes nothing", async () => {
    const swap = swapVoiceOnce();
    // The removal phase starts by resolving the project folder: swap right before it.
    fsHook.before = (name, path) => {
      if (name === "realpath" && path === dir) swap();
    };
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd clean: stopped cleaning ${dir}: a folder or file under assets changed while cleaning; stopped after removing 0 files`,
    );
    expect(outsideFiles()).toEqual(["stray1.wav", "stray2.wav"]);
    expect(movedStrays()).toEqual(["stray1.wav", "stray2.wav"]);
  });

  test("a swap after one removal stops and reports the count", async () => {
    const swap = swapVoiceOnce();
    fsHook.after = (name) => {
      if (name === "unlink") swap();
    };
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd clean: stopped cleaning ${dir}: a folder or file under assets changed while cleaning; stopped after removing 1 file`,
    );
    expect(outsideFiles()).toEqual(["stray1.wav", "stray2.wav"]);
    // The first stray was removed from the real folder, and the second was left.
    expect(movedStrays()).toEqual(["stray2.wav"]);
  });

  test("a dry run refuses a folder swapped during the listing and reads nothing outside", async () => {
    const swap = swapVoiceOnce();
    // The template only has assets/voice. Swap it once both strays have been looked at, so
    // the final check of the listing has to catch it.
    let strays = 0;
    fsHook.after = (name, path) => {
      if (name === "lstat" && path.startsWith(join(voice, "stray")) && ++strays === 2) swap();
    };
    const result = await vd("clean", dir, "--dry-run");
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd clean: refusing to clean ${dir}: assets/voice changed while it was being listed`,
    );
    expect(result.stdout).toBe("");
    expect(fsHook.paths.filter((path) => path.startsWith(outside))).toEqual([]);
    expect(fsHook.paths.filter((path) => path.startsWith(`${voice}/`))).not.toEqual([]);
    expect(existsSync(join(outside, "stray1.wav"))).toBe(true);
  });

  test("a listed file that is gone stops the removal and reports the true count", async () => {
    writeFileSync(join(voice, "stray3.wav"), "stray");
    let moved = false;
    fsHook.after = (name) => {
      if (name !== "unlink" || moved) return;
      moved = true;
      renameSync(join(voice, "stray2.wav"), join(tmp, "stray2-moved.wav"));
    };
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd clean: stopped cleaning ${dir}: a folder or file under assets changed while cleaning; stopped after removing 1 file`,
    );
    expect(existsSync(join(voice, "stray1.wav"))).toBe(false);
    expect(existsSync(join(voice, "stray3.wav"))).toBe(true);
  });

  test("a dry run refuses a listed file replaced by a folder", async () => {
    let strays = 0;
    fsHook.after = (name, path) => {
      if (name === "lstat" && path.startsWith(join(voice, "stray")) && ++strays === 2) {
        rmSync(join(voice, "stray1.wav"));
        mkdirSync(join(voice, "stray1.wav"));
      }
    };
    const result = await vd("clean", dir, "--dry-run");
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd clean: refusing to clean ${dir}: assets/voice/stray1.wav changed while it was being listed`,
    );
    expect(result.stdout).toBe("");
  });

  test("a swap after the first entry is looked at stops the listing at the next check", async () => {
    for (let i = 3; i <= 20; i++) writeFileSync(join(voice, `stray${i}.wav`), "stray");
    for (let i = 3; i <= 20; i++) writeFileSync(join(outside, `stray${i}.wav`), "outside");
    const swap = swapVoiceOnce();
    let swappedAt = -1;
    fsHook.after = (name, path) => {
      if (swappedAt < 0 && name === "lstat" && path.startsWith(`${voice}/`)) {
        swap();
        swappedAt = fsHook.paths.length;
      }
    };
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd clean: refusing to clean ${dir}: assets/voice changed while it was being listed`,
    );
    // Paths under the swapped link reach the outside folder.
    const touched = fsHook.paths
      .slice(swappedAt)
      .filter((path) => path.startsWith(`${voice}/`) || path.startsWith(outside));
    expect(touched.length).toBeLessThanOrEqual(1);
    expect(outsideFiles()).toHaveLength(20);
  });

  test("an unlink that fails after one removal stops and reports the count", async () => {
    let unlinks = 0;
    fsHook.before = (name) => {
      if (name === "unlink" && ++unlinks === 2) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
    };
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd clean: stopped cleaning ${dir}: could not remove a file under assets (EACCES); stopped after removing 1 file`,
    );
    expect(existsSync(join(voice, "stray1.wav"))).toBe(false);
    expect(existsSync(join(voice, "stray2.wav"))).toBe(true);
  });

  test("a check that cannot look at a folder after one removal stops and reports the count", async () => {
    let unlinked = false;
    let failed = false;
    fsHook.after = (name) => {
      if (name === "unlink") unlinked = true;
    };
    fsHook.before = (name) => {
      if (unlinked && !failed && name === "lstat") {
        failed = true;
        throw Object.assign(new Error("denied by the test"), { code: "EACCES" });
      }
    };
    const result = await vdWith({ VD_DEBUG: "1" }, "clean", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    const [message, ...details] = result.stderr.split("\n");
    expect(message).toBe(
      `vd clean: stopped cleaning ${dir}: could not check a folder or file under assets (EACCES); stopped after removing 1 file`,
    );
    // With VD_DEBUG=1, the underlying error is printed as the cause.
    expect(details.join("\n")).toContain("Caused by: Error: denied by the test");
    expect(existsSync(join(voice, "stray1.wav"))).toBe(false);
    expect(existsSync(join(voice, "stray2.wav"))).toBe(true);
  });

  test("a realpath that fails other than ENOENT after one removal stops and keeps the file", async () => {
    let unlinked = false;
    fsHook.after = (name) => {
      if (name === "unlink") unlinked = true;
    };
    fsHook.before = (name, path) => {
      if (unlinked && name === "realpath" && path.startsWith(`${voice}/`)) {
        throw Object.assign(new Error("denied by the test"), { code: "EACCES" });
      }
    };
    const result = await vdWith({ VD_DEBUG: "1" }, "clean", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    const [message, ...details] = result.stderr.split("\n");
    expect(message).toBe(
      `vd clean: stopped cleaning ${dir}: could not check a folder or file under assets (EACCES); stopped after removing 1 file`,
    );
    expect(details.join("\n")).toContain("Caused by: Error: denied by the test");
    expect(existsSync(join(voice, "stray1.wav"))).toBe(false);
    expect(existsSync(join(voice, "stray2.wav"))).toBe(true);
  });

  // Root can write to a read-only folder, so the save would not fail.
  test.skipIf(process.getuid?.() === 0)(
    "a cache.json save that fails after removals reports the count",
    async () => {
      const file = join(dir, "cache.json");
      const cache = JSON.parse(readFileSync(file, "utf8"));
      const [entry] = Object.values(cache.entries) as CacheEntry[];
      if (!entry) throw new Error("no cache entry");
      // An entry for a line that the scenario no longer has.
      const request = { ...(entry.request as object), text: "Gone." };
      cache.entries[cacheKey(entry.kind, entry.providerId, request)] = { ...entry, request };
      writeFileSync(file, JSON.stringify(cache));
      // Make the project folder read-only once the files are removed, so the save fails.
      let unlinks = 0;
      fsHook.after = (name) => {
        if (name === "unlink" && ++unlinks === 2) chmodSync(dir, 0o555);
      };
      const result = await vd("clean", dir);
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toBe(
        `vd clean: stopped cleaning ${dir}: removed 2 files, but could not update cache.json (EACCES)`,
      );
      expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).entries)).toHaveLength(2);
    },
  );

  test("without a swap, clean removes the strays", async () => {
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(
      "Removed assets/voice/stray1.wav\nRemoved assets/voice/stray2.wav\nRemoved 2 files and 0 cache entries",
    );
  });
});

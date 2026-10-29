// vd config init when the target folder, or a folder above it, is swapped for a symbolic link
// into the repository while init runs. node:fs/promises is wrapped so a test can swap a folder at
// a chosen step. Every test uses temporary folders, so the real home folder is never touched.

import { mkdirSync, readdirSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EXIT_OK, run } from "../cli.js";
import { type Env, initUserDir } from "./index.js";

const fsHook = vi.hoisted(() => ({
  /** Called with the function name and first argument before each call. */
  before: undefined as ((name: string, path: string) => void) | undefined,
  /** Called with the function name and first argument after each call returns. */
  after: undefined as ((name: string, path: string) => void) | undefined,
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
      fsHook.before?.(name, path);
      const result = await fn(...args);
      fsHook.after?.(name, path);
      return result;
    };
  }
  return { ...wrapped, default: wrapped };
});

let tmp: string;
/** Stands in for the repository; apps/ stands in for a tracked folder in it. */
let repo: string;
let apps: string;
let home: string;
let outside: string;

beforeEach(async () => {
  tmp = realpathSync(await mkdtemp(join(tmpdir(), "vd-cli-init-race-")));
  repo = join(tmp, "repo");
  apps = join(repo, "apps");
  home = join(tmp, "home");
  outside = join(tmp, "outside");
  for (const dir of [apps, home, outside]) mkdirSync(dir, { recursive: true });
});

afterEach(async () => {
  fsHook.before = undefined;
  fsHook.after = undefined;
  await rm(tmp, { recursive: true, force: true });
});

async function vd(...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const env: Env = { HOME: home };
  const code = await run(
    args,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    env,
    { repoRoot: repo },
  );
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** Replaces the folder `dir` with a symbolic link to `to`, keeping the folder aside. */
function swapForLink(dir: string, to: string) {
  try {
    renameSync(dir, `${dir}.aside`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  symlinkSync(to, dir);
}

/** Runs `swap` once, the first time `name` is called on `path`, before or after the call. */
function swapAt(when: "before" | "after", name: string, path: string, swap: () => void) {
  let done = false;
  fsHook[when] = (calledName, calledPath) => {
    if (done || calledName !== name || calledPath !== path) return;
    done = true;
    swap();
  };
}

/**
 * Expects init to have stopped with the fixed error, and nothing left in the tracked folder that
 * the link points to. What the test itself moved aside is not checked.
 */
function expectStopped(result: { code: number; stdout: string; stderr: string }, typed: string) {
  expect(result.code).not.toBe(EXIT_OK);
  expect(result.stderr).toBe(
    `vd config init: ${typed} changed while it was being set up; stopped and removed what this run created`,
  );
  expect(readdirSync(apps)).toEqual([]);
}

describe("vd config init with a folder swapped while it runs", () => {
  test("local/ swapped for a link into the repository between the check and mkdir", async () => {
    const local = join(repo, "local");
    swapAt("before", "mkdir", local, () => swapForLink(local, apps));
    expectStopped(await vd("config", "init"), "local/");
  });

  test("a folder above the target swapped for a link into the repository before mkdir", async () => {
    const parent = join(outside, "parent");
    mkdirSync(parent);
    const target = join(parent, "user");
    swapAt("before", "mkdir", target, () => swapForLink(parent, apps));
    expectStopped(await vd("config", "init", "--dir", target), target);
  });

  test("local/ swapped for a link into the repository between mkdir and the first file", async () => {
    const local = join(repo, "local");
    swapAt("after", "mkdir", local, () => swapForLink(local, apps));
    expectStopped(await vd("config", "init"), "local/");
  });

  test.each(["config.yaml", "AGENTS.md"])(
    "local/ swapped for a link into the repository just before %s is created",
    async (name) => {
      const local = join(repo, "local");
      swapAt("before", "open", join(local, name), () => swapForLink(local, apps));
      expectStopped(await vd("config", "init"), "local/");
    },
  );

  test("local/ swapped for a link into the repository just before docs/ is created", async () => {
    const local = join(repo, "local");
    swapAt("before", "mkdir", join(local, "docs"), () => swapForLink(local, apps));
    expectStopped(await vd("config", "init"), "local/");
  });

  test("an outside target swapped for a link into the repository before a file is created", async () => {
    const target = join(outside, "user");
    swapAt("before", "open", join(target, "config.yaml"), () => swapForLink(target, apps));
    expectStopped(await vd("config", "init", "--dir", target), target);
  });

  test("without a swap, init creates the layout in the real folder", async () => {
    const result = await initUserDir(undefined, { repoRoot: repo });
    expect(result.created).toEqual(["config.yaml", "AGENTS.md", "docs/"]);
    expect(readdirSync(join(repo, "local")).sort()).toEqual(["AGENTS.md", "config.yaml", "docs"]);
    expect(readdirSync(apps)).toEqual([]);
  });
});

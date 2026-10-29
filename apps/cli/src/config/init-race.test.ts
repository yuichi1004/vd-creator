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

const REMOVED = "stopped and removed what this run created";
const LEFT = "stopped, and left in place what this run could not safely remove";

/**
 * Expects init to have stopped with the fixed error `ending`, and the tracked folder that the
 * link points to to hold only `inApps`, each an empty folder that the residual one-call race let
 * this run create. What the test itself moved aside is not checked.
 */
function expectStopped(
  result: { code: number; stdout: string; stderr: string },
  typed: string,
  ending: string,
  inApps: string[] = [],
) {
  expect(result.code).not.toBe(EXIT_OK);
  expect(result.stderr).toBe(
    `vd config init: ${typed} changed while it was being set up; ${ending}`,
  );
  expect(readdirSync(apps)).toEqual(inApps);
  for (const name of inApps) expect(readdirSync(join(apps, name))).toEqual([]);
}

describe("vd config init with a folder swapped while it runs", () => {
  test("local/ swapped for a link into the repository between the check and mkdir", async () => {
    const local = join(repo, "local");
    swapAt("before", "mkdir", local, () => swapForLink(local, apps));
    expectStopped(await vd("config", "init"), "local/", REMOVED);
  });

  test("a folder above the target swapped for a link into the repository before mkdir", async () => {
    const parent = join(outside, "parent");
    mkdirSync(parent);
    const target = join(parent, "user");
    swapAt("before", "mkdir", target, () => swapForLink(parent, apps));
    // mkdir went through the link, and the lstat after it cannot tell this run's folder from one
    // that was there, so the folder is left in place, never removed.
    expectStopped(await vd("config", "init", "--dir", target), target, LEFT, ["user"]);
  });

  test("local/ swapped for a link into the repository between mkdir and the first file", async () => {
    const local = join(repo, "local");
    swapAt("after", "mkdir", local, () => swapForLink(local, apps));
    expectStopped(await vd("config", "init"), "local/", LEFT);
  });

  test.each(["config.yaml", "AGENTS.md"])(
    "local/ swapped for a link into the repository just before %s is created",
    async (name) => {
      const local = join(repo, "local");
      swapAt("before", "open", join(local, name), () => swapForLink(local, apps));
      // The file created through the link is this run's, known by its open handle, so it is
      // removed. local/ itself is then not the folder this run made, so the rollback stops.
      expectStopped(await vd("config", "init"), "local/", LEFT);
    },
  );

  test("local/ swapped for a link into the repository just before docs/ is created", async () => {
    const local = join(repo, "local");
    swapAt("before", "mkdir", join(local, "docs"), () => swapForLink(local, apps));
    expectStopped(await vd("config", "init"), "local/", LEFT, ["docs"]);
  });

  test("an outside target swapped for a link into the repository before a file is created", async () => {
    const target = join(outside, "user");
    swapAt("before", "open", join(target, "config.yaml"), () => swapForLink(target, apps));
    expectStopped(await vd("config", "init", "--dir", target), target, LEFT);
  });

  test("an outside folder above made folders swapped after mkdir: folders in the repository survive", async () => {
    // The case from review: init makes outside/above/made/user, and outside/above is then swapped
    // for a link to apps/, which already holds made/user. Rollback must not remove those.
    const above = join(outside, "above");
    mkdirSync(above);
    mkdirSync(join(apps, "made", "user"), { recursive: true });
    const target = join(above, "made", "user");
    swapAt("after", "mkdir", target, () => swapForLink(above, apps));
    const result = await vd("config", "init", "--dir", target);
    expect(result.code).not.toBe(EXIT_OK);
    expect(result.stderr).toBe(
      `vd config init: ${target} changed while it was being set up; ${LEFT}`,
    );
    expect(readdirSync(apps)).toEqual(["made"]);
    expect(readdirSync(join(apps, "made"))).toEqual(["user"]);
    expect(readdirSync(join(apps, "made", "user"))).toEqual([]);
  });

  test("an error after nested folders are made removes them all, deepest first", async () => {
    const target = join(outside, "a", "b", "user");
    const removed: string[] = [];
    fsHook.before = (name, path) => {
      if (name === "open" && path === join(target, "AGENTS.md")) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      if (name === "unlink" || name === "rmdir") removed.push(path);
    };
    await expect(initUserDir(target, { repoRoot: repo })).rejects.toThrow("denied");
    expect(readdirSync(outside)).toEqual([]);
    expect(removed).toEqual([
      join(target, "config.yaml"),
      target,
      join(outside, "a", "b"),
      join(outside, "a"),
    ]);
  });

  test("without a swap, init creates the layout in the real folder", async () => {
    const result = await initUserDir(undefined, { repoRoot: repo });
    expect(result.created).toEqual(["config.yaml", "AGENTS.md", "docs/"]);
    expect(readdirSync(join(repo, "local")).sort()).toEqual(["AGENTS.md", "config.yaml", "docs"]);
    expect(readdirSync(apps)).toEqual([]);
  });
});

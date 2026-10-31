// The project lock, changes.lock. See "One writer at a time" in
// docs/plans/0015-change-log-and-draft-audio.md.

import { randomUUID } from "node:crypto";
import { link, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** File name of the lock inside a project folder. */
export const LOCK_FILE = "changes.lock";

export type ChangeLockOptions = {
  /** How long to wait for the lock. Defaults to 5000. */
  waitMs?: number;
  /** A lock older than this is taken over. Defaults to 30000. */
  staleMs?: number;
  /** How often to look again while waiting. Defaults to 25. */
  pollMs?: number;
};

export const LOCK_WAIT_MS = 5000;
export const LOCK_STALE_MS = 30_000;

/** Thrown when the project lock could not be taken in time. */
export class ChangeLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChangeLockError";
  }
}

/**
 * Runs `fn` holding the project lock: `changes.lock` in the project folder, created exclusively
 * with the process ID and the time. Waits for the lock, and takes over one whose process no
 * longer runs or which is older than `staleMs`. Throws a `ChangeLockError` if the lock is not
 * free in time. Locks are not re-entrant: `fn` must not ask for the lock again.
 */
export async function withProjectLock<T>(
  projectDir: string,
  fn: () => Promise<T>,
  options: ChangeLockOptions = {},
): Promise<T> {
  const token = await acquire(projectDir, options);
  try {
    return await fn();
  } finally {
    await release(projectDir, token);
  }
}

async function acquire(projectDir: string, options: ChangeLockOptions): Promise<string> {
  const { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, pollMs = 25 } = options;
  const path = join(projectDir, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = randomUUID();
    const content = JSON.stringify({ pid: process.pid, time: new Date().toISOString(), token });
    if (await createExclusive(path, content, token)) return token;
    await breakStale(path, staleMs);
    if (Date.now() >= deadline) {
      throw new ChangeLockError(
        `Another process is changing the project (${LOCK_FILE} is held); try again in a moment`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Creates the lock file with its content in place, so that no one reads it half written: the
 * content goes to a temporary file that is hard-linked to the lock, which fails if the lock
 * exists. Where hard links are not available, the lock is created directly.
 */
async function createExclusive(path: string, content: string, token: string): Promise<boolean> {
  const temp = `${path}.${token}.tmp`;
  try {
    await writeFile(temp, content);
    try {
      await link(temp, path);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV") throw e;
    }
    try {
      await writeFile(path, content, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  } finally {
    await rm(temp, { force: true });
  }
}

async function release(projectDir: string, token: string): Promise<void> {
  const path = join(projectDir, LOCK_FILE);
  // A lock that was taken over is not ours to remove.
  const raw = await readRaw(path);
  if (raw !== undefined && parseLock(raw)?.token === token) await rm(path, { force: true });
}

/**
 * Removes the lock if it is stale. Only one process breaks a lock at a time, through
 * `changes.lock.break`, and it removes the lock only if it still holds the content it judged
 * stale, so a lock taken a moment later is kept.
 */
async function breakStale(path: string, staleMs: number): Promise<void> {
  const raw = await readRaw(path);
  if (raw === undefined || !(await isStale(path, raw, staleMs))) return;
  const gate = `${path}.break`;
  try {
    await writeFile(gate, "", { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // A gate left by a process that stopped is old; one in use is not.
    if (await isOlderThan(gate, staleMs)) await rm(gate, { force: true });
    return;
  }
  try {
    if ((await readRaw(path)) === raw) await unlink(path);
  } finally {
    await rm(gate, { force: true });
  }
}

async function isStale(path: string, raw: string, staleMs: number): Promise<boolean> {
  const lock = parseLock(raw);
  if (!lock) return isOlderThan(path, staleMs);
  if (Date.now() - Date.parse(lock.time) > staleMs) return true;
  return !processRuns(lock.pid);
}

type Lock = { pid: number; time: string; token: string };

function parseLock(raw: string): Lock | undefined {
  try {
    const data = JSON.parse(raw) as Partial<Lock>;
    if (
      Number.isInteger(data.pid) &&
      typeof data.time === "string" &&
      !Number.isNaN(Date.parse(data.time)) &&
      typeof data.token === "string"
    ) {
      return data as Lock;
    }
  } catch {
    // Not a lock written by this module.
  }
  return undefined;
}

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function isOlderThan(path: string, ms: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > ms;
  } catch {
    return false;
  }
}

async function readRaw(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

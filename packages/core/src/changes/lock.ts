// The project lock, changes.lock. See "One writer at a time" in
// docs/plans/0015-change-log-and-draft-audio.md.

import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    // A failed release must not hide the error of `fn`. The lock then ends by going stale.
    await release(projectDir, token, options).catch(() => {});
    throw e;
  }
  await release(projectDir, token, options);
  return result;
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
    // The temporary file goes whether or not the lock was created, even after a failed write.
    await rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Removes the lock if it is still ours. Like breaking a stale lock, this goes through the gate, so
 * that a takeover cannot replace the lock between the check and the removal. Gives up with a
 * `ChangeLockError` if the gate stays busy for `waitMs`.
 */
async function release(
  projectDir: string,
  token: string,
  options: ChangeLockOptions,
): Promise<void> {
  const { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = options;
  const path = join(projectDir, LOCK_FILE);
  await withGate(path, staleMs, Date.now() + waitMs, async () => {
    // A lock that was taken over is not ours to remove.
    const raw = await readRaw(path);
    if (raw !== undefined && parseLock(raw)?.token === token) await rm(path, { force: true });
  });
}

/**
 * Removes the lock if it is stale. The lock file is only removed while holding the gate,
 * `changes.lock.break`, and only created while absent, so the content judged stale cannot change
 * before the removal. It is removed only if it still holds that content.
 */
async function breakStale(path: string, staleMs: number): Promise<void> {
  const raw = await readRaw(path);
  if (raw === undefined || !(await isStale(path, raw, staleMs))) return;
  await withGate(path, staleMs, undefined, async () => {
    if ((await readRaw(path)) === raw) await rm(path, { force: true });
  });
}

/**
 * Runs `fn` holding the gate of the lock file, `<lock>.break`, created exclusively. With a
 * `deadline` (a time in milliseconds) it polls for the gate and throws a `ChangeLockError` when
 * the time comes; without, it gives up quietly if someone else has the gate. A gate left by a
 * process that stopped is older than `staleMs` and is removed.
 */
async function withGate(
  path: string,
  staleMs: number,
  deadline: number | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const gate = `${path}.break`;
  for (;;) {
    try {
      await writeFile(gate, "", { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (await removeStaleGate(gate, staleMs)) continue;
      if (deadline === undefined) return;
      if (Date.now() >= deadline) {
        throw new ChangeLockError(`${LOCK_FILE}.break is busy; try again in a moment`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  try {
    await fn();
  } finally {
    await rm(gate, { force: true });
  }
}

/**
 * Removes the gate if it is older than `staleMs`. The gate may be removed and created again by
 * someone else between the look and the removal, so it is first renamed to a name of its own and
 * judged again there: a live gate that was renamed is put back. Returns whether a stale gate was
 * removed.
 */
async function removeStaleGate(gate: string, staleMs: number): Promise<boolean> {
  if (!(await isOlderThan(gate, staleMs))) return false;
  const aside = `${gate}.${randomUUID()}.stale`;
  try {
    await rename(gate, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
  try {
    if (await isOlderThan(aside, staleMs)) return true;
    // It was a live gate. Put it back; if a newer gate has taken its place, give it up.
    await link(aside, gate).catch(() => {});
    return false;
  } finally {
    await rm(aside, { force: true });
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

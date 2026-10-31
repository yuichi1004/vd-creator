// Reconciling scenario.yaml with the snapshot, and the entries only core writes. See
// "Finding file changes", "One writer at a time", and "Commands for agents" in
// docs/plans/0015-change-log-and-draft-audio.md.

import { type Issue, loadScenario, type Scenario } from "@vd-creator/scenario";
import { applyEntries } from "./apply.js";
import { diffSnapshots } from "./diff.js";
import {
  type AgentEntry,
  ChangeLogError,
  isTargetChange,
  REASON_MAX_LENGTH,
  type ReviewEntry,
  type TargetChangeEntry,
} from "./entry.js";
import { type ChangeLockOptions, withProjectLock } from "./lock.js";
import { appendEntries, readEntries } from "./log.js";
import { readSnapshot, snapshotOf, writeSnapshot } from "./snapshot.js";

export type ChangeOptions = {
  lock?: ChangeLockOptions;
  /** The time of new entries. Defaults to now. */
  now?: () => Date;
};

export type ReconcileResult =
  /** There is no scenario.yaml. */
  | { status: "no-scenario" }
  /** The scenario does not validate, so nothing was compared and the snapshot stayed. */
  | { status: "invalid"; issues: Issue[] }
  /** The first run: the snapshot was written, and nothing was recorded. */
  | { status: "baseline" }
  /** The `file` entries recorded by this run, none if the file matches the snapshot. */
  | { status: "ok"; entries: TargetChangeEntry[] };

/**
 * Compares scenario.yaml with the snapshot and records the differences as `file` entries, then
 * replaces the snapshot. Holds the project lock. A scenario that does not validate is not
 * compared. See `reconcileLocked`.
 */
export function reconcile(
  projectDir: string,
  options: ChangeOptions = {},
): Promise<ReconcileResult> {
  return withProjectLock(projectDir, () => reconcileLocked(projectDir, options), options.lock);
}

/**
 * `reconcile` for a caller that already holds the project lock, such as a UI change. If a
 * writer stopped after appending entries but before replacing the snapshot, the differences are
 * found again from the state that the entries after the snapshot's `lastEntryId` already
 * describe, so those are not recorded a second time, and a later change starts from their result.
 */
export async function reconcileLocked(
  projectDir: string,
  options: ChangeOptions = {},
): Promise<ReconcileResult> {
  let loaded: Awaited<ReturnType<typeof loadScenario>>;
  try {
    loaded = await loadScenario(projectDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "no-scenario" };
    throw e;
  }
  const { scenario, issues } = loaded;
  if (!scenario || issues.some((i) => i.severity === "error")) return { status: "invalid", issues };

  const entries = await readEntries(projectDir);
  const lastId = entries.at(-1)?.id ?? 0;
  const before = await readSnapshot(projectDir);
  if (!before) {
    await writeSnapshot(projectDir, snapshotOf(scenario, lastId));
    return { status: "baseline" };
  }
  const after = snapshotOf(scenario, lastId);
  // Entries after the snapshot were appended by a writer that stopped before replacing it, so
  // the state to compare with is the snapshot with those entries applied.
  const recorded0 = applyEntries(
    before,
    entries.filter((e) => e.id > before.lastEntryId),
  );
  const differences = diffSnapshots(recorded0, after);
  const recorded = (await appendEntries(
    projectDir,
    differences.map((d) => ({ source: "file" as const, ...d })),
    stamp(options),
  )) as TargetChangeEntry[];
  after.lastEntryId = recorded.at(-1)?.id ?? lastId;
  await writeSnapshot(projectDir, after);
  return { status: "ok", entries: recorded };
}

export type UiChangeOptions = ChangeOptions & {
  /** The session that made the change, for the UI to leave its own changes unmarked. */
  session?: string;
  /** From an agent's proposal. */
  reason?: string;
};

/**
 * Records the difference between the snapshot and `scenario`, the scenario a UI change has just
 * written, as `ui` entries, and replaces the snapshot. The caller holds the project lock and has
 * called `reconcileLocked` before writing, so the snapshot is the state the change started
 * from. Without a snapshot, only the snapshot is written. Returns the entries.
 */
export async function recordUiChanges(
  projectDir: string,
  scenario: Scenario,
  options: UiChangeOptions = {},
): Promise<TargetChangeEntry[]> {
  const lastId = (await readEntries(projectDir)).at(-1)?.id ?? 0;
  const before = await readSnapshot(projectDir);
  const after = snapshotOf(scenario, lastId);
  let recorded: TargetChangeEntry[] = [];
  if (before) {
    if (options.reason !== undefined) checkReason(options.reason);
    recorded = (await appendEntries(
      projectDir,
      diffSnapshots(before, after).map((d) => ({
        source: "ui" as const,
        ...d,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        ...(options.session === undefined ? {} : { session: options.session }),
      })),
      stamp(options),
    )) as TargetChangeEntry[];
    after.lastEntryId = recorded.at(-1)?.id ?? lastId;
  }
  await writeSnapshot(projectDir, after);
  return recorded;
}

export type RecordAgentOptions = ChangeOptions & {
  /** Explain only the `file` entries whose target is an item with one of these IDs. */
  items?: readonly string[];
};

/**
 * Records the reason an agent gives for its work: reconciles, then appends an `agent` entry
 * whose `refs` are the IDs of the `file` entries that no `agent` entry explains yet, however
 * old, or only those whose target ID is in `items`. The entry is appended even with no refs,
 * as it moves the point that `vd changes` reads from. If the scenario does not validate, the
 * reason is still recorded and `reconcile` says so. Throws a `ChangeLogError` if the reason is
 * empty or longer than 300 characters.
 */
export async function recordAgent(
  projectDir: string,
  reason: string,
  options: RecordAgentOptions = {},
): Promise<{ entry: AgentEntry; reconcile: ReconcileResult }> {
  checkReason(reason);
  return withProjectLock(
    projectDir,
    async () => {
      const result = await reconcileLocked(projectDir, options);
      const entries = await readEntries(projectDir);
      const explained = new Set(entries.flatMap((e) => (e.source === "agent" ? e.refs : [])));
      const only = options.items && new Set(options.items);
      const refs = entries
        .filter((e) => e.source === "file" && !explained.has(e.id))
        .filter(
          (e) => !only || (isTargetChange(e) && e.target.kind === "item" && only.has(e.target.id)),
        )
        .map((e) => e.id);
      const [entry] = await appendEntries(
        projectDir,
        [{ source: "agent", reason, refs }],
        stamp(options),
      );
      return { entry: entry as AgentEntry, reconcile: result };
    },
    options.lock,
  );
}

/** Appends a `review` entry: the user has seen the changes so far. */
export function recordReview(
  projectDir: string,
  options: ChangeOptions = {},
): Promise<ReviewEntry> {
  return withProjectLock(
    projectDir,
    async () =>
      (await appendEntries(projectDir, [{ source: "review" }], stamp(options)))[0] as ReviewEntry,
    options.lock,
  );
}

function stamp(options: ChangeOptions): { now: Date } | Record<string, never> {
  return options.now ? { now: options.now() } : {};
}

function checkReason(reason: string): void {
  if (reason.trim() === "") throw new ChangeLogError("The reason is empty");
  if ([...reason].length > REASON_MAX_LENGTH) {
    throw new ChangeLogError(`The reason must be ${REASON_MAX_LENGTH} characters or fewer`);
  }
}

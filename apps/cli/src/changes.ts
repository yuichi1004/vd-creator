// vd changes: read the change log, and record an agent's reason.
// See "Commands for agents" in docs/plans/0015-change-log-and-draft-audio.md.

import {
  CHANGE_SOURCES,
  type ChangeEntry,
  ChangeLogError,
  type ChangeSince,
  type ChangeSource,
  readChanges,
  reconcile,
  recordAgent,
} from "@vd-creator/core";
import { SCENARIO_FILE } from "@vd-creator/scenario";

export const CHANGES_USAGE = `Usage: vd changes [dir] [--since <entry ID|time|start>] [--source ui|file|agent] [--json]
       vd changes record [dir] --reason "<why>" [--items <id,...>]`;

export type ChangesOptions = {
  since?: string | undefined;
  source?: string | undefined;
  json?: boolean | undefined;
  reason?: string | undefined;
  items?: string | undefined;
};

/** What `vd changes` needs from the CLI. Each output call writes one line. */
export type ChangesIo = {
  stdout(line: string): void;
  stderr(line: string): void;
  debug(e: unknown): void;
};

/** The exit codes of the CLI, passed in so this module does not import cli.ts. */
export type ChangesExit = { ok: number; failure: number; usage: number };

/** Runs `vd changes` or `vd changes record`. Returns the exit code. */
export async function changesCommand(
  args: string[],
  options: ChangesOptions,
  io: ChangesIo,
  exit: ChangesExit,
): Promise<number> {
  const record = args[0] === "record";
  const [dir = ".", ...extra] = record ? args.slice(1) : args;
  if (extra.length > 0) {
    io.stderr(CHANGES_USAGE);
    return exit.usage;
  }
  try {
    return record
      ? await recordCommand(dir, options, io, exit)
      : await listCommand(dir, options, io, exit);
  } catch (e) {
    if (e instanceof ChangeLogError) {
      io.stderr(`vd changes: ${e.message}`);
      io.debug(e);
      return exit.failure;
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code !== "string" || !/^E[A-Z]+$/.test(code)) throw e;
    io.stderr(`vd changes: cannot use the change log in ${dir}: ${code}`);
    io.debug(e);
    return exit.failure;
  }
}

/** A warning for the result of a reconcile that could not compare the scenario, or undefined. */
function reconcileWarning(result: Awaited<ReturnType<typeof reconcile>>): string | undefined {
  if (result.status === "no-scenario")
    return `no ${SCENARIO_FILE} was found, so nothing was compared`;
  if (result.status === "invalid") {
    return `${SCENARIO_FILE} does not validate, so changes in the file are not recorded until it does; run vd validate`;
  }
  return undefined;
}

async function listCommand(
  dir: string,
  options: ChangesOptions,
  io: ChangesIo,
  exit: ChangesExit,
): Promise<number> {
  if (options.reason !== undefined || options.items !== undefined) {
    io.stderr("vd changes: --reason and --items belong to vd changes record");
    io.stderr(CHANGES_USAGE);
    return exit.usage;
  }
  const since = parseSince(options.since);
  const source = parseSource(options.source);
  if (since === undefined || source === undefined) {
    io.stderr(CHANGES_USAGE);
    return exit.usage;
  }
  const warning = reconcileWarning(await reconcile(dir));
  if (warning) io.stderr(`vd changes: ${warning}`);
  const entries = await readChanges(dir, {
    since,
    ...(source === "all" ? {} : { source }),
  });
  if (options.json) {
    io.stdout(JSON.stringify(entries, null, 2));
    return exit.ok;
  }
  if (entries.length === 0) io.stdout("No changes.");
  for (const entry of entries) io.stdout(formatEntry(entry));
  return exit.ok;
}

async function recordCommand(
  dir: string,
  options: ChangesOptions,
  io: ChangesIo,
  exit: ChangesExit,
): Promise<number> {
  if (options.reason === undefined || options.reason.trim() === "") {
    io.stderr('vd changes record: --reason "<why>" is required');
    io.stderr(CHANGES_USAGE);
    return exit.usage;
  }
  if (options.since !== undefined || options.source !== undefined || options.json) {
    io.stderr("vd changes record: --since, --source, and --json belong to vd changes");
    io.stderr(CHANGES_USAGE);
    return exit.usage;
  }
  const items = options.items?.split(",").map((id) => id.trim());
  if (items?.some((id) => id === "")) {
    io.stderr(CHANGES_USAGE);
    return exit.usage;
  }
  const { entry, reconcile: result } = await recordAgent(
    dir,
    options.reason,
    items ? { items } : {},
  );
  const warning = reconcileWarning(result);
  if (warning) io.stderr(`vd changes: ${warning}`);
  const n = entry.refs.length;
  io.stdout(
    `Recorded #${entry.id}, which explains ${n} ${n === 1 ? "change" : "changes"} in the file`,
  );
  return exit.ok;
}

/** `undefined` if the text is not a valid point. No text means after the last `agent` entry. */
function parseSince(text: string | undefined): ChangeSince | undefined {
  if (text === undefined) return "agent";
  if (text === "start") return "start";
  if (/^\d+$/.test(text)) return { id: Number(text) };
  return Number.isNaN(Date.parse(text)) ? undefined : { time: text };
}

function parseSource(text: string | undefined): ChangeSource | "all" | undefined {
  if (text === undefined) return "all";
  return (CHANGE_SOURCES as readonly string[]).includes(text) ? (text as ChangeSource) : undefined;
}

const VALUE_MAX = 80;

function show(value: unknown): string {
  if (value === undefined) return "(none)";
  const text = JSON.stringify(value);
  return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text;
}

function position(p: { scene?: string; index: number }): string {
  return p.scene === undefined ? `#${p.index + 1}` : `${p.scene} #${p.index + 1}`;
}

/** One readable line: ID, time, source, target, change, and reason. */
export function formatEntry(entry: ChangeEntry): string {
  const head = `#${entry.id} ${entry.time} ${entry.source}`;
  if (entry.source === "review") return `${head}: marked reviewed`;
  if (entry.source === "agent") {
    const refs =
      entry.refs.length > 0 ? ` (explains ${entry.refs.map((r) => `#${r}`).join(", ")})` : "";
    return `${head}: ${show(entry.reason)}${refs}`;
  }
  const target = `${entry.target.kind} ${JSON.stringify(entry.target.id)}`;
  let change: string;
  switch (entry.change) {
    case "added":
      change = `added at ${position(entry.to)}`;
      break;
    case "removed":
      change = `removed from ${position(entry.from)}`;
      break;
    case "moved":
      change = `moved from ${position(entry.from)} to ${position(entry.to)}`;
      break;
    case "edited":
      change = `edited ${entry.field}: ${show(entry.old)} -> ${show(entry.new)}`;
      break;
  }
  const reason = entry.reason === undefined ? "" : ` (${show(entry.reason)})`;
  return `${head}: ${target} ${change}${reason}`;
}

// changes.jsonl: append and read. See "One writer at a time" in
// docs/plans/0015-change-log-and-draft-audio.md.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ChangeEntry,
  type ChangeEntryDraft,
  ChangeLogError,
  type ChangeSource,
  parseChangeEntry,
} from "./entry.js";

/** File name of the change log inside a project folder. */
export const CHANGES_FILE = "changes.jsonl";

/** Writes a file atomically: a temporary file in the same folder, then a rename. */
export async function writeFileAtomic(target: string, text: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

/** The text of the log up to its last newline, and whether a cut-off last line follows it. */
async function readComplete(
  projectDir: string,
): Promise<{ text: string; bytes: number; cutOff: boolean }> {
  let data: Buffer;
  try {
    data = await readFile(join(projectDir, CHANGES_FILE));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { text: "", bytes: 0, cutOff: false };
    throw e;
  }
  const bytes = data.lastIndexOf(0x0a) + 1;
  return {
    text: data.subarray(0, bytes).toString("utf8"),
    bytes,
    cutOff: bytes < data.length,
  };
}

function parseLines(text: string): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  let lineNumber = 0;
  for (const line of text.split("\n")) {
    lineNumber++;
    if (line.trim() === "") continue;
    try {
      entries.push(parseChangeEntry(JSON.parse(line)));
    } catch (e) {
      throw new ChangeLogError(`${CHANGES_FILE} line ${lineNumber} is not a change entry`, {
        cause: e,
      });
    }
  }
  return entries;
}

/**
 * Reads every entry of `<projectDir>/changes.jsonl`, oldest first. A last line without its
 * newline was cut off by a stopped writer and is skipped. Returns no entries if the file does
 * not exist. Throws a `ChangeLogError` if a complete line is not an entry.
 */
export async function readEntries(projectDir: string): Promise<ChangeEntry[]> {
  return parseLines((await readComplete(projectDir)).text);
}

/** The point to read from: after an entry or a time, or after the last entry of a source. */
export type ChangeSince =
  | "start"
  /** After the last `review` entry. */
  | "review"
  /** After the last `agent` entry. */
  | "agent"
  | { id: number }
  | { time: string | Date };

/** The entries after a point, oldest first. A point that no entry marks gives all entries. */
export function entriesSince(entries: readonly ChangeEntry[], since: ChangeSince): ChangeEntry[] {
  if (since === "start") return [...entries];
  if (since === "review" || since === "agent") {
    const last = entries.findLastIndex((e) => e.source === since);
    return entries.slice(last + 1);
  }
  if ("id" in since) return entries.filter((e) => e.id > since.id);
  const at = since.time instanceof Date ? since.time.getTime() : Date.parse(since.time);
  if (Number.isNaN(at)) throw new ChangeLogError("The time to read from is not a valid time");
  return entries.filter((e) => Date.parse(e.time) > at);
}

export type ChangeFilter = {
  since?: ChangeSince;
  source?: ChangeSource | readonly ChangeSource[];
};

/** Reads the log and keeps the entries after `since` (default all) from the given sources. */
export async function readChanges(
  projectDir: string,
  filter: ChangeFilter = {},
): Promise<ChangeEntry[]> {
  let entries = entriesSince(await readEntries(projectDir), filter.since ?? "start");
  if (filter.source !== undefined) {
    const sources: readonly string[] =
      typeof filter.source === "string" ? [filter.source] : filter.source;
    entries = entries.filter((e) => sources.includes(e.source));
  }
  return entries;
}

export type AppendOptions = {
  /** The time of the entries. Defaults to now. */
  now?: Date;
};

/**
 * Appends entries to the log, giving each the next ID and the time, in one write that ends in a
 * newline. A cut-off last line is removed first. The caller holds the project lock. Returns the
 * entries as written. Throws a `ChangeLogError`, writing nothing, if a draft is not valid.
 */
export async function appendEntries(
  projectDir: string,
  drafts: readonly ChangeEntryDraft[],
  options: AppendOptions = {},
): Promise<ChangeEntry[]> {
  if (drafts.length === 0) return [];
  const { text, bytes, cutOff } = await readComplete(projectDir);
  const last = parseLines(text).at(-1);
  const time = (options.now ?? new Date()).toISOString();
  const entries = drafts.map(
    (draft, i): ChangeEntry => parseChangeEntry({ id: (last?.id ?? 0) + i + 1, time, ...draft }),
  );
  const path = join(projectDir, CHANGES_FILE);
  if (cutOff) await truncate(path, bytes);
  await appendFile(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return entries;
}

/** The ID of the last entry, or 0 if the log is empty. */
export async function lastEntryId(projectDir: string): Promise<number> {
  return (await readEntries(projectDir)).at(-1)?.id ?? 0;
}

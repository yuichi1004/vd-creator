// Marks for what others changed since the user last reviewed. See "Marks in the UI" in
// docs/plans/0015-change-log-and-draft-audio.md. The server decides which targets are marked
// (`changedSinceReview`); this module only attaches the change entries to them for display.

import type { ChangedTarget, ChangeEntryView } from "@vd-creator/server";
import type { ApiClient } from "./client.js";
import type { Scenario } from "./types.js";

export type TargetKind = ChangedTarget["kind"];
type TargetEntry = Extract<ChangeEntryView, { target: unknown }>;

/** One change shown under a mark. */
export type ChangeDetail = {
  entry: TargetEntry;
  /** Where it came from: "changed in the file" or "changed in the UI". */
  origin: string;
  /** The reason of the entry itself, or of the `agent` entry that explains it. */
  reason?: string;
};

export type TargetMark = ChangedTarget & { details: ChangeDetail[] };

/** Marks are keyed by kind and ID, since a speaker and an item may share an ID. */
export function markKey(kind: TargetKind, id: string): string {
  return `${kind}:${id}`;
}

function isTargetEntry(entry: ChangeEntryView): entry is TargetEntry {
  return entry.source === "file" || entry.source === "ui";
}

/**
 * Fetches the entries after the last review, plus the older ones that an `agent` entry after the
 * review explains, so that a reason recorded after a review still finds its changes.
 */
export async function loadChangeEntries(client: ApiClient): Promise<ChangeEntryView[]> {
  const { entries } = await client.getChanges("review");
  const have = new Set(entries.map((e) => e.id));
  let oldest = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (entry.source !== "agent") continue;
    for (const ref of entry.refs) if (!have.has(ref)) oldest = Math.min(oldest, ref);
  }
  if (!Number.isFinite(oldest)) return entries;
  // `since` is exclusive, and the lowest ID the server accepts is 1.
  const older = (await client.getChanges(Math.max(1, oldest - 1))).entries;
  const merged = new Map<number, ChangeEntryView>();
  for (const entry of [...older, ...entries]) merged.set(entry.id, entry);
  return [...merged.values()].sort((a, b) => a.id - b.id);
}

/**
 * The marks to show: every changed target of the server, with its changes. The page's own `ui`
 * entries (`own`) never count, even if the server sent one.
 */
export function buildMarks(
  changed: readonly ChangedTarget[],
  entries: readonly ChangeEntryView[],
): Map<string, TargetMark> {
  const reasons = new Map<number, string>();
  for (const entry of entries) {
    if (entry.source !== "agent") continue;
    for (const ref of entry.refs) reasons.set(ref, entry.reason);
  }
  const marks = new Map<string, TargetMark>();
  for (const target of changed) {
    marks.set(markKey(target.kind, target.id), { ...target, details: [] });
  }
  for (const entry of entries) {
    if (!isTargetEntry(entry) || ("own" in entry && entry.own)) continue;
    const mark = marks.get(markKey(entry.target.kind, entry.target.id));
    if (!mark) continue;
    const reason = entry.reason ?? reasons.get(entry.id);
    mark.details.push({
      entry,
      origin: entry.source === "file" ? "changed in the file" : "changed in the UI",
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return marks;
}

function show(value: unknown): string {
  if (value === undefined) return "(none)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** One readable line for a change, such as `line: "Hi" → "Hello"`. */
export function describeChange(entry: TargetEntry): string {
  switch (entry.change) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "moved":
      return `moved from ${entry.from.scene ?? "the list"} #${entry.from.index + 1} to ${
        entry.to.scene ?? "the list"
      } #${entry.to.index + 1}`;
    case "edited":
      return `${entry.field}: ${show(entry.old)} → ${show(entry.new)}`;
  }
}

export type ChangeGroup = { key: string; title: string; targets: TargetMark[] };

/**
 * The "Changes" list: marked targets grouped by scene, in scene order. Removed targets and
 * drama-level changes have their own groups, and speakers and images share one.
 */
export function groupMarks(
  marks: ReadonlyMap<string, TargetMark>,
  scenario: Scenario | undefined,
): ChangeGroup[] {
  const sceneOfItem = new Map<string, string>();
  const sceneIds = new Set<string>();
  const speakers = new Set(scenario?.speakers.map((s) => s.id));
  for (const scene of scenario?.scenes ?? []) {
    sceneIds.add(scene.id);
    for (const item of scene.items) if (item.id !== undefined) sceneOfItem.set(item.id, scene.id);
  }
  const removed: TargetMark[] = [];
  const drama: TargetMark[] = [];
  const other: TargetMark[] = [];
  const byScene = new Map<string, TargetMark[]>();
  for (const mark of marks.values()) {
    const isRemoved = mark.details.some((d) => d.entry.change === "removed");
    let scene: string | undefined;
    if (mark.kind === "item") scene = sceneOfItem.get(mark.id);
    else if (mark.kind === "scene" && sceneIds.has(mark.id)) scene = mark.id;
    if (mark.kind === "drama") drama.push(mark);
    else if (isRemoved || (mark.kind === "item" && scene === undefined)) removed.push(mark);
    else if (scene !== undefined) byScene.set(scene, [...(byScene.get(scene) ?? []), mark]);
    else if (mark.kind === "speaker" && !speakers.has(mark.id)) removed.push(mark);
    else other.push(mark);
  }
  const groups: ChangeGroup[] = [];
  for (const scene of scenario?.scenes ?? []) {
    const targets = byScene.get(scene.id);
    if (targets) groups.push({ key: `scene:${scene.id}`, title: scene.title ?? scene.id, targets });
  }
  if (other.length > 0) groups.push({ key: "other", title: "Speakers and images", targets: other });
  if (removed.length > 0) groups.push({ key: "removed", title: "Removed", targets: removed });
  if (drama.length > 0) groups.push({ key: "drama", title: "Drama", targets: drama });
  return groups;
}

/** How many items and BGM have draft audio, for the header. */
export function countDraft(
  timeline: { items: { audio?: string | null }[]; bgm: { audio?: string | null }[] } | undefined,
): number {
  if (!timeline) return 0;
  return [...timeline.items, ...timeline.bgm].filter((s) => s.audio === "draft").length;
}

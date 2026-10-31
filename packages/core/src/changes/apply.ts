// The state that entries of the log describe, for recovering from a writer that stopped between
// the append and the snapshot. See "Finding file changes" in
// docs/plans/0015-change-log-and-draft-audio.md.

import {
  type ChangeEntry,
  type ChangeFields,
  type ChangeJsonValue,
  isTargetChange,
  type TargetChangeEntry,
} from "./entry.js";
import type { ChangeSnapshot, SnapshotNode, SnapshotScene } from "./snapshot.js";

/**
 * A copy of `snapshot` with the changes of `entries` applied in order, oldest first, so an ID
 * that was added and then removed is gone, and one removed and then added is back. Additions and
 * moves are placed last, in the order of their new places, so each lands where the writer saw it.
 * Entries that do not fit the snapshot are skipped.
 */
export function applyEntries(
  snapshot: ChangeSnapshot,
  entries: readonly ChangeEntry[],
): ChangeSnapshot {
  const out = structuredClone(snapshot);
  const changes = entries.filter(isTargetChange);

  /**
   * The items of removed scenes. Their own entries may still move them to another scene, since
   * scene removals come before item changes.
   */
  const orphans: SnapshotNode[] = [];

  /** The lists a target may be in: items are in the list of their scene. */
  const lists = (e: TargetChangeEntry): SnapshotNode[][] => {
    switch (e.target.kind) {
      case "speaker":
        return [out.speakers];
      case "image":
        return [out.images];
      case "scene":
        return [out.scenes];
      case "item":
        return [...out.scenes.map((s) => s.items), orphans];
      default:
        return [];
    }
  };
  const take = (e: TargetChangeEntry): SnapshotNode | undefined => {
    for (const list of lists(e)) {
      const i = list.findIndex((n) => n.id === e.target.id);
      if (i >= 0) return list.splice(i, 1)[0];
    }
    return undefined;
  };
  const find = (e: TargetChangeEntry): SnapshotNode | undefined => {
    for (const list of lists(e)) {
      const node = list.find((n) => n.id === e.target.id);
      if (node) return node;
    }
    return undefined;
  };
  const listFor = (e: TargetChangeEntry, scene: string | undefined): SnapshotNode[] | undefined =>
    e.target.kind === "item" ? out.scenes.find((s) => s.id === scene)?.items : lists(e)[0];

  // Entries are applied in order. Nodes that were added or moved wait in `placed` until all
  // entries are through, and are then inserted at their new places, scenes before items, lowest
  // place first, since an entry's place counts only the targets that stayed or came before it.
  type Placed = { e: TargetChangeEntry; node: SnapshotNode; scene?: string; index: number };
  const placed = new Map<string, Placed>();
  const key = (e: TargetChangeEntry) => `${e.target.kind}\0${e.target.id}`;
  for (const e of changes) {
    const waiting = placed.get(key(e));
    if (e.change === "removed") {
      if (waiting) placed.delete(key(e));
      else {
        const node = take(e);
        if (e.target.kind === "scene" && node && "items" in node) {
          orphans.push(...(node as SnapshotScene).items);
        }
      }
    } else if (e.change === "edited") {
      const fields = e.target.kind === "drama" ? out.drama : (waiting?.node ?? find(e))?.fields;
      if (fields) setPath(fields, e.field, e.new);
    } else if (e.change === "added") {
      const fields = structuredClone(e.fields);
      const node = (
        e.target.kind === "scene"
          ? { id: e.target.id, fields, items: [] }
          : { id: e.target.id, fields }
      ) as SnapshotNode;
      placed.set(key(e), { e, node, scene: e.to.scene, index: e.to.index });
    } else if (e.change === "moved") {
      const node = waiting?.node ?? take(e);
      if (node) placed.set(key(e), { e, node, scene: e.to.scene, index: e.to.index });
    }
  }
  const order = ["speaker", "image", "scene", "item"];
  const inOrder = [...placed.values()].sort(
    (a, b) => order.indexOf(a.e.target.kind) - order.indexOf(b.e.target.kind) || a.index - b.index,
  );
  for (const { e, node, scene, index } of inOrder) {
    const list = listFor(e, scene);
    if (list) list.splice(Math.min(index, list.length), 0, node);
  }
  return out;
}

/** Sets a dotted path to `value`, or deletes it if `value` is undefined. */
function setPath(fields: ChangeFields, path: string, value: ChangeJsonValue | undefined): void {
  const keys = path.split(".");
  let at: ChangeFields = fields;
  for (const key of keys.slice(0, -1)) {
    const next = at[key];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return;
    at = next;
  }
  const last = keys.at(-1) as string;
  if (value === undefined) delete at[last];
  else at[last] = structuredClone(value);
}

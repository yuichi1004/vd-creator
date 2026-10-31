// The comparison of two snapshots by kind, ID, and field. See "Finding file changes" in
// docs/plans/0015-change-log-and-draft-audio.md.

import {
  type ChangeDetail,
  type ChangeFields,
  type ChangeJsonValue,
  type ChangePosition,
  type ChangeTarget,
  type ChangeTargetKind,
  DRAMA_TARGET_ID,
} from "./entry.js";
import type { ChangeSnapshot, SnapshotNode } from "./snapshot.js";

/** One difference between two snapshots. */
export type TargetChange = { target: ChangeTarget } & ChangeDetail;

type Placed = SnapshotNode & { scene?: string; index: number };

/**
 * The differences from `before` to `after`, in a fixed order: the top-level fields, then
 * speakers, images, scenes, and items. Within a kind the targets come in the order of `after`,
 * with removals last. Targets are tied together by kind and ID. An item is `moved` if its scene
 * changed or it left its place among the items that stayed in the scene, so inserting or
 * removing an item does not move the ones after it.
 */
export function diffSnapshots(before: ChangeSnapshot, after: ChangeSnapshot): TargetChange[] {
  const out: TargetChange[] = [];
  out.push(...editsOf({ kind: "drama", id: DRAMA_TARGET_ID }, before.drama, after.drama));
  out.push(...diffKind("speaker", placeAll(before.speakers), placeAll(after.speakers)));
  out.push(...diffKind("image", placeAll(before.images), placeAll(after.images)));
  out.push(...diffKind("scene", placeAll(before.scenes), placeAll(after.scenes)));
  out.push(...diffKind("item", placeItems(before), placeItems(after)));
  return out;
}

function placeAll(nodes: readonly SnapshotNode[]): Placed[] {
  return nodes.map((n, index) => ({ id: n.id, fields: n.fields, index }));
}

function placeItems(snapshot: ChangeSnapshot): Placed[] {
  return snapshot.scenes.flatMap((scene) =>
    scene.items.map((n, index) => ({ id: n.id, fields: n.fields, scene: scene.id, index })),
  );
}

function position(p: Placed): ChangePosition {
  return p.scene === undefined ? { index: p.index } : { scene: p.scene, index: p.index };
}

function diffKind(kind: ChangeTargetKind, before: Placed[], after: Placed[]): TargetChange[] {
  const out: TargetChange[] = [];
  const old = new Map(before.map((p) => [p.id, p]));
  const next = new Map(after.map((p) => [p.id, p]));
  const moved = movedIds(
    before.filter((p) => next.has(p.id)),
    after.filter((p) => old.has(p.id)),
  );
  for (const now of after) {
    const target = { kind, id: now.id };
    const was = old.get(now.id);
    if (!was) {
      out.push({ target, change: "added", fields: now.fields, to: position(now) });
      continue;
    }
    out.push(...editsOf(target, was.fields, now.fields));
    if (moved.has(now.id)) {
      out.push({ target, change: "moved", from: position(was), to: position(now) });
    }
  }
  for (const was of before) {
    if (!next.has(was.id)) {
      out.push({
        target: { kind, id: was.id },
        change: "removed",
        fields: was.fields,
        from: position(was),
      });
    }
  }
  return out;
}

/**
 * The IDs that moved, among those in both lists. A target moves if its scene changed. Of the
 * rest, in each scene, those outside the longest run that keeps its order move.
 */
function movedIds(before: Placed[], after: Placed[]): Set<string> {
  const moved = new Set<string>();
  const sceneBefore = new Map(before.map((p) => [p.id, p.scene]));
  const stable = (p: Placed) => sceneBefore.get(p.id) === p.scene;
  for (const p of after) if (!stable(p)) moved.add(p.id);
  const scenes = new Set(after.filter(stable).map((p) => p.scene));
  for (const scene of scenes) {
    const a = before.filter((p) => stable(p) && p.scene === scene).map((p) => p.id);
    const b = after.filter((p) => stable(p) && p.scene === scene).map((p) => p.id);
    const kept = longestCommonSubsequence(a, b);
    for (const id of b) if (!kept.has(id)) moved.add(id);
  }
  return moved;
}

/** The members of one longest common subsequence of two lists of distinct IDs. */
function longestCommonSubsequence(a: string[], b: string[]): Set<string> {
  // length[i * width + j] is the length for the tails a[i..] and b[j..].
  const width = b.length + 1;
  const length = new Int32Array((a.length + 1) * width);
  const at = (i: number, j: number) => length[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      length[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept.add(a[i] as string);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return kept;
}

/** One `edited` change per differing field. Objects on both sides are compared key by key. */
function editsOf(target: ChangeTarget, before: ChangeFields, after: ChangeFields): TargetChange[] {
  const out: TargetChange[] = [];
  const walk = (path: string, a: ChangeJsonValue | undefined, b: ChangeJsonValue | undefined) => {
    if (isFilledObject(a) && isFilledObject(b)) return walkKeys(path, a, b);
    if (same(a, b)) return;
    const change: TargetChange = { target, change: "edited", field: path };
    if (a !== undefined) change.old = a;
    if (b !== undefined) change.new = b;
    out.push(change);
  };
  const walkKeys = (path: string, a: ChangeFields, b: ChangeFields) => {
    const keys = [...Object.keys(a), ...Object.keys(b).filter((k) => !Object.hasOwn(a, k))];
    for (const key of keys) walk(path === "" ? key : `${path}.${key}`, own(a, key), own(b, key));
  };
  walkKeys("", before, after);
  return out;
}

function own(value: ChangeFields, key: string): ChangeJsonValue | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function isFilledObject(value: ChangeJsonValue | undefined): value is ChangeFields {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

/** Whether two JSON values are equal. Key order does not matter. */
export function sameValue(a: ChangeJsonValue | undefined, b: ChangeJsonValue | undefined): boolean {
  return same(a, b);
}

function same(a: ChangeJsonValue | undefined, b: ChangeJsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => same(v, b[i]))
    );
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
  );
}

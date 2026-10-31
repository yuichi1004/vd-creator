// changes-snapshot.json: the last recorded state of the drama. See "Finding file changes" in
// docs/plans/0015-change-log-and-draft-audio.md.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Scenario } from "@vd-creator/scenario";
import { canonicalJson } from "../canonical.js";
import { type ChangeFields, type ChangeJsonValue, ChangeLogError } from "./entry.js";
import { writeFileAtomic } from "./log.js";

/** File name of the snapshot inside a project folder. */
export const SNAPSHOT_FILE = "changes-snapshot.json";
export const SNAPSHOT_VERSION = 1;

/** A speaker, image, scene, or item with its fields, without its `id`. */
export type SnapshotNode = { id: string; fields: ChangeFields };
export type SnapshotScene = SnapshotNode & { items: SnapshotNode[] };

/**
 * The top-level fields, and each speaker, image, scene, and item by ID with its fields, in
 * scenario order. `lastEntryId` is the last entry of the log when the snapshot was written; a
 * reconcile that finds entries after it knows a writer stopped before replacing the snapshot.
 */
export type ChangeSnapshot = {
  version: typeof SNAPSHOT_VERSION;
  lastEntryId: number;
  drama: ChangeFields;
  speakers: SnapshotNode[];
  images: SnapshotNode[];
  scenes: SnapshotScene[];
};

/**
 * The snapshot of a validated scenario. Defaults are filled in, so writing a default value out
 * is not a change. A pause or image item without an `id` gets one from its content, such as
 * `pause~1a2b3c4d`, with `.2` and so on for an identical one later; editing such an item is
 * therefore a removal and an addition.
 */
export function snapshotOf(scenario: Scenario, lastEntryId: number): ChangeSnapshot {
  const { speakers, images, scenes, ...drama } = scenario;
  const seen = new Map<string, number>();
  return {
    version: SNAPSHOT_VERSION,
    lastEntryId,
    drama: json(drama),
    speakers: speakers.map(node),
    images: images.map(node),
    scenes: scenes.map((scene): SnapshotScene => {
      const { items, ...rest } = scene;
      return {
        ...node(rest),
        items: items.map((item) => {
          const fields = json(withoutId(item));
          if (item.id !== undefined) return { id: item.id, fields };
          const kind = "pause" in item ? "pause" : "image";
          const base = `${kind}~${createHash("sha256").update(canonicalJson(fields)).digest("hex").slice(0, 8)}`;
          const n = (seen.get(base) ?? 0) + 1;
          seen.set(base, n);
          return { id: n === 1 ? base : `${base}.${n}`, fields };
        }),
      };
    }),
  };
}

function node(value: { id: string }): SnapshotNode {
  return { id: value.id, fields: json(withoutId(value)) };
}

function withoutId(value: object): object {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "id"));
}

/** A copy that is plain JSON: `undefined` values are dropped. */
function json(value: object): ChangeFields {
  return JSON.parse(JSON.stringify(value)) as ChangeFields;
}

/**
 * Reads `<projectDir>/changes-snapshot.json`, or returns `undefined` if it does not exist.
 * Throws a `ChangeLogError` if it cannot be read as a snapshot.
 */
export async function readSnapshot(projectDir: string): Promise<ChangeSnapshot | undefined> {
  let text: string;
  try {
    text = await readFile(join(projectDir, SNAPSHOT_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return parseSnapshot(JSON.parse(text));
  } catch (e) {
    throw new ChangeLogError(
      `${SNAPSHOT_FILE} cannot be read; delete it to start from the current scenario`,
      { cause: e },
    );
  }
}

/** Replaces the snapshot atomically. */
export async function writeSnapshot(projectDir: string, snapshot: ChangeSnapshot): Promise<void> {
  await writeFileAtomic(join(projectDir, SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Checks the shape of snapshot content. Throws an `Error` if it is wrong. */
export function parseSnapshot(data: unknown): ChangeSnapshot {
  const root = record(data, "snapshot");
  if (root.version !== SNAPSHOT_VERSION) throw new Error("unsupported version");
  if (!Number.isInteger(root.lastEntryId) || (root.lastEntryId as number) < 0) {
    throw new Error("lastEntryId must be an integer, 0 or more");
  }
  const nodes = (value: unknown, name: string): SnapshotNode[] => {
    if (!Array.isArray(value)) throw new Error(`${name} must be a list`);
    return value.map((v) => {
      const n = record(v, name);
      if (typeof n.id !== "string") throw new Error(`${name} needs an id`);
      return { id: n.id, fields: record(n.fields, `${name} fields`) as ChangeFields };
    });
  };
  const scenes = root.scenes;
  if (!Array.isArray(scenes)) throw new Error("scenes must be a list");
  return {
    version: SNAPSHOT_VERSION,
    lastEntryId: root.lastEntryId as number,
    drama: record(root.drama, "drama") as ChangeFields,
    speakers: nodes(root.speakers, "speakers"),
    images: nodes(root.images, "images"),
    scenes: scenes.map((s) => {
      const [scene] = nodes([s], "scenes");
      return { ...(scene as SnapshotNode), items: nodes(record(s, "scene").items, "items") };
    }),
  };
}

function record(value: unknown, name: string): Record<string, ChangeJsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, ChangeJsonValue>;
}

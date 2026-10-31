import { parseScenario } from "@vd-creator/scenario";
import { describe, expect, test } from "vitest";
import { applyEntries } from "./apply.js";
import { diffSnapshots } from "./diff.js";
import type { ChangeEntry } from "./entry.js";
import { type ChangeSnapshot, snapshotOf } from "./snapshot.js";

const header = `version: 1
title: Drama
speakers:
  - id: ann
    name: Ann
    voice: { provider: mock, voiceId: v1 }
`;

const line = (id: string, text = id) =>
  `      - line: ${text}\n        id: ${id}\n        speaker: ann\n`;
const scene = (id: string, ...items: string[]) =>
  `  - id: ${id}\n    items:\n${items.join("") || "      []\n"}`.replace(
    "items:\n      []\n",
    "items: []\n",
  );

function snapshot(...scenes: string[]): ChangeSnapshot {
  const { scenario } = parseScenario(`${header}scenes:\n${scenes.join("")}`);
  if (!scenario) throw new Error("invalid scenario");
  return snapshotOf(scenario, 0);
}

/** The entries a reconcile would record between two snapshots. */
function entriesBetween(before: ChangeSnapshot, after: ChangeSnapshot): ChangeEntry[] {
  return diffSnapshots(before, after).map(
    (d, i) =>
      ({ id: i + 1, time: "2026-10-31T00:00:00.000Z", source: "file", ...d }) as ChangeEntry,
  );
}

function expectRoundTrip(before: ChangeSnapshot, after: ChangeSnapshot) {
  expect(applyEntries(before, entriesBetween(before, after))).toEqual(after);
}

describe("applyEntries", () => {
  test("applying the differences of two snapshots gives the second one", () => {
    const a = snapshot(
      scene("s1", line("a"), line("b"), line("c")),
      scene("s2", line("d")),
      scene("s3"),
    );
    expectRoundTrip(
      a,
      snapshot(
        scene("s1", line("a", "A"), line("c"), line("b")),
        scene("s2", line("d")),
        scene("s3"),
      ),
    );
    expectRoundTrip(
      a,
      snapshot(scene("s1", line("a")), scene("s2", line("d")), scene("s3", line("c"), line("b"))),
    );
    expectRoundTrip(
      a,
      snapshot(
        scene("s3", line("x")),
        scene("s1", line("b"), line("a")),
        scene("s2", line("c"), line("d")),
      ),
    );
    expectRoundTrip(
      a,
      snapshot(scene("s2", line("d"), line("a")), scene("s4", line("new"), line("b"))),
    );
    expectRoundTrip(a, snapshot(scene("s1"), scene("s2"), scene("s3")));
  });

  test("an item moved to another scene lands at its new place", () => {
    const before = snapshot(scene("s1", line("a"), line("b")), scene("s2", line("c"), line("d")));
    const after = applyEntries(before, [
      {
        id: 1,
        time: "2026-10-31T00:00:00.000Z",
        source: "file",
        target: { kind: "item", id: "a" },
        change: "moved",
        from: { scene: "s1", index: 0 },
        to: { scene: "s2", index: 1 },
      },
    ]);
    expect(after.scenes.map((s) => s.items.map((i) => i.id))).toEqual([["b"], ["c", "a", "d"]]);
    expect(before.scenes[0]?.items).toHaveLength(2);
  });

  test("an added scene takes the items added to it, and a moved scene keeps its items", () => {
    const before = snapshot(scene("s1", line("a")), scene("s2", line("b")));
    const target = snapshot(scene("s2", line("b")), scene("s0", line("n")), scene("s1", line("a")));
    const result = applyEntries(before, entriesBetween(before, target));
    expect(result.scenes.map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ["s2", ["b"]],
      ["s0", ["n"]],
      ["s1", ["a"]],
    ]);
  });

  test("entries apply in order: add then remove leaves nothing, remove then add leaves it", () => {
    const before = snapshot(scene("s1", line("a")));
    const stamp = { time: "2026-10-31T00:00:00.000Z", source: "file" as const };
    const added = (id: number): ChangeEntry => ({
      id,
      ...stamp,
      target: { kind: "item", id: "x" },
      change: "added",
      fields: { line: "X", speaker: "ann" },
      to: { scene: "s1", index: 1 },
    });
    const removed = (id: number): ChangeEntry => ({
      id,
      ...stamp,
      target: { kind: "item", id: "x" },
      change: "removed",
      fields: { line: "X", speaker: "ann" },
      from: { scene: "s1", index: 1 },
    });
    const ids = (s: ChangeSnapshot) => s.scenes[0]?.items.map((i) => i.id);
    expect(ids(applyEntries(before, [added(1), removed(2)]))).toEqual(["a"]);
    expect(ids(applyEntries(before, [added(1), removed(2), added(3)]))).toEqual(["a", "x"]);
    expect(ids(applyEntries(applyEntries(before, [added(1)]), [removed(2)]))).toEqual(["a"]);
    expect(ids(applyEntries(before, [removed(1)]))).toEqual(["a"]);
  });

  test("edits reach a node that is waiting for its place, and the drama fields", () => {
    const before = snapshot(scene("s1", line("a")));
    const stamp = { time: "2026-10-31T00:00:00.000Z", source: "file" as const };
    const result = applyEntries(before, [
      {
        id: 1,
        ...stamp,
        target: { kind: "item", id: "x" },
        change: "added",
        fields: { line: "X", speaker: "ann" },
        to: { scene: "s1", index: 0 },
      },
      {
        id: 2,
        ...stamp,
        target: { kind: "item", id: "x" },
        change: "edited",
        field: "line",
        old: "X",
        new: "Y",
      },
      {
        id: 3,
        ...stamp,
        target: { kind: "drama", id: "drama" },
        change: "edited",
        field: "title",
        old: "Drama",
        new: "Drama 2",
      },
      { id: 4, time: stamp.time, source: "review" },
    ]);
    expect(result.scenes[0]?.items.map((i) => [i.id, i.fields.line])).toEqual([
      ["x", "Y"],
      ["a", "a"],
    ]);
    expect(result.drama.title).toBe("Drama 2");
  });
});

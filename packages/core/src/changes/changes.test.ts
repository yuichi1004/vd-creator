import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScenario } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type AgentEntry,
  CHANGES_FILE,
  ChangeLockError,
  ChangeLogError,
  changeEntryJsonSchema,
  entriesSince,
  LOCK_FILE,
  parseChangeEntry,
  readChanges,
  readEntries,
  readSnapshot,
  reconcile,
  reconcileLocked,
  recordAgent,
  recordReview,
  recordUiChanges,
  SNAPSHOT_FILE,
  type TargetChangeEntry,
  withProjectLock,
} from "./index.js";

const BASE = `version: 1
title: Drama
speakers:
  - id: ann
    name: Ann
    voice:
      provider: mock
      voiceId: v1
      settings:
        stability: 0.5
images:
  - id: bg
    file: bg.png
scenes:
  - id: s1
    title: One
    items:
      - line: Hello
        id: l1
        speaker: ann
      - line: World
        id: l2
        speaker: ann
      - sfx: door
        id: x1
  - id: s2
    items:
      - line: Bye
        id: l3
        speaker: ann
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-core-changes-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const scenarioPath = () => join(dir, "scenario.yaml");
const write = (text: string) => writeFile(scenarioPath(), text);
/** Writes the base scenario with `from` replaced by `to`, and checks that it changed. */
async function edit(...pairs: [string, string][]): Promise<string> {
  let text = BASE;
  for (const [from, to] of pairs) {
    expect(text).toContain(from);
    text = text.replace(from, to);
  }
  await write(text);
  return text;
}
/** Starts a project from the base scenario: the first reconcile writes the snapshot. */
async function start(): Promise<void> {
  await write(BASE);
  expect(await reconcile(dir)).toEqual({ status: "baseline" });
}
async function fileEntries(): Promise<TargetChangeEntry[]> {
  return (await readEntries(dir)).filter((e): e is TargetChangeEntry => e.source === "file");
}
const summary = (e: TargetChangeEntry) => `${e.target.kind}:${e.target.id}:${e.change}`;

describe("reconcile", () => {
  test("the first run writes the snapshot and records nothing", async () => {
    await start();
    expect(await readEntries(dir)).toEqual([]);
    expect((await readSnapshot(dir))?.scenes.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(await reconcile(dir)).toEqual({ status: "ok", entries: [] });
  });

  test("a missing scenario.yaml is reported", async () => {
    expect(await reconcile(dir)).toEqual({ status: "no-scenario" });
  });

  test("an edited field gives one entry with the old and new values", async () => {
    await start();
    await edit(["Hello", "Hello there"]);
    const result = await reconcile(dir);
    expect(result.status).toBe("ok");
    const [entry, ...rest] = await fileEntries();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      id: 1,
      source: "file",
      target: { kind: "item", id: "l1" },
      change: "edited",
      field: "line",
      old: "Hello",
      new: "Hello there",
    });
    expect(new Date(entry?.time as string).toISOString()).toBe(entry?.time);
    expect(await reconcile(dir)).toEqual({ status: "ok", entries: [] });
  });

  test("several fields of one save are one entry each, with the same time", async () => {
    await start();
    await edit(
      ["Hello", "Hello there"],
      [
        "id: l1\n        speaker: ann",
        "id: l1\n        speaker: ann\n        direction: soft\n        take: 2",
      ],
    );
    await reconcile(dir);
    const entries = await fileEntries();
    expect(entries.map((e) => (e.change === "edited" ? e.field : "")).sort()).toEqual([
      "direction",
      "line",
      "take",
    ]);
    expect(new Set(entries.map((e) => e.time)).size).toBe(1);
    expect(
      entries.find((e) => e.change === "edited" && e.field === "direction"),
    ).not.toHaveProperty("old");
    expect(entries.find((e) => e.change === "edited" && e.field === "take")).toMatchObject({
      old: 0,
      new: 2,
    });
  });

  test("writing a default value out is not a change", async () => {
    await start();
    await edit([
      "id: l1\n        speaker: ann",
      "id: l1\n        speaker: ann\n        take: 0\n        gapBeforeSec: 0.3",
    ]);
    expect(await reconcile(dir)).toEqual({ status: "ok", entries: [] });
  });

  test("a changed voice setting is an edit of the speaker", async () => {
    await start();
    await edit(["stability: 0.5", "stability: 0.8"]);
    await reconcile(dir);
    expect(await fileEntries()).toMatchObject([
      {
        target: { kind: "speaker", id: "ann" },
        change: "edited",
        field: "voice.settings.stability",
        old: 0.5,
        new: 0.8,
      },
    ]);
  });

  test("top-level fields and images are tracked", async () => {
    await start();
    await edit(
      ["title: Drama", "title: Drama 2\npublish:\n  use: commercial"],
      ["file: bg.png", "file: bg2.png"],
    );
    await reconcile(dir);
    const entries = (await fileEntries()).map((e) => [
      summary(e),
      e.change === "edited" ? e.field : "",
    ]);
    expect(entries).toEqual([
      ["drama:drama:edited", "title"],
      ["drama:drama:edited", "publish.use"],
      ["image:bg:edited", "file"],
    ]);
  });

  test("a scene field and a switch of BGM source are edits of the scene", async () => {
    await start();
    await edit(["title: One", "title: Uno\n    bgm:\n      library: rain\n      volume: 0.2"]);
    await reconcile(dir);
    expect(await fileEntries()).toMatchObject([
      {
        target: { kind: "scene", id: "s1" },
        change: "edited",
        field: "title",
        old: "One",
        new: "Uno",
      },
      {
        target: { kind: "scene", id: "s1" },
        change: "edited",
        field: "bgm",
        new: { library: "rain", volume: 0.2 },
      },
    ]);
  });

  test("an added item keeps its fields and place, and does not move the others", async () => {
    await start();
    await edit([
      "  - id: s2\n    items:\n",
      "  - id: s2\n    items:\n      - pause: 2\n        id: p1\n",
    ]);
    await reconcile(dir);
    const entries = await fileEntries();
    expect(entries).toMatchObject([
      {
        target: { kind: "item", id: "p1" },
        change: "added",
        fields: { pause: 2, gapBeforeSec: 0 },
        to: { scene: "s2", index: 0 },
      },
    ]);
  });

  test("a removed item keeps its last fields and place, and does not move the others", async () => {
    await start();
    await edit(["      - line: World\n        id: l2\n        speaker: ann\n", ""]);
    await reconcile(dir);
    expect(await fileEntries()).toMatchObject([
      {
        target: { kind: "item", id: "l2" },
        change: "removed",
        fields: { line: "World", speaker: "ann", take: 0, gapBeforeSec: 0.3 },
        from: { scene: "s1", index: 1 },
      },
    ]);
  });

  test("an item moved within a scene and one moved to another scene are moved", async () => {
    await start();
    await write(
      `${BASE.replace("      - line: Hello\n        id: l1\n        speaker: ann\n", "").replace("      - sfx: door\n        id: x1\n", "      - sfx: door\n        id: x1\n      - line: Hello\n        id: l1\n        speaker: ann\n")}`,
    );
    await reconcile(dir);
    expect(await fileEntries()).toMatchObject([
      {
        target: { kind: "item", id: "l1" },
        change: "moved",
        from: { scene: "s1", index: 0 },
        to: { scene: "s1", index: 2 },
      },
    ]);

    await write(
      BASE.replace(
        "  - id: s2\n    items:\n      - line: Bye\n        id: l3\n        speaker: ann\n",
        "  - id: s2\n    items: []\n",
      ).replace(
        "      - sfx: door\n        id: x1\n",
        "      - sfx: door\n        id: x1\n      - line: Bye\n        id: l3\n        speaker: ann\n",
      ),
    );
    await reconcile(dir);
    const last = (await fileEntries()).at(-1);
    expect(last).toMatchObject({
      target: { kind: "item", id: "l3" },
      change: "moved",
      from: { scene: "s2", index: 0 },
      to: { scene: "s1", index: 3 },
    });
  });

  test("a moved scene and a moved speaker are tracked by kind", async () => {
    await start();
    const swapped = BASE.replace(/scenes:[\s\S]*/, (scenes) => {
      const [s1, s2] = scenes.replace("scenes:\n", "").split(/(?= {2}- id: s2)/);
      return `scenes:\n${s2}${s1}`;
    });
    await write(swapped);
    await reconcile(dir);
    const entries = await fileEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ target: { kind: "scene" }, change: "moved" });
  });

  test("a speaker and an item may share an ID", async () => {
    await write(BASE.replace("id: l1", "id: ann"));
    await reconcile(dir);
    await write(BASE.replace("id: l1", "id: ann").replace("Hello", "Hi"));
    await reconcile(dir);
    expect((await fileEntries()).map(summary)).toEqual(["item:ann:edited"]);
  });

  test("a pause without an ID is told apart by its content", async () => {
    await write(BASE.replace("      - sfx: door\n", "      - pause: 1\n      - sfx: door\n"));
    await reconcile(dir);
    await write(
      BASE.replace(
        "      - sfx: door\n",
        "      - pause: 1\n      - pause: 2\n      - sfx: door\n",
      ),
    );
    await reconcile(dir);
    const entries = await fileEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.target.id).toMatch(/^pause~[0-9a-f]{8}$/);
    expect(entries[0]).toMatchObject({ change: "added", to: { scene: "s1", index: 3 } });
  });

  test("an invalid scenario records nothing and keeps the snapshot", async () => {
    await start();
    const snapshot = await readFile(join(dir, SNAPSHOT_FILE), "utf8");
    await edit(
      ["speaker: ann\n      - line: World", "speaker: nobody\n      - line: World"],
      ["title: Drama", "title:"],
    );
    const result = await reconcile(dir);
    expect(result.status).toBe("invalid");
    expect(await readEntries(dir)).toEqual([]);
    expect(await readFile(join(dir, SNAPSHOT_FILE), "utf8")).toBe(snapshot);

    // Once it validates again, the differences from the old snapshot are recorded.
    await edit(["title: Drama", "title: Drama 3"]);
    await reconcile(dir);
    expect((await fileEntries()).map(summary)).toEqual(["drama:drama:edited"]);
  });

  test("two reconciles racing on the lock record each change once", async () => {
    await start();
    await edit(["Hello", "Hello there"], ["title: Drama", "title: Drama 2"]);
    const results = await Promise.all([reconcile(dir), reconcile(dir), reconcile(dir)]);
    expect(results.map((r) => (r.status === "ok" ? r.entries.length : -1)).sort()).toEqual([
      0, 0, 2,
    ]);
    expect(await fileEntries()).toHaveLength(2);
    expect((await readEntries(dir)).map((e) => e.id)).toEqual([1, 2]);
  });

  test("a crash between the append and the snapshot does not duplicate entries", async () => {
    await start();
    const before = await readFile(join(dir, SNAPSHOT_FILE), "utf8");
    await edit(["Hello", "Hello there"], ["stability: 0.5", "stability: 0.8"]);
    await reconcile(dir);
    expect(await fileEntries()).toHaveLength(2);
    // The writer stopped before it replaced the snapshot.
    await writeFile(join(dir, SNAPSHOT_FILE), before);
    expect(await reconcile(dir)).toEqual({ status: "ok", entries: [] });
    expect(await fileEntries()).toHaveLength(2);
    expect((await readSnapshot(dir))?.lastEntryId).toBe(2);

    // A further edit after the crash is still recorded, once.
    await writeFile(join(dir, SNAPSHOT_FILE), before);
    await edit(["Hello", "Hello there"], ["stability: 0.5", "stability: 0.9"]);
    await reconcile(dir);
    expect((await fileEntries()).map((e) => (e.change === "edited" ? e.new : null))).toEqual([
      0.8,
      "Hello there",
      0.9,
    ]);
  });

  test("after a crash, a revert to the old snapshot and a later edit start from the appended entries", async () => {
    await start();
    const before = await readFile(join(dir, SNAPSHOT_FILE), "utf8");
    await edit(["Hello", "B"]);
    await reconcile(dir); // 1: A to B
    await writeFile(join(dir, SNAPSHOT_FILE), before);

    // The file went back to A: B to A is recorded.
    await write(BASE);
    await reconcile(dir);
    expect(
      (await fileEntries()).map((e) => (e.change === "edited" ? [e.old, e.new] : null)),
    ).toEqual([
      ["Hello", "B"],
      ["B", "Hello"],
    ]);

    // The same, with a further edit to C: its old value is B.
    await writeFile(join(dir, SNAPSHOT_FILE), before);
    await edit(["Hello", "C"]);
    await reconcile(dir);
    const last = (await fileEntries()).at(-1);
    expect(last).toMatchObject({ field: "line", old: "Hello", new: "C" });
  });

  test("recovery applies added, removed, and moved entries too", async () => {
    await start();
    const before = await readFile(join(dir, SNAPSHOT_FILE), "utf8");
    await write(
      BASE.replace("      - line: World\n        id: l2\n        speaker: ann\n", "").replace(
        "  - id: s2\n    items:\n",
        "  - id: s2\n    items:\n      - pause: 2\n        id: p1\n",
      ),
    );
    await reconcile(dir);
    const count = (await readEntries(dir)).length;
    await writeFile(join(dir, SNAPSHOT_FILE), before);
    expect(await reconcile(dir)).toEqual({ status: "ok", entries: [] });
    expect(await readEntries(dir)).toHaveLength(count);
    // Back to the base: the removal and the addition are undone, each once.
    await write(BASE);
    await writeFile(join(dir, SNAPSHOT_FILE), before);
    await reconcile(dir);
    expect((await fileEntries()).slice(count).map(summary)).toEqual([
      "item:l2:added",
      "item:p1:removed",
    ]);
  });

  test("a UI change is recorded as ui, and not again as a file change", async () => {
    await start();
    await edit(["Hello", "Agent edit"]);
    await withProjectLock(dir, async () => {
      // The agent's edit is recorded as a file change before the UI change goes on top of it.
      await reconcileLocked(dir);
      const text = (await readFile(scenarioPath(), "utf8")).replace("World", "From the phone");
      await write(text);
      const { scenario } = parseScenario(text);
      const entries = await recordUiChanges(dir, scenario as never, { session: "page-1" });
      expect(entries).toMatchObject([
        {
          source: "ui",
          session: "page-1",
          target: { id: "l2" },
          field: "line",
          new: "From the phone",
        },
      ]);
    });
    expect(await reconcile(dir)).toEqual({ status: "ok", entries: [] });
    expect((await readEntries(dir)).map((e) => [e.source, e.id])).toEqual([
      ["file", 1],
      ["ui", 2],
    ]);
  });
});

describe("agent entries", () => {
  test("a reason refers to file entries already recorded by an earlier reconcile", async () => {
    await start();
    await edit(["Hello", "Hello there"]);
    await reconcile(dir);
    await edit(["Hello", "Hello there"], ["title: Drama", "title: Drama 2"]);
    const { entry, reconcile: result } = await recordAgent(dir, "Reworded the opening");
    expect(result.status).toBe("ok");
    expect(entry).toMatchObject({
      id: 3,
      source: "agent",
      reason: "Reworded the opening",
      refs: [1, 2],
    });
    expect((await readEntries(dir)).at(-1)).toEqual(entry);
  });

  test("--items limits the refs, and a later plain record explains the rest", async () => {
    await start();
    await edit(["Hello", "Hi"], ["World", "Earth"]);
    const first = await recordAgent(dir, "Only the first", { items: ["l1"] });
    expect(first.entry.refs).toEqual([1]);
    const second = await recordAgent(dir, "The rest");
    expect(second.entry.refs).toEqual([2]);
    const third = await recordAgent(dir, "Nothing new");
    expect(third.entry.refs).toEqual([]);
  });

  test("--items names items only, not a speaker with the same ID", async () => {
    const same = BASE.replace("id: l1", "id: ann");
    await write(same);
    expect(await reconcile(dir)).toEqual({ status: "baseline" });
    await write(same.replace("name: Ann", "name: Anne").replace("Hello", "Hi"));
    const first = await recordAgent(dir, "The item", { items: ["ann"] });
    expect(first.entry.refs).toHaveLength(1);
    const second = await recordAgent(dir, "The rest");
    expect(second.entry.refs).toHaveLength(1);
    const targets = (await fileEntries()).map((e) => e.target.kind);
    expect(first.entry.refs.map((r) => targets[r - 1])).toEqual(["item"]);
    expect(second.entry.refs.map((r) => targets[r - 1])).toEqual(["speaker"]);
  });

  test("ui entries are not explained, and the reason is checked", async () => {
    await start();
    await expect(recordAgent(dir, " ")).rejects.toThrow(ChangeLogError);
    await expect(recordAgent(dir, "x".repeat(301))).rejects.toThrow(ChangeLogError);
    expect((await recordAgent(dir, "x".repeat(300))).entry.refs).toEqual([]);
  });

  test("a reason is recorded while the scenario is invalid", async () => {
    await start();
    await write("version: 1\n");
    const { entry, reconcile: result } = await recordAgent(dir, "Work in progress");
    expect(result.status).toBe("invalid");
    expect(entry.refs).toEqual([]);
  });
});

describe("the log file", () => {
  test("a cut-off last line is skipped, and removed by the next append", async () => {
    await start();
    await edit(["Hello", "Hi"]);
    await reconcile(dir);
    const path = join(dir, CHANGES_FILE);
    await appendFile(path, '{"id":2,"time":"2026-10-31T00:00:00.000Z","sour');
    expect(await readEntries(dir)).toHaveLength(1);

    await recordReview(dir);
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain('"sour"');
    expect(text.trimEnd().split("\n")).toHaveLength(2);
    expect((await readEntries(dir)).map((e) => [e.id, e.source])).toEqual([
      [1, "file"],
      [2, "review"],
    ]);
  });

  test("a complete line that is not an entry is an error", async () => {
    await writeFile(join(dir, CHANGES_FILE), '{"id":1}\n');
    await expect(readEntries(dir)).rejects.toThrow(ChangeLogError);
  });

  test("since filters by entry ID, by time, by the last review, and by the last agent entry", async () => {
    await start();
    let n = 0;
    const tick = () => new Date(Date.UTC(2026, 9, 31, 0, 0, ++n));
    await edit(["Hello", "A"]);
    await reconcile(dir, { now: tick }); // 1
    await edit(["Hello", "B"]);
    await reconcile(dir, { now: tick }); // 2
    await recordReview(dir, { now: tick }); // 3
    await edit(["Hello", "C"]);
    await reconcile(dir, { now: tick }); // 4
    await recordAgent(dir, "Why", { now: tick }); // 5
    await edit(["Hello", "D"]);
    await reconcile(dir, { now: tick }); // 6

    const ids = async (since: Parameters<typeof readChanges>[1] = {}) =>
      (await readChanges(dir, since)).map((e) => e.id);
    expect(await ids()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await ids({ since: "start" })).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await ids({ since: { id: 2 } })).toEqual([3, 4, 5, 6]);
    expect(await ids({ since: "review" })).toEqual([4, 5, 6]);
    expect(await ids({ since: "agent" })).toEqual([6]);
    expect(await ids({ since: { time: "2026-10-31T00:00:03.000Z" } })).toEqual([4, 5, 6]);
    expect(await ids({ source: "file" })).toEqual([1, 2, 4, 6]);
    expect(await ids({ since: "review", source: ["agent", "review"] })).toEqual([5]);
    expect(entriesSince([], "review")).toEqual([]);
    expect(() => entriesSince([], { time: "yesterday" })).toThrow(ChangeLogError);
    const agent = (await readEntries(dir)).find((e) => e.source === "agent") as AgentEntry;
    expect(agent.refs).toEqual([1, 2, 4]);
  });
});

describe("the project lock", () => {
  test("a lock of a process that no longer runs is taken over", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeFile(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: dead, time: new Date().toISOString(), token: "old" }),
    );
    expect(await withProjectLock(dir, async () => "ran", { waitMs: 1000 })).toBe("ran");
    await expect(readFile(join(dir, LOCK_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a lock older than the limit is taken over, and a fresh one is waited for", async () => {
    const lock = (time: Date) =>
      writeFile(
        join(dir, LOCK_FILE),
        JSON.stringify({ pid: process.pid, time: time.toISOString(), token: "other" }),
      );
    await lock(new Date(Date.now() - 31_000));
    expect(await withProjectLock(dir, async () => "ran", { waitMs: 1000 })).toBe("ran");

    await lock(new Date());
    await expect(withProjectLock(dir, async () => "ran", { waitMs: 100 })).rejects.toThrow(
      ChangeLockError,
    );
    // The lock of the other holder stays.
    expect(await readFile(join(dir, LOCK_FILE), "utf8")).toContain('"other"');
  });

  test("releasing goes through the gate, so a takeover in progress cannot lose the lock", async () => {
    const gate = join(dir, `${LOCK_FILE}.break`);
    let release: () => void = () => {};
    const done = withProjectLock(dir, async () => {
      // Someone is breaking a lock: the holder must not remove the lock file meanwhile.
      await writeFile(gate, "");
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(await readFile(join(dir, LOCK_FILE), "utf8")).toContain('"token"');
    let finished = false;
    done.then(() => {
      finished = true;
      release();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(finished).toBe(false);
    await rm(gate);
    await new Promise<void>((r) => {
      release = r;
    });
    await expect(readFile(join(dir, LOCK_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a stale lock replaced during a release is not removed by the old holder", async () => {
    const path = join(dir, LOCK_FILE);
    await withProjectLock(
      dir,
      async () => {
        // The lock is taken over while the first holder still runs.
        await rm(path);
        await writeFile(
          path,
          JSON.stringify({ pid: process.pid, time: new Date().toISOString(), token: "new" }),
        );
      },
      { waitMs: 1000 },
    );
    expect(await readFile(path, "utf8")).toContain('"new"');
  });

  test("the lock is released when the work throws, and holders run one at a time", async () => {
    await expect(
      withProjectLock(dir, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    let running = 0;
    let overlap = false;
    await Promise.all(
      [1, 2, 3].map(() =>
        withProjectLock(dir, async () => {
          if (++running > 1) overlap = true;
          await new Promise((r) => setTimeout(r, 20));
          running--;
        }),
      ),
    );
    expect(overlap).toBe(false);
  });
});

describe("entries", () => {
  const stamp = { id: 1, time: "2026-10-31T00:00:00.000Z" };

  test("the checker accepts every kind of entry and rejects wrong ones", () => {
    const good = [
      {
        ...stamp,
        source: "file",
        target: { kind: "item", id: "l1" },
        change: "edited",
        field: "line",
        old: "a",
        new: "b",
      },
      {
        ...stamp,
        source: "file",
        target: { kind: "item", id: "l1" },
        change: "added",
        fields: { line: "a" },
        to: { scene: "s1", index: 0 },
      },
      {
        ...stamp,
        source: "ui",
        session: "p",
        reason: "why",
        target: { kind: "scene", id: "s1" },
        change: "removed",
        fields: {},
        from: { index: 1 },
      },
      {
        ...stamp,
        source: "ui",
        target: { kind: "drama", id: "drama" },
        change: "moved",
        from: { index: 0 },
        to: { index: 1 },
      },
      { ...stamp, source: "agent", reason: "why", refs: [1] },
      { ...stamp, source: "review" },
    ];
    for (const entry of good) expect(parseChangeEntry(entry)).toBe(entry);
    const bad = [
      { ...stamp, source: "nobody" },
      { ...stamp, id: 0, source: "review" },
      { ...stamp, time: "later", source: "review" },
      { ...stamp, time: "2026-10-31", source: "review" },
      { ...stamp, time: "2026-10-31T00:00:00", source: "review" },
      { ...stamp, time: "Oct 31 2026 00:00:00 GMT", source: "review" },
      { ...stamp, source: "review", extra: 1 },
      { ...stamp, source: "agent", reason: "why" },
      { ...stamp, source: "agent", reason: "x".repeat(301), refs: [] },
      {
        ...stamp,
        source: "file",
        session: "p",
        target: { kind: "item", id: "a" },
        change: "edited",
        field: "x",
      },
      {
        ...stamp,
        source: "file",
        target: { kind: "thing", id: "a" },
        change: "edited",
        field: "x",
      },
      { ...stamp, source: "file", target: { kind: "item", id: "a" }, change: "edited" },
      { ...stamp, source: "file", target: { kind: "item", id: "a" }, change: "added", fields: {} },
      {
        ...stamp,
        source: "file",
        target: { kind: "item", id: "a" },
        change: "moved",
        from: { index: -1 },
        to: { index: 0 },
      },
    ];
    for (const entry of bad) expect(() => parseChangeEntry(entry)).toThrow(ChangeLogError);
  });

  test("the JSON Schema agrees with the reader on time and session", () => {
    const schema = changeEntryJsonSchema() as {
      oneOf: {
        properties: { time: { format?: string }; session?: unknown };
        if?: unknown;
        then?: { properties: { source: { const: string } } };
      }[];
    };
    for (const branch of schema.oneOf) expect(branch.properties.time.format).toBe("date-time");
    // A session is allowed on ui entries only, as in the reader.
    const targetBranches = schema.oneOf.filter((b) => b.properties.session);
    expect(targetBranches).toHaveLength(4);
    for (const b of targetBranches) {
      expect(b.if).toEqual({ required: ["session"] });
      expect(b.then?.properties.source.const).toBe("ui");
    }
    const entry = {
      id: 1,
      time: "2026-10-31T00:00:00.000Z",
      target: { kind: "item", id: "a" },
      change: "edited",
      field: "line",
      session: "p",
    };
    expect(parseChangeEntry({ ...entry, source: "ui" })).toBeTruthy();
    expect(() => parseChangeEntry({ ...entry, source: "file" })).toThrow(ChangeLogError);
  });

  test("the JSON Schema describes the six shapes of entry", () => {
    const schema = changeEntryJsonSchema() as { oneOf: { properties: Record<string, unknown> }[] };
    expect(schema.oneOf).toHaveLength(6);
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    const changes = schema.oneOf.map(
      (o) => (o.properties.change as { const: string } | undefined)?.const,
    );
    expect(changes.slice(0, 4)).toEqual(["added", "removed", "moved", "edited"]);
  });
});

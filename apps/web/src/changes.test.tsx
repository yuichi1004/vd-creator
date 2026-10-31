import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseScenario } from "@vd-creator/scenario";
import type { ChangedTarget, ChangeEntryView } from "@vd-creator/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { buildMarks, countDraft, groupMarks, loadChangeEntries, markKey } from "./changes.js";
import { ApiClient } from "./client.js";
import { ChangesPanel } from "./components/Changes.js";
import { SceneList } from "./components/SceneList.js";
import type { Scenario, Timeline } from "./types.js";

const SAMPLE = fileURLToPath(
  new URL("../../../packages/scenario/fixtures/sample.yaml", import.meta.url),
);

const PREFIX = "http://host.example/";

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function sample(): Promise<Scenario> {
  const { scenario } = parseScenario(await readFile(SAMPLE, "utf8"));
  if (!scenario) throw new Error("the sample is not valid");
  return scenario as Scenario;
}

function firstLineId(scenario: Scenario): string {
  for (const scene of scenario.scenes) {
    for (const item of scene.items) if ("line" in item) return item.id;
  }
  throw new Error("no line in the sample");
}

const noop = () => {};

function renderList(scenario: Scenario, timeline: Timeline, marks: ReturnType<typeof buildMarks>) {
  return renderToStaticMarkup(
    <SceneList
      scenario={scenario}
      timeline={timeline}
      issues={new Map()}
      generating={new Set()}
      currentItemId={undefined}
      isPhone={false}
      hasLibrary={false}
      libraryTarget={undefined}
      marks={marks}
      onPatchItem={async () => true}
      onPatchScene={async () => true}
      onRegenerate={noop}
      onGenerate={noop}
      onPlayFrom={noop}
      onEditLine={noop}
      onOpenLibrary={noop}
    />,
  );
}

const emptyTimeline: Timeline = { items: [], images: [], bgm: [], scenes: [], durationSec: 0 };

function fileEdit(id: number, itemId: string): ChangeEntryView {
  return {
    id,
    time: "2026-10-31T09:00:00.000Z",
    source: "file",
    target: { kind: "item", id: itemId },
    change: "edited",
    field: "line",
    old: "Before",
    new: "After",
  };
}

describe("marks", () => {
  test("instructions to the agent and their outcomes add no detail to a mark", () => {
    const target = { kind: "item", id: "l1" } as const;
    const time = "2026-10-31T09:00:00.000Z";
    const entries: ChangeEntryView[] = [
      fileEdit(1, "l1"),
      {
        id: 2,
        time,
        source: "ui",
        target,
        change: "instruction",
        instructionId: "i1",
        text: "Softer",
      },
      {
        id: 3,
        time,
        source: "ui",
        target,
        change: "instruction-outcome",
        instructionId: "i1",
        outcome: "proposed",
      },
    ];
    const marks = buildMarks([{ kind: "item", id: "l1", count: 1 }], entries);
    expect(marks.get(markKey("item", "l1"))?.details).toHaveLength(1);
  });

  test("a file change shows its mark, and its details show the old and new value and reason", () => {
    const changed: ChangedTarget[] = [{ kind: "item", id: "l1", count: 1 }];
    const entries: ChangeEntryView[] = [
      fileEdit(4, "l1"),
      {
        id: 5,
        time: "2026-10-31T09:01:00.000Z",
        source: "agent",
        reason: "Shorter for the radio",
        refs: [4],
      },
    ];
    const marks = buildMarks(changed, entries);
    const mark = marks.get(markKey("item", "l1"));
    expect(mark?.details).toHaveLength(1);
    expect(mark?.details[0]?.origin).toBe("changed in the file");
    expect(mark?.details[0]?.reason).toBe("Shorter for the radio");

    // The panel lists the details, always open.
    const panel = text(
      renderToStaticMarkup(
        <ChangesPanel groups={groupMarks(marks, undefined)} busy={false} onMarkReviewed={noop} />,
      ),
    );
    expect(panel).toContain("changed in the file");
    expect(panel).toContain("line: Before → After");
    expect(panel).toContain("Reason: Shorter for the radio");
  });

  test("a scene list shows the mark on the changed item only", async () => {
    const scenario = await sample();
    const id = firstLineId(scenario);
    const marks = buildMarks([{ kind: "item", id, count: 1 }], [fileEdit(1, id)]);
    const markup = renderList(scenario, emptyTimeline, marks);
    expect(markup.match(/class="changed-mark"/g)).toHaveLength(1);
    expect(markup).toContain(`aria-label="changed: ${id}"`);
    expect(renderList(scenario, emptyTimeline, new Map())).not.toContain("changed-mark");
  });

  test("the page's own changes are not marked", () => {
    const own: ChangeEntryView = {
      id: 2,
      time: "2026-10-31T09:00:00.000Z",
      source: "ui",
      own: true,
      target: { kind: "item", id: "l2" },
      change: "edited",
      field: "take",
      old: 0,
      new: 1,
    };
    // The server leaves the page's own changes out of `changedSinceReview`, and details never
    // include an own entry even where the target is marked for another reason.
    expect(buildMarks([], [own]).size).toBe(0);
    const marks = buildMarks([{ kind: "item", id: "l2", count: 1 }], [own, fileEdit(3, "l2")]);
    expect(marks.get(markKey("item", "l2"))?.details.map((d) => d.entry.id)).toEqual([3]);
  });

  test("a speaker and an item with the same ID are marked apart", () => {
    const marks = buildMarks([{ kind: "speaker", id: "x", count: 1 }], [fileEdit(1, "x")]);
    expect(marks.get(markKey("item", "x"))).toBeUndefined();
    expect(marks.get(markKey("speaker", "x"))?.details).toHaveLength(0);
  });

  test("groups follow the scenes, with removed targets and the drama apart", async () => {
    const scenario = await sample();
    const id = firstLineId(scenario);
    const sceneId = scenario.scenes[0]?.id ?? "";
    const removed: ChangeEntryView = {
      id: 2,
      time: "2026-10-31T09:00:00.000Z",
      source: "file",
      target: { kind: "item", id: "gone" },
      change: "removed",
      fields: { line: "Bye" },
      from: { scene: sceneId, index: 0 },
    };
    const marks = buildMarks(
      [
        { kind: "item", id, count: 1 },
        { kind: "item", id: "gone", count: 1 },
        { kind: "drama", id: "drama", count: 1 },
      ],
      [fileEdit(1, id), removed],
    );
    const groups = groupMarks(marks, scenario);
    expect(groups.map((g) => g.key)).toEqual([`scene:${sceneId}`, "removed", "drama"]);
  });

  test("a reason that refers to entry 1 loads the log from its start", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return json(
        url.endsWith("since=review")
          ? {
              entries: [
                {
                  id: 3,
                  time: "2026-10-31T10:00:00.000Z",
                  source: "agent",
                  reason: "Why",
                  refs: [1],
                },
              ],
            }
          : { entries: [fileEdit(1, "l1"), fileEdit(2, "l2")] },
      );
    };
    const entries = await loadChangeEntries(new ApiClient(PREFIX, fetchImpl));
    expect(calls).toEqual([
      `${PREFIX}api/changes?since=review`,
      `${PREFIX}api/changes?since=start`,
    ]);
    const marks = buildMarks([{ kind: "item", id: "l1", count: 1 }], entries);
    expect(marks.get(markKey("item", "l1"))?.details[0]?.reason).toBe("Why");
  });

  test("older entries that a later reason explains are loaded too", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return json(
        url.endsWith("since=review")
          ? {
              entries: [
                {
                  id: 9,
                  time: "2026-10-31T10:00:00.000Z",
                  source: "agent",
                  reason: "r",
                  refs: [4],
                },
              ],
            }
          : { entries: [fileEdit(4, "l1"), fileEdit(5, "l1")] },
      );
    };
    const client = new ApiClient(PREFIX, fetchImpl);
    const entries = await loadChangeEntries(client);
    expect(calls).toEqual([`${PREFIX}api/changes?since=review`, `${PREFIX}api/changes?since=3`]);
    expect(entries.map((e) => e.id)).toEqual([4, 5, 9]);
  });
});

describe("Mark all reviewed", () => {
  test("sends one request and the answer has no marks", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return json({ issues: [], licenseIssues: [], changedSinceReview: [] });
    };
    const client = new ApiClient(PREFIX, fetchImpl, "abc123");
    const project = await client.markReviewed();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${PREFIX}api/changes/review`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(project.changedSinceReview).toEqual([]);
    expect(buildMarks(project.changedSinceReview, []).size).toBe(0);
  });

  test("the panel has the button", () => {
    const markup = renderToStaticMarkup(
      <ChangesPanel groups={[]} busy={false} onMarkReviewed={noop} />,
    );
    expect(text(markup)).toContain("Mark all reviewed");
  });
});

describe("session ID", () => {
  test("every request carries X-VD-Session, and it is random per client", async () => {
    const seen: (HeadersInit | undefined)[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers);
      return json({ ok: true });
    };
    const client = new ApiClient(PREFIX, fetchImpl);
    await client.getProject();
    await client.patchItem("l1", { take: 2 });
    for (const headers of seen) {
      expect((headers as Record<string, string>)["X-VD-Session"]).toBe(client.sessionId);
    }
    expect(client.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(new ApiClient(PREFIX).sessionId).not.toBe(client.sessionId);
  });
});

describe("draft audio", () => {
  test("draft items show the badge, final ones do not, and the header counts them", async () => {
    const scenario = await sample();
    const id = firstLineId(scenario);
    const sceneId = scenario.scenes[0]?.id ?? "";
    const index = scenario.scenes[0]?.items.findIndex((i) => i.id === id) ?? 0;
    const timeline = (audio: "draft" | "final"): Timeline => ({
      ...emptyTimeline,
      items: [
        {
          kind: "line",
          sceneId,
          index,
          startSec: 0,
          durationSec: 1,
          file: "a.mp3",
          audio,
        } as Timeline["items"][number],
      ],
    });
    const draft = renderList(scenario, timeline("draft"), new Map());
    expect(draft.match(/status draft/g)).toHaveLength(1);
    expect(renderList(scenario, timeline("final"), new Map())).not.toContain("status draft");
    expect(countDraft(timeline("draft"))).toBe(1);
    expect(countDraft(timeline("final"))).toBe(0);
    expect(countDraft(undefined)).toBe(0);
  });
});

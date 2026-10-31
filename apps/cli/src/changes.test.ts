// Tests of vd changes, vd changes record, and vd clean's keeping of the change log.

import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEntries, recordReview } from "@vd-creator/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from "./index.js";

let tmp: string;
let dir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vd-cli-changes-"));
  dir = join(tmp, "drama");
  expect((await vd("init", dir)).code).toBe(EXIT_OK);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function vd(...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    { HOME: join(tmp, "home"), PATH: process.env.PATH ?? "" },
    { repoRoot: tmp },
  );
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

async function editScenario(from: string, to: string) {
  const file = join(dir, "scenario.yaml");
  const text = await readFile(file, "utf8");
  expect(text).toContain(from);
  await writeFile(file, text.replace(from, to));
}

/** Records the baseline, so that later edits of the file are changes. */
async function baseline() {
  expect(await vd("changes", dir)).toMatchObject({ code: EXIT_OK, stdout: "No changes." });
}

describe("vd changes", () => {
  test("records nothing on the first run, then lists file changes", async () => {
    await baseline();
    await editScenario("Once upon a time...", "Long ago...");
    const result = await vd("changes", dir);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(
      /^#1 \S+ file: item "s1-l1" edited line: "Once upon a time\.\.\." -> "Long ago\.\.\."$/,
    );
  });

  test("lists entries since the last agent entry, even after a review entry", async () => {
    await baseline();
    await editScenario("Once upon a time...", "Long ago...");
    expect((await vd("changes", "record", dir, "--reason", "Reworded the opening")).code).toBe(
      EXIT_OK,
    );
    // The user edits in the UI, which writes the file and the entry, then marks it reviewed.
    await editScenario("Long ago...", "Once more...");
    await appendEntries(dir, [
      {
        source: "ui",
        target: { kind: "item", id: "s1-l1" },
        change: "edited",
        field: "line",
        old: "Long ago...",
        new: "Once more...",
        session: "phone",
      },
    ]);
    await recordReview(dir);

    const result = await vd("changes", dir);
    expect(result.code).toBe(EXIT_OK);
    const lines = result.stdout.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^#3 \S+ ui: item "s1-l1" edited line: "Long ago\.\.\." -> "Once more\.\.\."$/,
    );
    expect(lines[1]).toMatch(/^#4 \S+ review: marked reviewed$/);

    // After the next record, nothing is new except that record.
    expect((await vd("changes", "record", dir, "--reason", "Kept the user's wording")).code).toBe(
      EXIT_OK,
    );
    expect((await vd("changes", dir)).stdout).toBe("No changes.");
  });

  test("--since and --source choose the entries", async () => {
    await baseline();
    await editScenario("Once upon a time...", "Long ago...");
    expect((await vd("changes", "record", dir, "--reason", "Reworded")).code).toBe(EXIT_OK);
    const all = await vd("changes", dir, "--since", "start");
    expect(all.stdout.split("\n")).toHaveLength(2);
    expect((await vd("changes", dir, "--since", "1")).stdout).toMatch(
      /^#2 \S+ agent: "Reworded" \(explains #1\)$/,
    );
    expect((await vd("changes", dir, "--since", "start", "--source", "file")).stdout).toMatch(
      /^#1 /,
    );
    expect((await vd("changes", dir, "--since", "yesterday-ish")).code).toBe(EXIT_USAGE);
    // A time needs a zone, so the result does not depend on the machine's.
    const zoneless = await vd("changes", dir, "--since", "2026-10-31T09:00:00");
    expect(zoneless.code).toBe(EXIT_USAGE);
    expect(zoneless.stderr).toContain("ISO 8601 time with a time zone");
    expect((await vd("changes", dir, "--since", "2000-01-01T00:00:00Z")).code).toBe(EXIT_OK);
    expect((await vd("changes", dir, "--since", "2000-01-01T09:00:00+09:00")).code).toBe(EXIT_OK);
    expect((await vd("changes", dir, "--source", "robot")).code).toBe(EXIT_USAGE);
  });

  test("prints long and multi-line values in full, on one line", async () => {
    await baseline();
    const long = "word ".repeat(40).trim();
    await editScenario("Once upon a time...", long);
    const result = await vd("changes", dir);
    expect(long.length).toBeGreaterThan(80);
    expect(result.stdout).toContain(`-> ${JSON.stringify(long)}`);
    expect(result.stdout).not.toContain("…");

    // A YAML escape in a double-quoted string makes a real newline in the value.
    await editScenario(long, "first\\nsecond");
    const multi = (await vd("changes", dir, "--since", "1")).stdout;
    expect(multi.split("\n")).toHaveLength(1);
    expect(multi).toContain(`${JSON.stringify(long)} -> "first\\nsecond"`);
  });

  test("prints the fields of added and removed items", async () => {
    await baseline();
    const fields = {
      line: "A new line, quite a long one so that the whole value is past 80 characters.",
      speaker: "narrator",
    };
    await appendEntries(dir, [
      {
        source: "file",
        target: { kind: "item", id: "s1-l9" },
        change: "added",
        fields,
        to: { scene: "s1", index: 1 },
      },
      {
        source: "file",
        target: { kind: "item", id: "s1-l9" },
        change: "removed",
        fields,
        from: { scene: "s1", index: 1 },
      },
    ]);
    const lines = (await vd("changes", dir)).stdout.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/item "s1-l9" added at s1 #2: /);
    expect(lines[0]).toContain(JSON.stringify(fields));
    expect(lines[1]).toMatch(/item "s1-l9" removed from s1 #2: /);
    expect(lines[1]).toContain(JSON.stringify(fields));
  });

  test("--json prints the entries", async () => {
    await baseline();
    await editScenario("Once upon a time...", "Long ago...");
    const result = await vd("changes", dir, "--json");
    expect(result.code).toBe(EXIT_OK);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({
        id: 1,
        source: "file",
        target: { kind: "item", id: "s1-l1" },
        change: "edited",
        field: "line",
        old: "Once upon a time...",
        new: "Long ago...",
      }),
    ]);
  });

  test("warns when the scenario does not validate, and records nothing", async () => {
    await baseline();
    await editScenario("speaker: narrator", "speaker: nobody");
    const result = await vd("changes", dir);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toContain("does not validate");
    expect(result.stdout).toBe("No changes.");
  });
});

describe("vd changes record", () => {
  test("explains edits that the server already recorded", async () => {
    await baseline();
    // The server saw the agent's edit while the agent was still working, and recorded it.
    await editScenario("Once upon a time...", "Long ago...");
    expect((await vd("changes", dir)).stdout).toContain("edited line");

    const result = await vd("changes", "record", dir, "--reason", "Reworded the opening");
    expect(result).toMatchObject({
      code: EXIT_OK,
      stdout: "Recorded #2, which explains 1 change in the file",
    });
    const [, agent] = JSON.parse((await vd("changes", dir, "--since", "start", "--json")).stdout);
    expect(agent).toMatchObject({
      id: 2,
      source: "agent",
      refs: [1],
      reason: "Reworded the opening",
    });
  });

  test("--items explains only those items", async () => {
    await baseline();
    await editScenario("Once upon a time...", "Long ago...");
    await editScenario("title: Opening", "title: Start");
    const none = await vd("changes", "record", dir, "--reason", "Nothing yet", "--items", "other");
    // The edits are #1 and #2, and the record is #3. A later plain record still explains the rest.
    expect(none.stdout).toBe("Recorded #3, which explains 0 changes in the file");
    const some = await vd("changes", "record", dir, "--reason", "The line", "--items", "s1-l1");
    expect(some.stdout).toBe("Recorded #4, which explains 1 change in the file");
    const rest = await vd("changes", "record", dir, "--reason", "The scene");
    expect(rest.stdout).toBe("Recorded #5, which explains 1 change in the file");
  });

  test("needs a reason of up to 300 characters", async () => {
    expect((await vd("changes", "record", dir)).code).toBe(EXIT_USAGE);
    expect((await vd("changes", "record", dir, "--reason", " ")).code).toBe(EXIT_USAGE);
    const long = await vd("changes", "record", dir, "--reason", "x".repeat(301));
    expect(long.code).toBe(EXIT_FAILURE);
    expect(long.stderr).toContain("300 characters");
  });

  test("rejects options of the other command", async () => {
    expect((await vd("changes", dir, "--reason", "why")).code).toBe(EXIT_USAGE);
    expect((await vd("changes", "record", dir, "--reason", "why", "--json")).code).toBe(EXIT_USAGE);
    expect((await vd("changes", dir, "extra")).code).toBe(EXIT_USAGE);
  });
});

describe("vd clean", () => {
  test("keeps changes.jsonl and changes-snapshot.json", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    await baseline();
    await editScenario("Once upon a time...", "Long ago...");
    expect((await vd("changes", "record", dir, "--reason", "Reworded")).code).toBe(EXIT_OK);
    const log = await readFile(join(dir, "changes.jsonl"), "utf8");
    const snapshot = await readFile(join(dir, "changes-snapshot.json"), "utf8");

    // The old line's asset is now unused, so clean has something to remove.
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_OK);
    await access(join(dir, "changes.jsonl"));
    await access(join(dir, "changes-snapshot.json"));
    expect(await readFile(join(dir, "changes.jsonl"), "utf8")).toBe(log);
    expect(await readFile(join(dir, "changes-snapshot.json"), "utf8")).toBe(snapshot);
  });
});

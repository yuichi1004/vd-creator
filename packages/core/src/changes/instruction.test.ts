import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyEntries } from "./apply.js";
import { ChangeLogError, isInstructionEntry, isTargetChange, parseChangeEntry } from "./entry.js";
import {
  findInstruction,
  outcomesOf,
  recordInstruction,
  recordInstructionOutcome,
} from "./instruction.js";
import { readEntries } from "./log.js";
import type { ChangeSnapshot } from "./snapshot.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-core-instruction-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const instruction = (id = "i1", text = "Make it softer") => ({
  instructionId: id,
  itemId: "s1-l1",
  text,
});

describe("recordInstruction", () => {
  test("appends an entry that marks no change", async () => {
    const entry = await recordInstruction(dir, instruction());
    expect(entry).toMatchObject({
      source: "ui",
      target: { kind: "item", id: "s1-l1" },
      change: "instruction",
      instructionId: "i1",
      text: "Make it softer",
    });
    const entries = await readEntries(dir);
    expect(entries).toHaveLength(1);
    expect(isInstructionEntry(entries[0] as never)).toBe(true);
    expect(isTargetChange(entries[0] as never)).toBe(false);
    expect(findInstruction(entries, "i1")).toBeDefined();
    expect(findInstruction(entries, "other")).toBeUndefined();
  });

  test("refuses empty and long text, and a used ID, writing nothing", async () => {
    await expect(recordInstruction(dir, instruction("i1", "  "))).rejects.toThrow(ChangeLogError);
    await expect(recordInstruction(dir, instruction("i1", "x".repeat(1001)))).rejects.toThrow(
      ChangeLogError,
    );
    expect(await readEntries(dir)).toEqual([]);
    await recordInstruction(dir, instruction("i1", "x".repeat(1000)));
    await expect(recordInstruction(dir, instruction("i1"))).rejects.toThrow(ChangeLogError);
    expect(await readEntries(dir)).toHaveLength(1);
  });
});

describe("recordInstructionOutcome", () => {
  test("writes each outcome once, however often it is asked", async () => {
    await recordInstruction(dir, instruction());
    expect(await recordInstructionOutcome(dir, "i1", "proposed")).toBeDefined();
    expect(await recordInstructionOutcome(dir, "i1", "proposed")).toBeUndefined();
    await Promise.all([
      recordInstructionOutcome(dir, "i1", "tried"),
      recordInstructionOutcome(dir, "i1", "tried"),
      recordInstructionOutcome(dir, "i1", "tried"),
    ]);
    expect(outcomesOf(await readEntries(dir), "i1")).toEqual(["proposed", "tried"]);
  });

  test("writes nothing for an unknown instruction or another item", async () => {
    await recordInstruction(dir, instruction());
    expect(await recordInstructionOutcome(dir, "nope", "proposed")).toBeUndefined();
    expect(await recordInstructionOutcome(dir, "i1", "tried", { itemId: "other" })).toBeUndefined();
    expect(await recordInstructionOutcome(dir, "i1", "tried", { itemId: "s1-l1" })).toBeDefined();
    expect(outcomesOf(await readEntries(dir), "i1")).toEqual(["tried"]);
  });

  test("`unless` and `after` look at the outcomes already logged", async () => {
    await recordInstruction(dir, instruction());
    const afterProposed = { after: ["proposed"] } as const;
    expect(await recordInstructionOutcome(dir, "i1", "tried", afterProposed)).toBeUndefined();
    await recordInstructionOutcome(dir, "i1", "proposed");
    expect(await recordInstructionOutcome(dir, "i1", "tried", afterProposed)).toBeDefined();
    await recordInstructionOutcome(dir, "i1", "kept");
    const unlessKept = { unless: ["kept", "discarded"] } as const;
    expect(await recordInstructionOutcome(dir, "i1", "discarded", unlessKept)).toBeUndefined();
    expect(outcomesOf(await readEntries(dir), "i1")).toEqual(["proposed", "tried", "kept"]);
  });

  test("an outcome holds no content of the proposal", async () => {
    await recordInstruction(dir, instruction());
    const entry = await recordInstructionOutcome(dir, "i1", "discarded");
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ["change", "id", "instructionId", "outcome", "source", "target", "time"].sort(),
    );
  });
});

describe("the entries in the log", () => {
  test("parse back, and unknown outcomes and extra keys are refused", async () => {
    await recordInstruction(dir, instruction());
    await recordInstructionOutcome(dir, "i1", "failed");
    const lines = (await readFile(join(dir, "changes.jsonl"), "utf8")).trim().split("\n");
    for (const line of lines) expect(parseChangeEntry(JSON.parse(line))).toBeDefined();
    const outcome = JSON.parse(lines[1] ?? "");
    expect(() => parseChangeEntry({ ...outcome, outcome: "approved" })).toThrow();
    expect(() => parseChangeEntry({ ...outcome, extra: 1 })).toThrow();
  });

  test("applyEntries ignores them", async () => {
    await recordInstruction(dir, instruction());
    await recordInstructionOutcome(dir, "i1", "proposed");
    const snapshot = { speakers: [], images: [], scenes: [] } as unknown as ChangeSnapshot;
    expect(applyEntries(snapshot, await readEntries(dir))).toEqual(snapshot);
  });
});

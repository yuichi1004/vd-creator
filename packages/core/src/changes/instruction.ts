// The entries for instructions to the agent and what became of them. See "In the change log" in
// docs/plans/0013-voice-retake-with-agent.md.

import {
  type ChangeEntry,
  ChangeLogError,
  INSTRUCTION_MAX_LENGTH,
  type InstructionEntry,
  type InstructionOutcome,
  type InstructionOutcomeEntry,
} from "./entry.js";
import { type ChangeLockOptions, withProjectLock } from "./lock.js";
import { appendEntries, readEntries } from "./log.js";

export type InstructionOptions = {
  lock?: ChangeLockOptions;
  /** The time of the entry. Defaults to now. */
  now?: () => Date;
};

export type OutcomeOptions = InstructionOptions & {
  /** Write only if the instruction is for this item. */
  itemId?: string;
  /** Write nothing if the log already has one of these outcomes for the instruction. */
  unless?: readonly InstructionOutcome[];
  /** Write only if the log already has one of these outcomes for the instruction. */
  after?: readonly InstructionOutcome[];
};

/**
 * Appends the entry of an instruction sent to the agent for the line `itemId`. It records no
 * change, so it does not mark the line. Holds the project lock. Throws a `ChangeLogError`,
 * writing nothing, if the text is empty or longer than 1,000 characters, or the ID is used.
 */
export async function recordInstruction(
  projectDir: string,
  instruction: { instructionId: string; itemId: string; text: string },
  options: InstructionOptions = {},
): Promise<InstructionEntry> {
  if (instruction.text.trim() === "" || [...instruction.text].length > INSTRUCTION_MAX_LENGTH) {
    throw new ChangeLogError(`The instruction must be 1 to ${INSTRUCTION_MAX_LENGTH} characters`);
  }
  return withProjectLock(
    projectDir,
    async () => {
      const entries = await readEntries(projectDir);
      if (findInstruction(entries, instruction.instructionId)) {
        throw new ChangeLogError("The instruction ID is already used");
      }
      const [entry] = await appendEntries(
        projectDir,
        [
          {
            source: "ui",
            target: { kind: "item", id: instruction.itemId },
            change: "instruction",
            instructionId: instruction.instructionId,
            text: instruction.text,
          },
        ],
        options.now ? { now: options.now() } : {},
      );
      return entry as InstructionEntry;
    },
    options.lock,
  );
}

/** The instruction entry with this ID, if the log has one. */
export function findInstruction(
  entries: readonly ChangeEntry[],
  instructionId: string,
): InstructionEntry | undefined {
  return entries.find(
    (e): e is InstructionEntry =>
      e.source === "ui" && e.change === "instruction" && e.instructionId === instructionId,
  );
}

/**
 * Appends the outcome of an instruction, once: nothing is written, and `undefined` returned, if
 * the log has no such instruction or already has this outcome for it. So a repeated request
 * never repeats an entry, however many times the server hears of the same step. The entry holds
 * no content of the agent's proposal. Holds the project lock.
 */
export function recordInstructionOutcome(
  projectDir: string,
  instructionId: string,
  outcome: InstructionOutcome,
  options: OutcomeOptions = {},
): Promise<InstructionOutcomeEntry | undefined> {
  return withProjectLock(
    projectDir,
    async () => {
      const entries = await readEntries(projectDir);
      const instruction = findInstruction(entries, instructionId);
      if (!instruction) return undefined;
      if (options.itemId !== undefined && instruction.target.id !== options.itemId) {
        return undefined;
      }
      const done = outcomesOf(entries, instructionId);
      if (done.includes(outcome)) return undefined;
      if (options.unless?.some((o) => done.includes(o))) return undefined;
      if (options.after && !options.after.some((o) => done.includes(o))) return undefined;
      const [entry] = await appendEntries(
        projectDir,
        [
          {
            source: "ui",
            target: instruction.target,
            change: "instruction-outcome",
            instructionId,
            outcome,
          },
        ],
        options.now ? { now: options.now() } : {},
      );
      return entry as InstructionOutcomeEntry;
    },
    options.lock,
  );
}

/** The outcomes logged for an instruction, in the order they were logged. */
export function outcomesOf(
  entries: readonly ChangeEntry[],
  instructionId: string,
): InstructionOutcome[] {
  return entries.flatMap((e) =>
    e.source === "ui" && e.change === "instruction-outcome" && e.instructionId === instructionId
      ? [e.outcome]
      : [],
  );
}

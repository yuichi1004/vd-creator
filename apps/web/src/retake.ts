// The logic of the retake screen. See "Retake screen", "Trial takes", and "Agent proposals" in
// docs/plans/0013-voice-retake-with-agent.md.
//
// The controller holds the state of one line's screen and talks to the server through the
// client. The React components only show its state and call its methods, so the rules below
// are tested with a mocked `fetch`:
//
// - "Try it" and "Try" send a trial request. A trial never writes `scenario.yaml`.
// - "Keep" and "Use this take" send one PATCH with `restore`. They are the only requests of
//   this screen that write `scenario.yaml`.
// - "Discard" and "Not this one" send no PATCH.
// - A paid trial goes through the confirm step: the plan and its cost are shown, and the cost
//   is sent back as `approved`.

import type {
  GeneratePlanResponse,
  ProjectResponse,
  ProposalView,
  TakeInfo,
  TrialBase,
  TrialResponse,
} from "@vd-creator/server";
import { type ApiClient, ApiRequestError, isConfirmRequired } from "./client.js";
import type { LineItem, Scenario } from "./types.js";

/** Fixed texts of the screen. Nothing the agent or the server answered is shown beyond these. */
export const TEXT = {
  busy: "The agent is working on another instruction. Try again when it has finished.",
  timeout: "The agent did not answer in time.",
  unusable: "The agent's answer could not be used.",
  noAgent: "No agent is set up on this server.",
  cancelled: "Cancelled.",
  stale: "This line changed since you opened it, for example on another device. It was reloaded.",
  proposalGone: "This proposal is no longer available. Ask the agent again.",
  nothingChanged: "Nothing changed. Edit the text, the direction, or the settings first.",
  badSettings: 'The voice settings must be a JSON object, such as {"stability": 0.5}.',
  kept: "Kept.",
  usedTake: "Now using that take.",
} as const;

export type Message = { text: string; kind: "info" | "error" };

/** A trial take that is ready to hear. `base` is the line it was made from. */
export type Trial = {
  key: string;
  take: number;
  url: string;
  durationSec: number;
  base: TrialBase;
};

export type RetakeState = {
  /** The line's versions, newest first. Absent until loaded. */
  takes: TakeInfo[] | undefined;
  takesError: string | undefined;
  /** True while the agent works on an instruction. */
  asking: boolean;
  proposal: ProposalView | undefined;
  trial: Trial | undefined;
  /** What the screen waits for, if anything. Buttons that start another request are disabled. */
  working: "trial" | "keep" | "use" | undefined;
  message: Message | undefined;
};

export type RetakeDeps = {
  client: ApiClient;
  itemId: string;
  /** True if each generation costs money, so a trial first shows its cost. */
  paid: boolean;
  /** The line as the page last saw it, or `undefined` if the line is gone. */
  getBase: () => TrialBase | undefined;
  /** Shows the project a PATCH answered with. */
  applyProject: (project: ProjectResponse) => void;
  /** Loads the project again. */
  reload: () => Promise<void>;
  /**
   * Shows the confirm step of a paid trial. Resolves true when the user pressed "Generate (N
   * characters)", false when they cancelled. `changed` is true when the plan grew after the
   * user approved an earlier one.
   */
  askConfirm: (plan: GeneratePlanResponse, changed: boolean) => Promise<boolean>;
};

/** The line as a base, in the form the server compares. */
export function lineBase(item: LineItem): TrialBase {
  const base: TrialBase = { speaker: item.speaker, text: item.line, take: item.take };
  if (item.direction !== undefined) base.direction = item.direction;
  if (item.voice?.settings !== undefined) base.voiceSettings = item.voice.settings;
  return base;
}

/** The line with this ID, or `undefined`. */
export function findLine(scenario: Scenario | undefined, id: string): LineItem | undefined {
  for (const scene of scenario?.scenes ?? []) {
    for (const item of scene.items) if ("line" in item && item.id === id) return item;
  }
  return undefined;
}

/** The line before and the line after, in scenario order, with the scenes joined. */
export function neighbours(
  scenario: Scenario | undefined,
  id: string,
): { before: LineItem | undefined; after: LineItem | undefined } {
  const lines: LineItem[] = [];
  for (const scene of scenario?.scenes ?? []) {
    for (const item of scene.items) if ("line" in item) lines.push(item);
  }
  const index = lines.findIndex((l) => l.id === id);
  if (index < 0) return { before: undefined, after: undefined };
  return { before: lines[index - 1], after: lines[index + 1] };
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** The settings as the text of the settings field: JSON, or empty for none. */
export function formatSettings(settings: Record<string, unknown> | undefined): string {
  return settings && Object.keys(settings).length > 0 ? JSON.stringify(settings, null, 2) : "";
}

/** Parses the settings field: empty is no settings, anything but a JSON object is refused. */
export function parseSettings(text: string): Record<string, unknown> | undefined {
  if (text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Not JSON.
  }
  return undefined;
}

/**
 * What to send as `voiceSettings` so that the line's override becomes `next`: a changed or new
 * key with its value, a removed key as `null`. `undefined` if nothing changes.
 */
export function settingsDiff(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const diff: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (!current || !Object.hasOwn(current, key) || !sameJson(current[key], value)) {
      diff[key] = value;
    }
  }
  for (const key of Object.keys(current ?? {})) {
    if (!Object.hasOwn(next, key)) diff[key] = null;
  }
  return Object.keys(diff).length > 0 ? diff : undefined;
}

/** The override that results from merging `proposed` over `current`, one key at a time. */
export function mergeSettings(
  current: Record<string, unknown> | undefined,
  proposed: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...current, ...proposed };
}

/** One row of the proposal diff: a field, its old value, and its new value, as text. */
export type DiffRow = { label: string; old: string; next: string };

const NOT_SET = "(not set)";

function show(value: unknown): string {
  return value === undefined || value === ""
    ? NOT_SET
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}

/** The rows of the proposal diff: only what the proposal changes, against the line it was made from. */
export function proposalDiff(proposal: ProposalView): DiffRow[] {
  const rows: DiffRow[] = [];
  const { base } = proposal;
  if (proposal.text !== undefined && proposal.text !== base.text) {
    rows.push({ label: "Text", old: base.text, next: proposal.text });
  }
  if (proposal.direction !== undefined && proposal.direction !== (base.direction ?? "")) {
    rows.push({ label: "Direction", old: show(base.direction), next: show(proposal.direction) });
  }
  for (const [key, value] of Object.entries(proposal.settings ?? {})) {
    const old = base.voiceSettings?.[key];
    if (!sameJson(old, value)) {
      rows.push({ label: `Setting ${key}`, old: show(old), next: show(value) });
    }
  }
  return rows;
}

/** The file of an `/assets/<file>` URL the server sent, to resolve against the page. */
export function assetFileOf(url: string): string {
  return url.replace(/^\/?assets\//, "");
}

/** The fields the user edited by hand. */
export type EditFields = { text: string; direction: string; settings: string };

export class RetakeController {
  private state: RetakeState = {
    takes: undefined,
    takesError: undefined,
    asking: false,
    proposal: undefined,
    trial: undefined,
    working: undefined,
    message: undefined,
  };
  private readonly listeners = new Set<() => void>();
  private cancelRequested = false;

  constructor(private readonly deps: RetakeDeps) {}

  getState = (): RetakeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<RetakeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Loads the line's versions. */
  async loadTakes(): Promise<void> {
    try {
      const response = await this.deps.client.getTakes(this.deps.itemId);
      this.set({ takes: response.takes, takesError: undefined });
    } catch (error) {
      this.set({ takesError: messageOf(error) });
    }
  }

  dismissMessage(): void {
    this.set({ message: undefined });
  }

  // Ask the agent.

  /** Sends the instruction to the agent. The answer is a proposal; nothing is written. */
  async ask(instruction: string): Promise<void> {
    const text = instruction.trim();
    if (text === "" || this.state.asking) return;
    this.cancelRequested = false;
    this.set({ asking: true, message: undefined });
    try {
      const response = await this.deps.client.createProposal(this.deps.itemId, text);
      this.set({ asking: false, proposal: response.proposal });
    } catch (error) {
      this.set({ asking: false, message: this.agentFailure(error) });
    }
  }

  private agentFailure(error: unknown): Message {
    if (this.cancelRequested) return { text: TEXT.cancelled, kind: "info" };
    if (error instanceof ApiRequestError) {
      const code = error.body?.error;
      if (code === "busy") return { text: TEXT.busy, kind: "error" };
      if (code === "timeout") return { text: TEXT.timeout, kind: "error" };
      if (code === "not-found") return { text: TEXT.noAgent, kind: "error" };
      if (error.status === 0) return { text: error.message, kind: "error" };
    }
    return { text: TEXT.unusable, kind: "error" };
  }

  /** Cancels the agent's run. The pending ask then ends with the cancelled message. */
  async cancel(): Promise<void> {
    if (!this.state.asking) return;
    this.cancelRequested = true;
    try {
      await this.deps.client.cancelAgentRun();
    } catch {
      // The ask ends by itself when the run does.
    }
  }

  /** Drops the proposal and tells the server, so the change log says so. No PATCH. */
  async discard(): Promise<void> {
    const proposal = this.state.proposal;
    if (!proposal) return;
    this.set({ proposal: undefined });
    try {
      await this.deps.client.discardProposal(proposal.id);
    } catch {
      // The proposal is gone from the screen either way.
    }
  }

  // Trials.

  /** Makes a trial take of the proposal. */
  async tryProposal(): Promise<void> {
    const proposal = this.state.proposal;
    if (!proposal) return;
    await this.runTrial(
      {
        base: proposal.base,
        proposalId: proposal.id,
        ...(proposal.text !== undefined ? { text: proposal.text } : {}),
        ...(proposal.direction !== undefined ? { direction: proposal.direction } : {}),
        ...(proposal.settings !== undefined ? { voiceSettings: proposal.settings } : {}),
      },
      proposal.base,
    );
  }

  /** Makes a trial take of the fields the user edited by hand. */
  async tryEdit(fields: EditFields): Promise<void> {
    const base = this.deps.getBase();
    if (!base) return;
    const settings = parseSettings(fields.settings);
    if (!settings) {
      this.set({ message: { text: TEXT.badSettings, kind: "error" } });
      return;
    }
    const request: { text?: string; direction?: string; voiceSettings?: Record<string, unknown> } =
      {};
    if (fields.text !== base.text) request.text = fields.text;
    if (fields.direction !== (base.direction ?? "")) request.direction = fields.direction;
    const diff = settingsDiff(base.voiceSettings, settings);
    if (diff) request.voiceSettings = diff;
    if (Object.keys(request).length === 0) {
      this.set({ message: { text: TEXT.nothingChanged, kind: "info" } });
      return;
    }
    await this.runTrial({ base, ...request }, base);
  }

  private async runTrial(
    request: { base: TrialBase; proposalId?: string } & {
      text?: string;
      direction?: string;
      voiceSettings?: Record<string, unknown>;
    },
    base: TrialBase,
  ): Promise<void> {
    if (this.state.working) return;
    this.set({ working: "trial", message: undefined });
    try {
      const planned = await this.deps.client.trial(this.deps.itemId, request);
      if (planned.kind !== "plan") throw new ApiRequestError("Unexpected response.", 200);
      let plan = planned;
      let changed = false;
      for (;;) {
        if (this.deps.paid && !(await this.deps.askConfirm(plan, changed))) {
          this.set({ working: undefined });
          return;
        }
        try {
          const run = await this.deps.client.trial(this.deps.itemId, {
            ...request,
            confirm: true,
            ...(this.deps.paid
              ? {
                  approved: {
                    characters: plan.plan.cost.characters,
                    requests: plan.plan.cost.requests,
                  },
                }
              : {}),
          });
          if (run.kind !== "trial") throw new ApiRequestError("Unexpected response.", 200);
          this.set({ working: undefined, trial: trialOf(run, base) });
          await this.loadTakes();
          return;
        } catch (error) {
          if (error instanceof ApiRequestError && isConfirmRequired(error.body)) {
            plan = error.body.plan;
            changed = true;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      await this.fail(error);
    }
  }

  /** Forgets the trial. Nothing is sent: the trial stays in the takes list. */
  dropTrial(): void {
    this.set({ trial: undefined });
  }

  // The two ways to write the scenario.

  /** Keeps the trial: one restore PATCH with the trial's key and the line it was made from. */
  async keep(): Promise<void> {
    const trial = this.state.trial;
    if (!trial || this.state.working) return;
    await this.restore(trial.key, trial.base, "keep", TEXT.kept);
  }

  /** Uses an earlier take: one restore PATCH, with the line as the page last saw it. */
  async takeBack(take: TakeInfo): Promise<void> {
    const base = this.deps.getBase();
    if (!base || !take.canUse || this.state.working) return;
    await this.restore(take.key, base, "use", TEXT.usedTake);
  }

  private async restore(
    key: string,
    base: TrialBase,
    working: "keep" | "use",
    done: string,
  ): Promise<void> {
    this.set({ working, message: undefined });
    try {
      const project = await this.deps.client.patchItem(this.deps.itemId, {
        restore: { key, base },
      });
      this.deps.applyProject(project);
      this.set({
        working: undefined,
        trial: undefined,
        proposal: undefined,
        message: { text: done, kind: "info" },
      });
      await this.loadTakes();
    } catch (error) {
      await this.fail(error);
    }
  }

  /** Shows a failed request. A line that changed meanwhile is reloaded. */
  private async fail(error: unknown): Promise<void> {
    const code = error instanceof ApiRequestError ? error.body?.error : undefined;
    if (code === "stale") {
      this.set({
        working: undefined,
        proposal: undefined,
        trial: undefined,
        message: { text: TEXT.stale, kind: "error" },
      });
      await this.deps.reload();
      await this.loadTakes();
      return;
    }
    if (code === "proposal-gone") {
      this.set({
        working: undefined,
        proposal: undefined,
        message: { text: TEXT.proposalGone, kind: "error" },
      });
      return;
    }
    this.set({ working: undefined, message: { text: messageOf(error), kind: "error" } });
  }
}

function trialOf(run: TrialResponse, base: TrialBase): Trial {
  return { key: run.key, take: run.take, url: run.url, durationSec: run.durationSec, base };
}

function messageOf(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "The request failed.";
}

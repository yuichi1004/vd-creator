import type { ProposalView, TakeInfo, TrialBase } from "@vd-creator/server";
import { describe, expect, test } from "vitest";
import { ApiClient } from "./client.js";
import {
  assetFileOf,
  formatSettings,
  mergeSettings,
  neighbours,
  parseSettings,
  proposalDiff,
  RetakeController,
  settingsDiff,
  TEXT,
} from "./retake.js";
import type { Scenario } from "./types.js";

const PREFIX = "http://host.example/";

type Call = { method: string; path: string; body: unknown };
type Reply = { status?: number; body: unknown };

const BASE: TrialBase = { speaker: "a", text: "Hello.", take: 1, direction: "calm" };

const PLAN = { kind: "plan", plan: { cost: { characters: 6, requests: 1 } } };
const TRIAL = { kind: "trial", key: "t1", take: 2, url: "/assets/t1.mp3", durationSec: 1.5 };

function reply(body: unknown, status = 200): Reply {
  return { status, body };
}

function apiError(error: string, status: number, extra: object = {}): Reply {
  return { status, body: { error, message: `message of ${error}`, ...extra } };
}

/** A controller over a mocked fetch. `route` answers a request or returns nothing for "ok". */
function setup(
  route: (call: Call) => Reply | undefined,
  options: { paid?: boolean; confirm?: boolean } = {},
) {
  const calls: Call[] = [];
  const events: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = url.slice(PREFIX.length);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method: init?.method ?? "GET", path, body };
    calls.push(call);
    const answer = route(call) ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const plans: boolean[] = [];
  const controller = new RetakeController({
    client: new ApiClient(PREFIX, fetchImpl),
    itemId: "l1",
    paid: options.paid ?? false,
    getBase: () => BASE,
    applyProject: () => {
      events.push("applied");
    },
    reload: async () => {
      events.push("reloaded");
    },
    askConfirm: async (_plan, changed) => {
      plans.push(changed);
      return options.confirm ?? true;
    },
  });
  const patches = () => calls.filter((c) => c.method === "PATCH");
  return { controller, calls, events, plans, patches };
}

/** Answers a trial: a plan without `confirm`, a take with it; takes list is empty. */
function trialRoute(call: Call): Reply | undefined {
  if (call.path === "api/items/l1/takes") return reply({ takes: [] });
  if (call.path === "api/items/l1/trials") {
    return reply((call.body as { confirm?: boolean }).confirm ? TRIAL : PLAN);
  }
  return undefined;
}

const PROPOSAL: ProposalView = {
  id: "p1",
  text: "Hello!",
  direction: "excited",
  settings: { stability: 0.2 },
  reason: "More energy",
  base: BASE,
};

async function withProposal(route: (call: Call) => Reply | undefined = trialRoute) {
  const harness = setup((call) => {
    if (call.path === "api/items/l1/proposals") return reply({ proposal: PROPOSAL });
    return route(call);
  });
  await harness.controller.ask("More energy");
  return harness;
}

describe("Try it and Try", () => {
  test("Try it sends trial requests with the proposal and writes nothing", async () => {
    const { controller, calls, patches } = await withProposal();
    await controller.tryProposal();
    const trials = calls.filter((c) => c.path === "api/items/l1/trials");
    expect(trials).toHaveLength(2);
    expect(trials[0]?.body).toMatchObject({ proposalId: "p1", text: "Hello!", base: BASE });
    expect(trials[0]?.body).not.toHaveProperty("confirm");
    expect(trials[1]?.body).toMatchObject({ proposalId: "p1", confirm: true });
    expect(trials[1]?.body).not.toHaveProperty("approved");
    expect(patches()).toHaveLength(0);
    expect(controller.getState().trial?.key).toBe("t1");
  });

  test("Try sends only what the user changed, and settings as a diff", async () => {
    const { controller, calls, patches } = setup(trialRoute);
    await controller.tryEdit({ text: "Hello.", direction: "calm", settings: '{"stability":0.4}' });
    const first = calls.find((c) => c.path === "api/items/l1/trials");
    expect(first?.body).toEqual({ base: BASE, voiceSettings: { stability: 0.4 } });
    expect(patches()).toHaveLength(0);
  });

  test("Try with nothing changed sends nothing", async () => {
    const { controller, calls } = setup(trialRoute);
    await controller.tryEdit({ text: "Hello.", direction: "calm", settings: "" });
    expect(calls).toHaveLength(0);
    expect(controller.getState().message?.text).toBe(TEXT.nothingChanged);
  });

  test("Try with settings that are not an object sends nothing", async () => {
    const { controller, calls } = setup(trialRoute);
    await controller.tryEdit({ text: "Hello.", direction: "calm", settings: "[1]" });
    expect(calls).toHaveLength(0);
    expect(controller.getState().message?.text).toBe(TEXT.badSettings);
  });
});

describe("Keep, Discard, and Not this one", () => {
  test("Keep sends exactly one restore PATCH with the trial key and base", async () => {
    const { controller, patches, events } = await withProposal();
    await controller.tryProposal();
    await controller.keep();
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.path).toBe("api/items/l1");
    expect(patches()[0]?.body).toEqual({ restore: { key: "t1", base: BASE } });
    expect(events).toContain("applied");
    expect(controller.getState().trial).toBeUndefined();
    expect(controller.getState().message?.text).toBe(TEXT.kept);
  });

  test("Discard tells the server and sends no PATCH", async () => {
    const { controller, calls, patches } = await withProposal();
    await controller.discard();
    expect(controller.getState().proposal).toBeUndefined();
    expect(calls.some((c) => c.path === "api/proposals/p1/discard")).toBe(true);
    expect(patches()).toHaveLength(0);
  });

  test("Not this one sends no request at all", async () => {
    const { controller, calls } = await withProposal();
    await controller.tryProposal();
    const before = calls.length;
    controller.dropTrial();
    expect(calls).toHaveLength(before);
    expect(controller.getState().trial).toBeUndefined();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });
});

describe("a stale answer", () => {
  test("reloads the line, clears the trial, and shows the message", async () => {
    const { controller, events, patches } = await withProposal((call) => {
      if (call.method === "PATCH") return apiError("stale", 409);
      return trialRoute(call);
    });
    await controller.tryProposal();
    await controller.keep();
    expect(patches()).toHaveLength(1);
    expect(events).toEqual(["reloaded"]);
    const state = controller.getState();
    expect(state.message).toEqual({ text: TEXT.stale, kind: "error" });
    expect(state.trial).toBeUndefined();
    expect(state.proposal).toBeUndefined();
  });

  test("a stale trial request does the same", async () => {
    const { controller, events } = setup((call) =>
      call.path === "api/items/l1/trials" ? apiError("stale", 409) : trialRoute(call),
    );
    await controller.tryEdit({ text: "Other", direction: "calm", settings: "" });
    expect(events).toEqual(["reloaded"]);
    expect(controller.getState().message?.text).toBe(TEXT.stale);
  });

  test("a proposal that is gone is dropped with a fixed message", async () => {
    const { controller } = await withProposal((call) =>
      call.path === "api/items/l1/trials" ? apiError("proposal-gone", 409) : trialRoute(call),
    );
    await controller.tryProposal();
    expect(controller.getState().proposal).toBeUndefined();
    expect(controller.getState().message?.text).toBe(TEXT.proposalGone);
  });
});

describe("Use this take", () => {
  const take = (canUse: boolean): TakeInfo =>
    ({
      key: "k1",
      time: "2026-10-31T09:00:00.000Z",
      take: 1,
      trial: false,
      provider: "mock",
      current: false,
      text: "Hello.",
      canUse,
      ...(canUse ? {} : { why: { code: "other-speaker", message: "Another voice." } }),
    }) as TakeInfo;

  test("sends one restore PATCH with the current base where the server allows it", async () => {
    const { controller, patches } = setup(trialRoute);
    await controller.takeBack(take(true));
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.body).toEqual({ restore: { key: "k1", base: BASE } });
  });

  test("sends nothing where the server does not allow it", async () => {
    const { controller, calls } = setup(trialRoute);
    await controller.takeBack(take(false));
    expect(calls).toHaveLength(0);
  });
});

describe("paid generation", () => {
  test("shows the plan, then sends the approved cost", async () => {
    const { controller, calls, plans } = setup(trialRoute, { paid: true });
    await controller.tryEdit({ text: "Other", direction: "calm", settings: "" });
    expect(plans).toEqual([false]);
    const confirmed = calls.filter((c) => c.path === "api/items/l1/trials")[1];
    expect(confirmed?.body).toMatchObject({
      confirm: true,
      approved: { characters: 6, requests: 1 },
    });
    expect(controller.getState().trial?.key).toBe("t1");
  });

  test("cancelling the confirm generates nothing", async () => {
    const { controller, calls } = setup(trialRoute, { paid: true, confirm: false });
    await controller.tryEdit({ text: "Other", direction: "calm", settings: "" });
    expect(calls.filter((c) => c.path === "api/items/l1/trials")).toHaveLength(1);
    expect(controller.getState().trial).toBeUndefined();
    expect(controller.getState().working).toBeUndefined();
  });

  test("a bigger plan asks again, marked as changed", async () => {
    let confirmed = 0;
    const { controller, plans } = setup(
      (call) => {
        if (call.path === "api/items/l1/trials" && (call.body as { confirm?: boolean }).confirm) {
          confirmed += 1;
          if (confirmed === 1) {
            return apiError("confirm-required", 409, {
              plan: { kind: "plan", plan: { cost: { characters: 20, requests: 1 } } },
            });
          }
          return reply(TRIAL);
        }
        return trialRoute(call);
      },
      { paid: true },
    );
    await controller.tryEdit({ text: "Other", direction: "calm", settings: "" });
    expect(plans).toEqual([false, true]);
    expect(controller.getState().trial?.key).toBe("t1");
  });
});

describe("the agent", () => {
  test("a proposal is shown and nothing is written", async () => {
    const { controller, patches } = await withProposal();
    expect(controller.getState().proposal?.id).toBe("p1");
    expect(patches()).toHaveLength(0);
  });

  test.each([
    ["busy", 409, TEXT.busy],
    ["timeout", 504, TEXT.timeout],
    ["invalid-proposal", 502, TEXT.unusable],
  ])("%s is shown as fixed text", async (code, status, text) => {
    const { controller } = setup((call) =>
      call.path.endsWith("/proposals") ? apiError(code, status) : undefined,
    );
    await controller.ask("Softer");
    expect(controller.getState().message).toEqual({ text, kind: "error" });
    expect(controller.getState().asking).toBe(false);
  });

  test("Cancel asks the server to stop, and the ask ends as cancelled", async () => {
    let release: (reply: Reply) => void = () => {};
    const pending = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const client = new ApiClient(PREFIX, async (url: string) => {
      const path = url.slice(PREFIX.length);
      seen.push(path);
      if (path.endsWith("/proposals")) {
        const answer = await pending;
        return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
      }
      return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
    });
    const waiting = new RetakeController({
      client,
      itemId: "l1",
      paid: false,
      getBase: () => BASE,
      applyProject: () => {},
      reload: async () => {},
      askConfirm: async () => true,
    });
    const asked = waiting.ask("Softer");
    expect(waiting.getState().asking).toBe(true);
    await waiting.cancel();
    release(apiError("server-error", 500));
    await asked;
    expect(seen).toContain("api/agent-run/cancel");
    expect(waiting.getState().message).toEqual({ text: TEXT.cancelled, kind: "info" });
  });

  test("an empty instruction sends nothing", async () => {
    const { controller, calls } = setup(() => undefined);
    await controller.ask("   ");
    expect(calls).toHaveLength(0);
  });
});

describe("helpers", () => {
  test("settings: format, parse, diff, and merge", () => {
    expect(formatSettings(undefined)).toBe("");
    expect(parseSettings("")).toEqual({});
    expect(parseSettings("nope")).toBeUndefined();
    expect(parseSettings("[1]")).toBeUndefined();
    expect(settingsDiff({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual({ b: null, c: 3 });
    expect(settingsDiff({ a: 1 }, { a: 1 })).toBeUndefined();
    expect(mergeSettings({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("the proposal diff lists only what changes, old against new", () => {
    const rows = proposalDiff({
      ...PROPOSAL,
      base: { ...BASE, voiceSettings: { stability: 0.5 } },
    });
    expect(rows).toEqual([
      { label: "Text", old: "Hello.", next: "Hello!" },
      { label: "Direction", old: "calm", next: "excited" },
      { label: "Setting stability", old: "0.5", next: "0.2" },
    ]);
    expect(proposalDiff({ ...PROPOSAL, text: "Hello.", direction: "calm", settings: {} })).toEqual(
      [],
    );
  });

  test("a trial URL becomes an asset file", () => {
    expect(assetFileOf("/assets/t1.mp3")).toBe("t1.mp3");
  });

  test("neighbours cross scenes", () => {
    const line = (id: string) => ({ id, speaker: "a", line: id, take: 1 });
    const scenario = {
      scenes: [
        { id: "s1", items: [line("a"), line("b")] },
        { id: "s2", items: [{ id: "x", pause: 1 }, line("c")] },
      ],
    } as unknown as Scenario;
    expect(neighbours(scenario, "b").after?.id).toBe("c");
    expect(neighbours(scenario, "c").before?.id).toBe("b");
    expect(neighbours(scenario, "a").before).toBeUndefined();
    expect(neighbours(scenario, "zzz")).toEqual({ before: undefined, after: undefined });
  });
});

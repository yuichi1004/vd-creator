import type { ProposalView, TakeInfo, TrialBase } from "@vd-creator/server";
import { describe, expect, test } from "vitest";
import { ApiClient } from "./client.js";
import { stopWhenHidden } from "./contextAudio.js";
import { RetakeController, retakePlaceholder } from "./retake.js";
import type { Scenario } from "./types.js";

const PREFIX = "http://host.example/";
const BASE: TrialBase = { speaker: "a", text: "Hello.", take: 1, direction: "calm" };
const PLAN = { kind: "plan", plan: { cost: { characters: 6, requests: 1 } } };
const TRIAL = { kind: "trial", key: "t1", take: 2, url: "/assets/t1.mp3", durationSec: 1.5 };

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };
type Answer = { status?: number; body: unknown };

/** A promise that the test resolves by hand. */
function gate<T = void>() {
  let open: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function harness(
  route: (call: Call) => Answer | Promise<Answer> | undefined,
  options: { paid?: boolean; base?: () => TrialBase } = {},
) {
  const calls: Call[] = [];
  const dialogs: boolean[] = [];
  let closed = 0;
  let pendingAnswer: ((answer: boolean) => void) | undefined;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.slice(PREFIX.length),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const answer = (await route(call)) ?? { body: { ok: true } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  const controller = new RetakeController({
    client: new ApiClient(PREFIX, fetchImpl),
    itemId: "l1",
    paid: options.paid ?? false,
    getBase: options.base ?? (() => BASE),
    applyProject: () => {},
    reload: async () => {},
    askConfirm: (_plan, changed) =>
      new Promise<boolean>((resolve) => {
        dialogs.push(changed);
        pendingAnswer = resolve;
      }),
    closeConfirm: () => {
      closed += 1;
      pendingAnswer?.(false);
    },
  });
  const trials = () => calls.filter((c) => c.path === "api/items/l1/trials");
  return { controller, calls, dialogs, trials, closed: () => closed, answer: () => pendingAnswer };
}

const EDIT = { text: "Other", direction: "calm", settings: "" };

describe("leaving the screen (P2-2)", () => {
  test("a plan that arrives after dispose opens no dialog and sends no trial request", async () => {
    const plan = gate<Answer>();
    const { controller, dialogs, trials } = harness(
      (call) => (call.path === "api/items/l1/trials" ? plan.promise : undefined),
      { paid: true },
    );
    const trying = controller.tryEdit(EDIT);
    // The user switches to line B: line A's controller is disposed.
    controller.dispose();
    plan.open({ body: PLAN });
    await trying;
    expect(dialogs).toEqual([]);
    expect(trials()).toHaveLength(1);
    expect(trials()[0]?.body).not.toHaveProperty("confirm");
  });

  test("an open confirm step is closed on dispose, and nothing is generated", async () => {
    const { controller, dialogs, trials, closed } = harness(
      (call) => (call.path === "api/items/l1/trials" ? { body: PLAN } : undefined),
      { paid: true },
    );
    const trying = controller.tryEdit(EDIT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialogs).toEqual([false]);
    controller.dispose();
    await trying;
    expect(closed()).toBe(1);
    expect(trials()).toHaveLength(1);
  });

  test("a result that arrives after dispose changes no state", async () => {
    const run = gate<Answer>();
    const { controller } = harness((call) => {
      if (call.path !== "api/items/l1/trials") return undefined;
      return (call.body as { confirm?: boolean }).confirm ? run.promise : { body: PLAN };
    });
    const trying = controller.tryEdit(EDIT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.dispose();
    run.open({ body: TRIAL });
    await trying;
    expect(controller.getState().trial).toBeUndefined();
  });
});

describe("takes reads (P2-3)", () => {
  const take = (key: string): TakeInfo =>
    ({ key, take: 1, trial: false, provider: "mock", current: false, text: key }) as TakeInfo;

  test("a slow first read that lands after a trial does not replace the newer list", async () => {
    const slow = gate<Answer>();
    let reads = 0;
    const { controller } = harness((call) => {
      if (call.path === "api/items/l1/takes") {
        reads += 1;
        return reads === 1 ? slow.promise : { body: { takes: [take("new")] } };
      }
      if (call.path === "api/items/l1/trials") {
        return { body: (call.body as { confirm?: boolean }).confirm ? TRIAL : PLAN };
      }
      return undefined;
    });
    const first = controller.loadTakes();
    await controller.tryEdit(EDIT);
    expect(controller.getState().takes?.map((t) => t.key)).toEqual(["new"]);
    slow.open({ body: { takes: [take("old")] } });
    await first;
    expect(controller.getState().takes?.map((t) => t.key)).toEqual(["new"]);
  });

  test("a slow failed read does not replace the newer list with an error", async () => {
    const slow = gate<Answer>();
    let reads = 0;
    const { controller } = harness(() => {
      reads += 1;
      return reads === 1 ? slow.promise : { body: { takes: [take("new")] } };
    });
    const first = controller.loadTakes();
    await controller.loadTakes();
    slow.open({ status: 500, body: { error: "server-error", message: "boom" } });
    await first;
    expect(controller.getState().takesError).toBeUndefined();
    expect(controller.getState().takes).toHaveLength(1);
  });
});

describe("proposal provenance (P2-4)", () => {
  const PROPOSAL: ProposalView = {
    id: "p1",
    text: "Hello!",
    reason: "More energy",
    base: BASE,
  };
  const route = (call: Call): Answer | undefined => {
    if (call.path === "api/items/l1/proposals") return { body: { proposal: PROPOSAL } };
    if (call.path === "api/items/l1/takes") return { body: { takes: [] } };
    if (call.path === "api/items/l1/trials") {
      return { body: call.body?.confirm ? TRIAL : PLAN };
    }
    return undefined;
  };

  test("a try of the copied, edited fields carries proposalId and the proposal's base", async () => {
    const { controller, trials } = harness(route);
    await controller.ask("More energy");
    controller.editProposal();
    await controller.tryEdit({ text: "Hello!!", direction: "calm", settings: "" });
    expect(trials()[0]?.body).toMatchObject({
      proposalId: "p1",
      base: BASE,
      text: "Hello!!",
    });
    expect(trials()[1]?.body).toMatchObject({ proposalId: "p1", confirm: true });
  });

  test("fields typed without pressing Edit on a proposal carry no proposalId", async () => {
    const { controller, trials } = harness(route);
    await controller.ask("More energy");
    await controller.tryEdit({ text: "Hello!!", direction: "calm", settings: "" });
    expect(trials()[0]?.body).not.toHaveProperty("proposalId");
  });

  test("Discard drops the provenance", async () => {
    const { controller, trials } = harness(route);
    await controller.ask("More energy");
    controller.editProposal();
    await controller.discard();
    await controller.tryEdit({ text: "Hello!!", direction: "calm", settings: "" });
    expect(trials()[0]?.body).not.toHaveProperty("proposalId");
  });

  test("a line that changed since the proposal drops the provenance", async () => {
    let base: TrialBase = BASE;
    const { controller, trials } = harness(route, { base: () => base });
    await controller.ask("More energy");
    controller.editProposal();
    base = { ...BASE, text: "Changed elsewhere.", take: 2 };
    await controller.tryEdit({ text: "Hello!!", direction: "calm", settings: "" });
    expect(trials()[0]?.body).not.toHaveProperty("proposalId");
    expect(trials()[0]?.body?.base).toEqual(base);
    expect(controller.getState().proposal).toBeUndefined();
  });
});

describe("a disposed controller sends nothing (round 2, P2-a)", () => {
  const PROPOSAL: ProposalView = { id: "p1", text: "Hello!", reason: "r", base: BASE };
  const TAKE = {
    key: "k1",
    take: 1,
    trial: false,
    provider: "mock",
    current: false,
    text: "x",
    canUse: true,
  } as TakeInfo;

  test("trial, ask, keep, take back, and loading takes send no request", async () => {
    const h = harness((call) => {
      if (call.path === "api/items/l1/proposals") return { body: { proposal: PROPOSAL } };
      if (call.path === "api/items/l1/trials") return { body: call.body?.confirm ? TRIAL : PLAN };
      return { body: { takes: [] } };
    });
    // A live controller with a proposal and a trial, so every call has something to act on.
    await h.controller.ask("More");
    await h.controller.tryProposal();
    expect(h.controller.getState().trial).toBeDefined();
    const sent = h.calls.length;
    h.controller.dispose();
    await h.controller.ask("Again");
    await h.controller.tryProposal();
    await h.controller.tryEdit(EDIT);
    await h.controller.keep();
    await h.controller.takeBack(TAKE);
    await h.controller.loadTakes();
    expect(h.calls).toHaveLength(sent);
    expect(h.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  test("no takes read follows a trial that finishes after dispose", async () => {
    const run = gate<Answer>();
    const h = harness((call) => {
      if (call.path !== "api/items/l1/trials") return undefined;
      return call.body?.confirm ? run.promise : { body: PLAN };
    });
    const trying = h.controller.tryEdit(EDIT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.controller.dispose();
    run.open({ body: TRIAL });
    await trying;
    expect(h.calls.some((c) => c.path === "api/items/l1/takes")).toBe(false);
  });
});

describe("leaving while the agent works (round 2, P2-b)", () => {
  const PROPOSAL: ProposalView = { id: "p9", text: "Hello!", reason: "r", base: BASE };

  test("dispose while asking cancels the agent run", async () => {
    const answer = gate<Answer>();
    const h = harness((call) =>
      call.path === "api/items/l1/proposals" ? answer.promise : undefined,
    );
    const asking = h.controller.ask("Softer");
    h.controller.dispose();
    expect(h.calls.map((c) => c.path)).toContain("api/agent-run/cancel");
    answer.open({ status: 500, body: { error: "server-error", message: "cancelled" } });
    await asking;
  });

  test("dispose while idle does not cancel anything", () => {
    const h = harness(() => undefined);
    h.controller.dispose();
    expect(h.calls).toHaveLength(0);
  });

  test("a late proposal for a disposed controller is discarded and not shown", async () => {
    const answer = gate<Answer>();
    const h = harness((call) =>
      call.path === "api/items/l1/proposals" ? answer.promise : undefined,
    );
    const asking = h.controller.ask("Softer");
    h.controller.dispose();
    answer.open({ body: { proposal: PROPOSAL } });
    await asking;
    expect(h.calls.map((c) => c.path)).toContain("api/proposals/p9/discard");
    expect(h.controller.getState().proposal).toBeUndefined();
  });
});

describe("a proposal for an older line (round 2, P3-c)", () => {
  test("is discarded on the server when a try drops it", async () => {
    let base: TrialBase = BASE;
    const h = harness(
      (call) => {
        if (call.path === "api/items/l1/proposals") {
          return { body: { proposal: { id: "p2", text: "Hi", reason: "r", base: BASE } } };
        }
        if (call.path === "api/items/l1/trials") return { body: call.body?.confirm ? TRIAL : PLAN };
        return { body: { takes: [] } };
      },
      { base: () => base },
    );
    await h.controller.ask("x");
    h.controller.editProposal();
    base = { ...BASE, text: "Changed.", take: 2 };
    await h.controller.tryEdit({ text: "Other", direction: "calm", settings: "" });
    expect(h.calls.map((c) => c.path)).toContain("api/proposals/p2/discard");
  });
});

describe("the placeholder (round 2, P3-b)", () => {
  const scenario = {
    scenes: [{ id: "s", items: [{ id: "l1", speaker: "a", line: "Hi", take: 1 }] }],
  } as unknown as Scenario;

  test("a line that exists but has no controller yet is loading, not missing", () => {
    expect(retakePlaceholder(scenario, "l1", false)).toBe("Loading…");
    expect(retakePlaceholder(undefined, "l1", false)).toBe("Loading…");
  });

  test("a line that does not exist is missing", () => {
    expect(retakePlaceholder(scenario, "nope", true)).toBe("There is no line nope.");
    expect(retakePlaceholder(scenario, "nope", false)).toBe("There is no line nope.");
  });
});

describe("audio and a hidden page (P2-5)", () => {
  function targets(state: string) {
    const doc = {
      visibilityState: state,
      handlers: new Set<() => void>(),
      addEventListener(_type: "visibilitychange", listener: () => void) {
        this.handlers.add(listener);
      },
      removeEventListener(_type: "visibilitychange", listener: () => void) {
        this.handlers.delete(listener);
      },
    };
    const win = {
      handlers: new Set<() => void>(),
      addEventListener(_type: "pagehide", listener: () => void) {
        this.handlers.add(listener);
      },
      removeEventListener(_type: "pagehide", listener: () => void) {
        this.handlers.delete(listener);
      },
    };
    return { doc, win };
  }

  test("stops on visibilitychange to hidden, not to visible", () => {
    const t = targets("visible");
    let stops = 0;
    stopWhenHidden({ stop: () => (stops += 1) }, t);
    for (const handler of t.doc.handlers) handler();
    expect(stops).toBe(0);
    t.doc.visibilityState = "hidden";
    for (const handler of t.doc.handlers) handler();
    expect(stops).toBe(1);
  });

  test("stops on pagehide, and the listeners are removed on cleanup", () => {
    const t = targets("visible");
    let stops = 0;
    const remove = stopWhenHidden({ stop: () => (stops += 1) }, t);
    for (const handler of t.win.handlers) handler();
    expect(stops).toBe(1);
    remove();
    expect(t.doc.handlers.size).toBe(0);
    expect(t.win.handlers.size).toBe(0);
  });
});

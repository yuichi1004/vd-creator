import type { ProposalView, TakeInfo, TrialBase } from "@vd-creator/server";
import { describe, expect, test } from "vitest";
import { ApiClient } from "./client.js";
import { stopWhenHidden } from "./contextAudio.js";
import { RetakeController } from "./retake.js";

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

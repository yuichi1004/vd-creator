import type {
  ConfirmRequiredError,
  GeneratePlanResponse,
  GenerateRequest,
  GenerateRunResponse,
  ProviderInfo,
} from "@vd-creator/server";
import { describe, expect, test } from "vitest";
import { ApiClient } from "./client.js";
import { confirmLabel, nothingSummary, startGeneration } from "./generation.js";

const PAID: ProviderInfo = { id: "elevenlabs", paid: true };
const FREE: ProviderInfo = { id: "mock", paid: false };

function plan(
  provider: ProviderInfo,
  status: "to-generate" | "cached" = "to-generate",
  characters = 42,
): GeneratePlanResponse {
  const cost =
    status === "to-generate" ? { characters, requests: 1 } : { characters: 0, requests: 0 };
  return {
    kind: "plan",
    provider,
    plan: {
      items: [
        status === "to-generate"
          ? { id: "l1", kind: "line", sceneId: "s1", status, cost }
          : { id: "l1", kind: "line", sceneId: "s1", status, file: "l1.mp3", durationSec: 1 },
      ],
      cost,
    },
  };
}

function run(provider: ProviderInfo): GenerateRunResponse {
  return {
    kind: "run",
    provider,
    items: [
      { id: "l1", kind: "line", sceneId: "s1", status: "generated", file: "a.mp3", durationSec: 1 },
    ],
    failed: 0,
  };
}

/**
 * A fake server that follows the rules of `GenerateRequest` and records each body. A paid
 * confirm runs only within `approved`. Setting `state.characters` stands for an edit of the
 * scenario between the plan and the confirm.
 */
function fakeServer(provider: ProviderInfo, status?: "to-generate" | "cached") {
  const bodies: GenerateRequest[] = [];
  const state = { characters: 42 };
  const client = new ApiClient("http://host/app/", async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as GenerateRequest;
    bodies.push(body);
    const current = plan(provider, status, state.characters);
    if (body.dryRun) return Response.json(current);
    const { cost } = current.plan;
    const approved = body.approved;
    if (
      provider.paid &&
      (body.confirm !== true ||
        approved === undefined ||
        cost.characters > approved.characters ||
        cost.requests > approved.requests)
    ) {
      const refusal: ConfirmRequiredError = {
        error: "confirm-required",
        message: "Paid generation needs confirm.",
        plan: current,
      };
      return Response.json(refusal, { status: 409 });
    }
    return Response.json(run(provider));
  });
  return { bodies, client, state };
}

describe("confirm step on a paid provider", () => {
  test("gets the plan first and generates only after confirm, with the numbers shown", async () => {
    const { bodies, client } = fakeServer(PAID);
    const start = await startGeneration(client, PAID, ["l1"]);

    expect(start.kind).toBe("confirm");
    expect(bodies).toEqual([{ ids: ["l1"], dryRun: true }]);
    if (start.kind !== "confirm") return;
    expect(start.changed).toBe(false);
    expect(confirmLabel(start.plan)).toBe("Generate (42 characters)");

    const result = await start.confirm();
    expect(result.kind).toBe("done");
    expect(bodies).toEqual([
      { ids: ["l1"], dryRun: true },
      { ids: ["l1"], confirm: true, approved: { characters: 42, requests: 1 } },
    ]);
  });

  test("nothing is sent with confirm until the user presses the button", async () => {
    const { bodies, client } = fakeServer(PAID);
    await startGeneration(client, PAID, ["l1"]);
    // The user cancels: confirm is never called.
    expect(bodies.some((b) => b.confirm === true)).toBe(false);
    expect(bodies.every((b) => b.dryRun === true)).toBe(true);
  });

  test("a confirm refused because the plan grew shows the new numbers to confirm again", async () => {
    const { bodies, client, state } = fakeServer(PAID);
    const start = await startGeneration(client, PAID, ["l1"]);
    if (start.kind !== "confirm") throw new Error("expected the confirm step");

    // The line is edited between the plan and the confirm.
    state.characters = 60;
    const again = await start.confirm();
    expect(again.kind).toBe("confirm");
    if (again.kind !== "confirm") return;
    expect(again.changed).toBe(true);
    expect(confirmLabel(again.plan)).toBe("Generate (60 characters)");
    expect(bodies.at(-1)).toEqual({
      ids: ["l1"],
      confirm: true,
      approved: { characters: 42, requests: 1 },
    });

    const result = await again.confirm();
    expect(result.kind).toBe("done");
    expect(bodies.at(-1)).toEqual({
      ids: ["l1"],
      confirm: true,
      approved: { characters: 60, requests: 1 },
    });
  });

  test("uses the plan in a 409 body when a provider thought free turns out paid", async () => {
    const { bodies, client } = fakeServer(PAID);
    const start = await startGeneration(client, FREE, ["l1"]);
    expect(start.kind).toBe("confirm");
    expect(bodies).toEqual([{ ids: ["l1"] }]);
    if (start.kind !== "confirm") return;
    expect(start.plan.plan.cost.characters).toBe(42);
    expect((await start.confirm()).kind).toBe("done");
    expect(bodies.at(-1)).toEqual({
      ids: ["l1"],
      confirm: true,
      approved: { characters: 42, requests: 1 },
    });
  });
});

describe("nothing to generate", () => {
  test("a paid plan without to-generate items needs no confirm", async () => {
    const { bodies, client } = fakeServer(PAID, "cached");
    const start = await startGeneration(client, PAID, ["l1"]);
    expect(start.kind).toBe("nothing");
    expect(bodies).toEqual([{ ids: ["l1"], dryRun: true }]);
  });

  test("a 409 plan without to-generate items needs no confirm either", async () => {
    const { bodies, client } = fakeServer(PAID, "cached");
    const start = await startGeneration(client, FREE, ["l1"]);
    expect(start.kind).toBe("nothing");
    expect(bodies.some((b) => b.confirm === true)).toBe(false);
  });
});

describe("free provider", () => {
  test("a regenerate sends one request", async () => {
    const { bodies, client } = fakeServer(FREE);
    const start = await startGeneration(client, FREE, ["l1"]);
    expect(start.kind).toBe("done");
    expect(bodies).toEqual([{ ids: ["l1"] }]);
  });

  test("without IDs, generates everything", async () => {
    const { bodies, client } = fakeServer(FREE);
    await startGeneration(client, FREE);
    expect(bodies).toEqual([{}]);
  });
});

test("other errors are passed on", async () => {
  const client = new ApiClient("http://host/", async () =>
    Response.json({ error: "server-error", message: "Generation failed." }, { status: 500 }),
  );
  await expect(startGeneration(client, FREE, ["l1"])).rejects.toThrow("Generation failed.");
});

test("the nothing-to-generate message names unresolved and invalid items", () => {
  const response = (items: GeneratePlanResponse["plan"]["items"]): GeneratePlanResponse => ({
    kind: "plan",
    provider: PAID,
    plan: { items, cost: { characters: 0, requests: 0 } },
  });
  const cached = {
    id: "l1",
    kind: "line",
    sceneId: "s1",
    status: "cached",
    file: "a.mp3",
    durationSec: 1,
  } as const;
  expect(nothingSummary(response([cached]))).toBe("Nothing to generate.");
  expect(
    nothingSummary(
      response([
        cached,
        { id: "x1", kind: "sfx", sceneId: "s1", status: "unresolved", reason: "r" },
        { id: "x2", kind: "sfx", sceneId: "s1", status: "unresolved", reason: "r" },
        { id: "l2", kind: "line", sceneId: "s1", status: "invalid", reason: "r" },
      ]),
    ),
  ).toBe("Nothing to generate: 2 unresolved, 1 invalid.");
});

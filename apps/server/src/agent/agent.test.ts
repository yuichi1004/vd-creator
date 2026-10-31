import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChangeEntry, readEntries, readTakes } from "@vd-creator/core";
import { SCENARIO_FILE } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  ApiError,
  CancelAgentResponse,
  ChangesResponse,
  DiscardProposalResponse,
  ProjectResponse,
  ProposalResponse,
  ServerInfoResponse,
  TakesResponse,
  TrialResponse,
} from "../api.js";
import { type AppOptions, createApp, type ServerProviders } from "../app.js";
import { parseAnswer } from "./answer.js";
import { CLAUDE_ARGS } from "./command.js";
import { MAX_PROPOSALS, PROPOSAL_TTL_MS, ProposalStore } from "./proposals.js";
import { runAgent } from "./runner.js";

const SAMPLE = fileURLToPath(
  new URL("../../../../packages/scenario/fixtures/sample.yaml", import.meta.url),
);
const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const LINE = "s1-l1";
const UNUSABLE = "The agent's answer could not be used";
const MARKER = "SECRET-FROM-AGENT";

const PARAMETERS = [
  { key: "stability", label: "Stability", kind: "number", min: 0, max: 1, step: 0.5 },
  { key: "style", label: "Style", kind: "number", min: 0, max: 1, step: 0.1 },
  { key: "speed", label: "Speed", kind: "number", values: [0.8, 1, 1.2] },
  { key: "boost", label: "Boost", kind: "on-off" },
] as const;

let dir: string;
let project: string;
let agentDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-server-agent-"));
  project = join(dir, "project");
  agentDir = join(dir, "agent");
  await mkdir(project);
  await mkdir(agentDir);
  await writeFile(join(project, SCENARIO_FILE), await readFile(SAMPLE, "utf8"));
  process.env.FAKE_AGENT_DIR = agentDir;
});

afterEach(async () => {
  delete process.env.FAKE_AGENT_DIR;
  delete process.env.FAKE_AGENT_MODE;
  delete process.env.FAKE_AGENT_RESULT;
  delete process.env.FAKE_AGENT_RAW;
  await rm(dir, { recursive: true, force: true });
});

/** Fake providers. Nothing here calls a real API. */
function fakeProviders(): ServerProviders {
  const audio = async () => ({
    data: new Uint8Array([1, 2, 3]),
    format: "wav" as const,
    durationSec: 1,
    meta: {},
  });
  const cost = () => ({ characters: 1, requests: 1 });
  return {
    tts: {
      id: "fake",
      paid: false,
      estimate: (req) => ({ characters: req.text.length, requests: 1 }),
      synthesize: audio,
      voiceParameters: () => PARAMETERS.map((p) => ({ ...p })),
    },
    sfx: { id: "fake", paid: false, estimate: cost, generate: audio },
    music: { id: "fake", paid: false, estimate: cost, generate: audio },
  } as ServerProviders;
}

function makeApp(options: Partial<AppOptions> = {}, withAgent = true) {
  const app = createApp({
    projectDir: project,
    provider: fakeProviders(),
    ...(withAgent
      ? {
          agent: {
            command: "claude" as const,
            timeoutSec: 30,
            killGraceMs: 200,
            launch: { file: process.execPath, args: [FAKE_AGENT] },
          },
        }
      : {}),
    ...options,
  });
  return (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Host: "localhost:5310" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}
type Call = ReturnType<typeof makeApp>;

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const scenarioText = () => readFile(join(project, SCENARIO_FILE), "utf8");

function answer(fields: Record<string, unknown>): void {
  process.env.FAKE_AGENT_MODE = "ok";
  process.env.FAKE_AGENT_RESULT = JSON.stringify(fields);
}

type AgentRecord = {
  argv: string[];
  stdin: string;
  cwd: string;
  cwdFiles: string[];
  pid: number;
  childPid?: number;
};
const record = async (): Promise<AgentRecord> =>
  JSON.parse(await readFile(join(agentDir, "record.json"), "utf8")) as AgentRecord;

async function waitFor(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waited too long");
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const started = () => waitFor(() => existsSync(join(agentDir, "record.json")));

const propose = (call: Call, instruction = "Make it softer, please") =>
  call("POST", `/api/items/${LINE}/proposals`, { instruction });

const outcomes = async (): Promise<string[]> =>
  (await readEntries(project)).flatMap((e) =>
    e.source === "ui" && e.change === "instruction-outcome" ? [e.outcome] : [],
  );

const GOOD = { direction: "softly", reason: "Softer, as asked", settings: { stability: 0.5 } };

describe("a proposal", () => {
  test("reaches the agent only through stdin, in a new empty folder that is removed", async () => {
    answer(GOOD);
    const call = makeApp();
    const before = await scenarioText();
    const response = await propose(call, "Make it softer, please");
    expect(response.status).toBe(200);
    const { proposal } = await json<ProposalResponse>(response);
    expect(proposal).toMatchObject(GOOD);
    expect(proposal.base).toMatchObject({ take: 0 });

    const seen = await record();
    // The request text is in the input, and in no argument.
    expect(seen.stdin).toContain("Make it softer, please");
    expect(seen.stdin).toContain("stability");
    expect(seen.argv.join(" ")).not.toContain("softer");
    expect(seen.argv).toEqual([...CLAUDE_ARGS]);
    // A new, empty folder that is not the project, and gone after the run.
    expect(seen.cwdFiles).toEqual([]);
    expect(seen.cwd).not.toBe(project);
    expect(existsSync(seen.cwd)).toBe(false);
    // Nothing in scenario.yaml changes before Keep.
    expect(await scenarioText()).toBe(before);
  });

  test("the argument list holds the no-tools flags", () => {
    const at = (flag: string) => CLAUDE_ARGS.indexOf(flag);
    expect(CLAUDE_ARGS).toContain("-p");
    expect(CLAUDE_ARGS[at("--output-format") + 1]).toBe("json");
    // All built-in tools off.
    expect(CLAUDE_ARGS[at("--tools") + 1]).toBe("");
    // No MCP server, even a configured one.
    expect(CLAUDE_ARGS).toContain("--strict-mcp-config");
    expect(JSON.parse(CLAUDE_ARGS[at("--mcp-config") + 1] ?? "")).toEqual({ mcpServers: {} });
    expect(CLAUDE_ARGS).toContain("--restricted");
    expect(CLAUDE_ARGS).toContain("--safe-mode");
    expect(CLAUDE_ARGS).toContain("--disable-slash-commands");
    expect(CLAUDE_ARGS).toContain("--no-session-persistence");
  });

  test("is logged as an instruction with its outcome, without marking the line", async () => {
    answer(GOOD);
    const call = makeApp();
    await propose(call, "Make it softer, please");
    const entries = await readEntries(project);
    const instruction = entries.find((e) => e.source === "ui" && e.change === "instruction");
    expect(instruction).toMatchObject({
      target: { kind: "item", id: LINE },
      text: "Make it softer, please",
    });
    expect(await outcomes()).toEqual(["proposed"]);

    const project1 = await json<ProjectResponse>(await call("GET", "/api/project"));
    expect(project1.changedSinceReview).toEqual([]);
    // The API sends them, since it sends every entry; they mark nothing.
    const changes = await json<ChangesResponse>(await call("GET", "/api/changes?since=start"));
    expect(changes.entries.map((e) => ("change" in e ? e.change : e.source))).toEqual([
      "instruction",
      "instruction-outcome",
    ]);
  });

  test("refuses answers outside the schema, with fixed text only", async () => {
    const call = makeApp();
    const bad: unknown[] = [
      // An unknown parameter, a value out of range, off the step, and of the wrong type.
      { settings: { pitch: 1 }, reason: MARKER },
      { settings: { stability: 2 }, reason: MARKER },
      { settings: { stability: 0.3 }, reason: MARKER },
      { settings: { speed: 0.9 }, reason: MARKER },
      { settings: { stability: true }, reason: MARKER },
      { settings: { boost: 1 }, reason: MARKER },
      { settings: {}, reason: MARKER },
      // Unknown key, missing or long reason, long text and direction, nothing proposed.
      { text: "hi", reason: MARKER, extra: 1 },
      { text: "hi" },
      { text: "hi", reason: "r".repeat(301) },
      { text: "t".repeat(501), reason: MARKER },
      { direction: "d".repeat(301), reason: MARKER },
      { reason: MARKER },
    ];
    for (const fields of bad) {
      answer(fields as Fields);
      const response = await propose(call);
      expect(response.status, JSON.stringify(fields)).toBe(500);
      const body = await json<ApiError>(response);
      expect(body.message).toBe(UNUSABLE);
      expect(JSON.stringify(body)).not.toContain(MARKER);
    }
    expect(new Set(await outcomes())).toEqual(new Set(["failed"]));
  });

  test("refuses text around the JSON, and answers that are not JSON", async () => {
    const call = makeApp();
    const json1 = JSON.stringify(GOOD);
    const raws = [
      `Here you go: ${json1}`,
      `${json1} Hope that helps ${MARKER}`,
      `\`\`\`json\n${json1}\n\`\`\``,
      "[]",
      MARKER,
    ];
    for (const result of raws) {
      process.env.FAKE_AGENT_MODE = "ok";
      process.env.FAKE_AGENT_RESULT = result;
      const response = await propose(call);
      expect(response.status, result).toBe(500);
      const body = await json<ApiError>(response);
      expect(body.message).toBe(UNUSABLE);
      expect(JSON.stringify(body)).not.toContain(MARKER);
    }
    // An envelope that reports an error, and output that is not an envelope.
    process.env.FAKE_AGENT_MODE = "raw";
    const envelope = { type: "result", subtype: "success", is_error: false, result: json1 };
    const { subtype: _s, ...noSubtype } = envelope;
    const { is_error: _e, ...noIsError } = envelope;
    for (const raw of [
      JSON.stringify({ ...envelope, is_error: true }),
      JSON.stringify({ ...envelope, result: 5 }),
      JSON.stringify(noSubtype),
      JSON.stringify(noIsError),
      JSON.stringify({ ...envelope, subtype: "error_max_turns" }),
      JSON.stringify({ ...envelope, type: "assistant" }),
      JSON.stringify({ result: json1 }),
      json1,
      "",
    ]) {
      process.env.FAKE_AGENT_RAW = raw;
      const response = await propose(call);
      expect(response.status, raw).toBe(500);
      expect((await json<ApiError>(response)).message).toBe(UNUSABLE);
    }
  });

  test("a failing agent is reported with fixed text, and its folder is removed", async () => {
    process.env.FAKE_AGENT_MODE = "fail";
    const call = makeApp();
    const response = await propose(call);
    expect(response.status).toBe(500);
    const body = await json<ApiError>(response);
    expect(body.message).toBe(UNUSABLE);
    expect(JSON.stringify(body)).not.toContain(MARKER);
    expect(existsSync((await record()).cwd)).toBe(false);
    expect(await outcomes()).toEqual(["failed"]);
  });

  test("a list of lines and a long instruction are checked before the agent runs", async () => {
    answer(GOOD);
    const call = makeApp();
    expect((await propose(call, "")).status).toBe(400);
    expect((await propose(call, "x".repeat(1001))).status).toBe(400);
    expect((await call("POST", `/api/items/${LINE}/proposals`, { other: 1 })).status).toBe(400);
    expect((await call("POST", "/api/items/nope/proposals", { instruction: "x" })).status).toBe(
      404,
    );
    expect(existsSync(join(agentDir, "record.json"))).toBe(false);
    expect(await readEntries(project)).toEqual([]);
  });
});

describe("without an agent", () => {
  test("the routes are 404 and the server names no agent", async () => {
    const call = makeApp({}, false);
    expect((await propose(call)).status).toBe(404);
    expect((await call("POST", "/api/agent-run/cancel", {})).status).toBe(404);
    expect((await call("POST", "/api/proposals/p1/discard", {})).status).toBe(404);
    const info = await json<ServerInfoResponse>(await call("GET", "/api/server"));
    expect(info.agent).toBeUndefined();
  });

  test("with an agent, GET /api/server names its command", async () => {
    const info = await json<ServerInfoResponse>(await makeApp()("GET", "/api/server"));
    expect(info.agent).toEqual({ command: "claude" });
  });
});

describe("one run at a time", () => {
  test("a second run during the first is 409 busy, and cancel ends the first", async () => {
    process.env.FAKE_AGENT_MODE = "hang";
    const call = makeApp();
    const first = propose(call);
    await started();
    const second = await propose(call);
    expect(second.status).toBe(409);
    expect((await json<ApiError>(second)).error).toBe("busy");

    const cancelled = await call("POST", "/api/agent-run/cancel", {});
    expect(await json<CancelAgentResponse>(cancelled)).toEqual({ cancelled: true });
    const ended = await first;
    expect(ended.status).toBe(500);
    expect((await json<ApiError>(ended)).message).toBe("The agent run was cancelled");
    const seen = await record();
    await waitFor(() => !alive(seen.pid));
    expect(existsSync(seen.cwd)).toBe(false);
    expect(await outcomes()).toEqual(["cancelled"]);

    // Nothing is running now, and the next run is allowed.
    expect(
      await json<CancelAgentResponse>(await call("POST", "/api/agent-run/cancel", {})),
    ).toEqual({ cancelled: false });
    answer(GOOD);
    expect((await propose(call)).status).toBe(200);
  });

  test("cancel ends a child process of the agent too", async () => {
    process.env.FAKE_AGENT_MODE = "child";
    const call = makeApp();
    const run = propose(call);
    await started();
    const seen = await record();
    const child = seen.childPid ?? 0;
    expect(child).toBeGreaterThan(0);
    expect(alive(seen.pid)).toBe(true);
    expect(alive(child)).toBe(true);

    await call("POST", "/api/agent-run/cancel", {});
    await run;
    await waitFor(() => !alive(seen.pid) && !alive(child));
    expect(existsSync(seen.cwd)).toBe(false);
  });

  test("an agent that ignores SIGTERM gets SIGKILL", async () => {
    process.env.FAKE_AGENT_MODE = "stubborn";
    const call = makeApp();
    const run = propose(call);
    await started();
    const seen = await record();
    await call("POST", "/api/agent-run/cancel", {});
    await run;
    await waitFor(() => !alive(seen.pid));
  });

  test("a timeout ends the process and is 504", async () => {
    process.env.FAKE_AGENT_MODE = "child";
    const call = makeApp({
      agent: {
        command: "claude",
        timeoutSec: 0.4,
        killGraceMs: 200,
        launch: { file: process.execPath, args: [FAKE_AGENT] },
      },
    });
    const response = await propose(call);
    expect(response.status).toBe(504);
    expect((await json<ApiError>(response)).error).toBe("timeout");
    const seen = await record();
    await waitFor(() => !alive(seen.pid) && !alive(seen.childPid ?? 0));
    expect(existsSync(seen.cwd)).toBe(false);
    expect(await outcomes()).toEqual(["failed"]);
  });

  test("output past 64 KB fails the run, and so does too much error output", async () => {
    const call = makeApp();
    process.env.FAKE_AGENT_MODE = "big";
    const response = await propose(call);
    expect(response.status).toBe(500);
    expect((await json<ApiError>(response)).message).toBe(UNUSABLE);
    const seen = await record();
    await waitFor(() => !alive(seen.pid));
    expect(existsSync(seen.cwd)).toBe(false);

    for (const mode of ["big", "bigerr"]) {
      process.env.FAKE_AGENT_MODE = mode;
      const result = await runAgent({
        file: process.execPath,
        args: [FAKE_AGENT],
        prompt: "x",
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        killGraceMs: 200,
      });
      expect(result).toEqual({ status: "failed" });
    }
  });

  test("a run that was cancelled before it started never starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent({
      file: process.execPath,
      args: [FAKE_AGENT],
      prompt: "x",
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(result).toEqual({ status: "cancelled" });
    expect(existsSync(join(agentDir, "record.json"))).toBe(false);
  });
});

/** A proposal, a trial made from it, and what the log and the file say at each step. */
async function proposeAndTry(call: Call) {
  answer({ text: "Is anyone up there?", direction: "softly", reason: "Softer, as asked" });
  const { proposal } = await json<ProposalResponse>(await propose(call));
  const trial = await call("POST", `/api/items/${LINE}/trials`, {
    base: proposal.base,
    text: proposal.text,
    direction: proposal.direction,
    proposalId: proposal.id,
    confirm: true,
  });
  return { proposal, trial };
}

describe("outcomes in the change log", () => {
  test("a trial is logged as tried once, and a kept trial carries the reason", async () => {
    const call = makeApp();
    const before = await scenarioText();
    const { proposal, trial } = await proposeAndTry(call);
    expect(trial.status).toBe(200);
    // A second trial of the same proposal is another take, and not another outcome.
    const again = await call("POST", `/api/items/${LINE}/trials`, {
      base: proposal.base,
      text: proposal.text,
      direction: proposal.direction,
      proposalId: proposal.id,
      confirm: true,
    });
    expect(again.status).toBe(200);
    expect(await outcomes()).toEqual(["proposed", "tried"]);
    // Nothing in scenario.yaml changes before Keep.
    expect(await scenarioText()).toBe(before);

    const key = (await json<TrialResponse>(trial)).key;
    const kept = await call("PATCH", `/api/items/${LINE}`, {
      restore: { key, base: proposal.base },
    });
    expect(kept.status).toBe(200);
    expect(await scenarioText()).toContain("softly");
    expect(await outcomes()).toEqual(["proposed", "tried", "kept"]);

    const entries = await readEntries(project);
    const edits = entries.filter((e) => e.source === "ui" && e.change === "edited");
    expect(edits.length).toBeGreaterThan(0);
    for (const e of edits) {
      expect(e).toMatchObject({ reason: "Softer, as asked" });
    }
    // The user's changes carry the reason, and the instruction's entries mark nothing.
    const marked = await json<ProjectResponse>(await call("GET", "/api/project"));
    expect(marked.changedSinceReview).toEqual([{ kind: "item", id: LINE, count: edits.length }]);
  });

  test("the reason is kept with the take after the proposal has left memory", async () => {
    let now = 1_000_000;
    const call = makeApp({
      agent: {
        command: "claude",
        timeoutSec: 30,
        killGraceMs: 200,
        now: () => now,
        launch: { file: process.execPath, args: [FAKE_AGENT] },
      },
    });
    const { proposal, trial } = await proposeAndTry(call);
    const key = (await json<TrialResponse>(trial)).key;
    now += PROPOSAL_TTL_MS + 1;
    // The proposal is gone: it cannot be discarded to memory, but the history has the reason.
    const kept = await call("PATCH", `/api/items/${LINE}`, {
      restore: { key, base: proposal.base },
    });
    expect(kept.status).toBe(200);
    expect(await outcomes()).toEqual(["proposed", "tried", "kept"]);
    const entries = await readEntries(project);
    expect(entries.some((e) => JSON.stringify(e).includes("Softer, as asked"))).toBe(true);
    const takes = await json<TakesResponse>(await call("GET", `/api/items/${LINE}/takes`));
    expect(takes.takes.some((t) => t.proposalId === proposal.id)).toBe(true);
  });

  test("a discard is logged once, without the proposal's content", async () => {
    answer({
      text: "PROPOSED-MARKER-TEXT",
      direction: "PROPOSED-MARKER-DIRECTION",
      reason: "PROPOSED-MARKER-REASON",
    });
    const call = makeApp();
    const { proposal } = await json<ProposalResponse>(await propose(call));
    const first = await call("POST", `/api/proposals/${proposal.id}/discard`, {});
    expect(first.status).toBe(200);
    expect(await json<DiscardProposalResponse>(first)).toEqual({ discarded: true });
    expect((await call("POST", `/api/proposals/${proposal.id}/discard`, {})).status).toBe(200);
    expect(await outcomes()).toEqual(["proposed", "discarded"]);

    const log = await readFile(join(project, "changes.jsonl"), "utf8");
    expect(log).not.toContain("PROPOSED-MARKER");
    const entries: ChangeEntry[] = await readEntries(project);
    const discarded = entries.at(-1);
    expect(Object.keys(discarded ?? {}).sort()).toEqual(
      ["change", "id", "instructionId", "outcome", "source", "target", "time"].sort(),
    );
  });

  test("a discard after the keep logs nothing more, and unknown proposals are 404", async () => {
    const call = makeApp();
    const { proposal, trial } = await proposeAndTry(call);
    const key = (await json<TrialResponse>(trial)).key;
    await call("PATCH", `/api/items/${LINE}`, { restore: { key, base: proposal.base } });
    expect((await call("POST", `/api/proposals/${proposal.id}/discard`, {})).status).toBe(200);
    expect(await outcomes()).toEqual(["proposed", "tried", "kept"]);

    expect((await call("POST", "/api/proposals/nope/discard", {})).status).toBe(404);
    expect((await call("POST", "/api/proposals/bad id!/discard", {})).status).toBe(404);
    expect((await call("POST", `/api/proposals/${proposal.id}/discard`, { x: 1 })).status).toBe(
      400,
    );
  });

  test("a failed instruction cannot be discarded, and a trial of it is not logged as tried", async () => {
    process.env.FAKE_AGENT_MODE = "fail";
    const call = makeApp();
    await propose(call);
    const entries = await readEntries(project);
    const id = entries.find((e) => e.source === "ui" && e.change === "instruction");
    const instructionId = id && "instructionId" in id ? id.instructionId : "";
    expect((await call("POST", `/api/proposals/${instructionId}/discard`, {})).status).toBe(404);
    expect(await outcomes()).toEqual(["failed"]);
  });
});

const agentFolders = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("vd-agent-"));

describe("fix round 1", () => {
  test("an abort right after runAgent is called cancels it before the agent starts", async () => {
    const before = new Set(agentFolders());
    const controller = new AbortController();
    const running = runAgent({
      file: process.execPath,
      args: [FAKE_AGENT],
      prompt: "x",
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    // The folder is being made; no listener has seen the abort.
    controller.abort();
    expect(await running).toEqual({ status: "cancelled" });
    expect(existsSync(join(agentDir, "record.json"))).toBe(false);
    expect(agentFolders().filter((n) => !before.has(n))).toEqual([]);
  });

  test("a proposal can be tried only on its own line while it is live", async () => {
    const call = makeApp();
    answer({ direction: "softly", reason: "Softer" });
    const { proposal } = await json<ProposalResponse>(await propose(call));
    const other = await json<ProjectResponse>(await call("GET", "/api/project"));
    const item = other.scenario?.scenes[1]?.items.find((i) => i.id === "s2-l1");
    if (!item || !("line" in item)) throw new Error("no s2-l1");
    const trial = (id: string, base: unknown, proposalId: string) =>
      call("POST", `/api/items/${id}/trials`, {
        base,
        direction: "softly",
        proposalId,
        confirm: true,
      });

    // Another line, an unknown ID: nothing is generated or stored.
    const otherBase = { speaker: item.speaker, text: item.line, take: item.take ?? 0 };
    for (const [id, base, proposalId] of [
      ["s2-l1", otherBase, proposal.id],
      [LINE, proposal.base, "unknown-proposal"],
    ] as const) {
      const refused = await trial(id, base, proposalId);
      expect(refused.status).toBe(409);
      expect((await json<ApiError>(refused)).error).toBe("proposal-gone");
    }
    expect(await readTakes(project)).toEqual([]);
    expect(await outcomes()).toEqual(["proposed"]);

    // A discarded proposal.
    await call("POST", `/api/proposals/${proposal.id}/discard`, {});
    const discarded = await trial(LINE, proposal.base, proposal.id);
    expect(discarded.status).toBe(409);
    expect((await json<ApiError>(discarded)).error).toBe("proposal-gone");
    expect(await readTakes(project)).toEqual([]);
  });

  test("an expired proposal cannot be tried", async () => {
    let now = 1_000_000;
    const call = makeApp({
      agent: {
        command: "claude",
        timeoutSec: 30,
        killGraceMs: 200,
        now: () => now,
        launch: { file: process.execPath, args: [FAKE_AGENT] },
      },
    });
    answer({ direction: "softly", reason: "Softer" });
    const { proposal } = await json<ProposalResponse>(await propose(call));
    now += PROPOSAL_TTL_MS + 1;
    const response = await call("POST", `/api/items/${LINE}/trials`, {
      base: proposal.base,
      direction: "softly",
      proposalId: proposal.id,
      confirm: true,
    });
    expect(response.status).toBe(409);
    expect((await json<ApiError>(response)).error).toBe("proposal-gone");
    expect(await readTakes(project)).toEqual([]);
  });

  test("a server shutdown ends the agent, its child, and the folder", async () => {
    process.env.FAKE_AGENT_MODE = "child";
    const shutdown = new AbortController();
    const call = makeApp({ signal: shutdown.signal });
    const run = propose(call);
    await started();
    const seen = await record();
    expect(alive(seen.pid)).toBe(true);
    shutdown.abort();
    const ended = await run;
    expect(ended.status).toBe(500);
    await waitFor(() => !alive(seen.pid) && !alive(seen.childPid ?? 0));
    expect(existsSync(seen.cwd)).toBe(false);
    expect(await outcomes()).toEqual(["cancelled"]);
  });

  test("the shutdown listener is removed after a run", async () => {
    const shutdown = new AbortController();
    const remove = vi.spyOn(shutdown.signal, "removeEventListener");
    answer(GOOD);
    const call = makeApp({ signal: shutdown.signal });
    expect((await propose(call)).status).toBe(200);
    expect(remove.mock.calls.filter(([type]) => type === "abort").length).toBeGreaterThan(0);
  });

  test("a server that is already shut down never starts the agent", async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    answer(GOOD);
    const call = makeApp({ signal: shutdown.signal });
    expect((await propose(call)).status).toBe(500);
    expect(existsSync(join(agentDir, "record.json"))).toBe(false);
  });
});

describe("answers", () => {
  test("the proposal of a valid answer keeps only the schema's keys", () => {
    const result = parseAnswer(
      JSON.stringify(GOOD),
      PARAMETERS.map((p) => ({ ...p })),
    );
    expect(result).toEqual({ ok: true, proposal: GOOD });
    const on = parseAnswer(
      JSON.stringify({ settings: { boost: true, speed: 1.2, style: 0.3 }, reason: "r" }),
      PARAMETERS.map((p) => ({ ...p })),
    );
    expect(on.ok).toBe(true);
  });
});

describe("the proposal store", () => {
  test("keeps 20 proposals for 30 minutes", () => {
    let now = 0;
    const store = new ProposalStore(() => now);
    for (let i = 0; i < MAX_PROPOSALS + 3; i++)
      store.add(`p${i}`, LINE, { text: "t", reason: "r" });
    expect(store.get("p0")).toBeUndefined();
    expect(store.get("p2")).toBeUndefined();
    expect(store.get("p3")).toBeDefined();
    expect(store.get(`p${MAX_PROPOSALS + 2}`)).toBeDefined();
    now += PROPOSAL_TTL_MS - 1;
    expect(store.get("p3")).toBeDefined();
    now += 1;
    expect(store.get("p3")).toBeUndefined();
    expect(store.delete("p4")).toBe(false);
  });
});

type Fields = Record<string, unknown>;

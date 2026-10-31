// Runs the agent's command once. See "Agent proposals" in
// docs/plans/0013-voice-retake-with-agent.md.
//
// The command and its arguments are fixed by the caller, and no shell is used. The prompt goes
// in through stdin only, so no request text is ever in an argument list. The command runs in a
// new, empty folder and in its own process group, so that cancel and timeout end its children too.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The most the agent may print on stdout, and on stderr. A run that prints more fails. */
export const MAX_STDOUT_BYTES = 64 * 1024;
export const MAX_STDERR_BYTES = 16 * 1024;

/** How long a stopped run has to end after SIGTERM before it gets SIGKILL. */
export const KILL_GRACE_MS = 5000;

export type AgentRunSpec = {
  file: string;
  args: readonly string[];
  /** Written to stdin. */
  prompt: string;
  timeoutMs: number;
  /** Aborting it cancels the run. */
  signal: AbortSignal;
  killGraceMs?: number;
};

export type AgentRunResult =
  | { status: "ok"; stdout: string }
  | { status: "timeout" | "cancelled" | "failed" };

/**
 * Runs the command with `prompt` on stdin. The result says how it ended; no output other than
 * a successful run's stdout is returned. The working folder is removed after every run.
 */
export async function runAgent(spec: AgentRunSpec): Promise<AgentRunResult> {
  if (spec.signal.aborted) return { status: "cancelled" };
  const cwd = await mkdtemp(join(tmpdir(), "vd-agent-"));
  try {
    return await run(spec, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function run(spec: AgentRunSpec, cwd: string): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.file, [...spec.args], {
      cwd,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopped: "timeout" | "cancelled" | "failed" | undefined;
    let escalate: NodeJS.Timeout | undefined;

    // The process group has the ID of its leader.
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone.
      }
    };
    const stop = (why: "timeout" | "cancelled" | "failed") => {
      if (stopped) return;
      stopped = why;
      signalGroup("SIGTERM");
      escalate = setTimeout(() => signalGroup("SIGKILL"), spec.killGraceMs ?? KILL_GRACE_MS);
    };

    const timer = setTimeout(() => stop("timeout"), spec.timeoutMs);
    const onAbort = () => stop("cancelled");
    spec.signal.addEventListener("abort", onAbort, { once: true });

    // Whatever the leader left running is ended with it.
    child.on("exit", () => signalGroup("SIGKILL"));
    child.on("error", () => {
      clearTimeout(timer);
      clearTimeout(escalate);
      spec.signal.removeEventListener("abort", onAbort);
      resolve({ status: stopped ?? "failed" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(escalate);
      spec.signal.removeEventListener("abort", onAbort);
      if (stopped) resolve({ status: stopped });
      else if (code === 0)
        resolve({ status: "ok", stdout: Buffer.concat(chunks).toString("utf8") });
      else resolve({ status: "failed" });
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) stop("failed");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // The text is never used, only counted.
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) stop("failed");
    });
    // The agent may exit without reading its input.
    child.stdin.on("error", () => {});
    child.stdin.end(spec.prompt);
  });
}

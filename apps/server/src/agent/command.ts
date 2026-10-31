// How each agent command is started. The command and its arguments are fixed here; nothing
// from a request is ever added to them. See "Agent proposals" in
// docs/plans/0013-voice-retake-with-agent.md and the flags in docs/plans/0008-user-config.md.

import type { AgentCommand } from "../api.js";

export type AgentOptions = {
  command: AgentCommand;
  /** From 10 to 600. */
  timeoutSec: number;
  /**
   * A seam for tests: another program to run in place of the command, with arguments that go
   * before the fixed ones. The CLI never sets it.
   */
  launch?: { file: string; args?: readonly string[] };
  /** The clock of the proposal store, in milliseconds. Tests replace it. */
  now?: () => number;
  /** Milliseconds between SIGTERM and SIGKILL of a stopped run. Tests shorten it. */
  killGraceMs?: number;
};

/**
 * The arguments of `claude`: print mode with a JSON envelope; every built-in tool off; no MCP
 * server, not even a configured one; no user, project, or local settings, no hooks, plugins,
 * `CLAUDE.md`, or skills; no slash commands; no saved session. `--bare` is not used because it
 * would also drop the login.
 */
export const CLAUDE_ARGS: readonly string[] = [
  "-p",
  "--output-format",
  "json",
  "--tools",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--restricted",
  "--safe-mode",
  "--disable-slash-commands",
  "--no-session-persistence",
];

/** The program and the whole argument list for a run. */
export function launchOf(agent: AgentOptions): { file: string; args: string[] } {
  return {
    file: agent.launch?.file ?? agent.command,
    args: [...(agent.launch?.args ?? []), ...CLAUDE_ARGS],
  };
}

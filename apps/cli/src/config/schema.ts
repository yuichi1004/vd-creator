// The schema of config.yaml in the user directory. See docs/plans/0008-user-config.md.

import { PUBLISH_USES } from "@vd-creator/scenario";
import { z } from "zod";

/** The config file in the user directory. */
export const CONFIG_FILE = "config.yaml";

/** The longest path a setting may hold, which is PATH_MAX on Linux. */
export const MAX_PATH_LENGTH = 4096;

/**
 * Matches one line of printable characters: no control, format, private-use, or unassigned
 * character, no lone surrogate, and no line or paragraph separator. So a value that passed the
 * schema can be printed on one line as it is.
 */
export const PRINTABLE_LINE = /^[^\p{C}\p{Zl}\p{Zp}]+$/u;

/** A host name: dot-separated labels of letters, digits, and inner hyphens (RFC 1123). */
const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * A path. ~ at the start is the home folder; a relative path is relative to the user directory.
 * One line of printable characters, at most `MAX_PATH_LENGTH` long.
 */
export const PathSchema = z.string().min(1).max(MAX_PATH_LENGTH).regex(PRINTABLE_LINE);

/** A host name or an IPv4 or IPv6 address, without brackets, a port, or a zone. */
export const HostSchema = z.union([z.string().regex(HOST_NAME), z.ipv6()]);

/** The agents that can answer instructions. codex is not one: see docs/plans/0008-user-config.md. */
export const AGENT_COMMANDS = ["claude"] as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[number];

/** The seconds an agent may take for one answer. */
export const AGENT_TIMEOUT_MIN = 10;
export const AGENT_TIMEOUT_MAX = 600;
export const AGENT_TIMEOUT_DEFAULT = 120;

/** A TCP port. */
export const PortSchema = z.number().int().min(1).max(65535);

/**
 * The content of config.yaml. Strict at every level, so an unknown key, such as a typo or a
 * pasted API key, is an error. There is deliberately no provider field: the provider stays mock
 * unless a command names another. Each field has the narrowest shape it needs, and every string
 * is one printable line, so that `vd config show` can print what passed.
 */
export const UserConfigSchema = z.strictObject({
  version: z.literal(1),
  library: PathSchema.optional().describe("Default for --library and VD_LIBRARY."),
  serve: z
    .strictObject({
      port: PortSchema.optional(),
      host: HostSchema.optional(),
    })
    .optional(),
  init: z
    .strictObject({
      publishUse: z.enum(PUBLISH_USES).optional().describe("Default publish.use for vd init."),
    })
    .optional(),
  agent: z
    .strictObject({
      command: z.enum(AGENT_COMMANDS).describe("The agent command that answers instructions."),
      timeoutSec: z
        .number()
        .int()
        .min(AGENT_TIMEOUT_MIN)
        .max(AGENT_TIMEOUT_MAX)
        .optional()
        .describe("Seconds the agent may take for one answer."),
    })
    .optional(),
  render: z
    .strictObject({
      creditsTemplate: PathSchema.optional().describe("Credits template for vd render."),
    })
    .optional(),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

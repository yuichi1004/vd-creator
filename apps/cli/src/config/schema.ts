// The schema of config.yaml in the user directory. See docs/plans/0008-user-config.md.

import { PUBLISH_USES } from "@vd-creator/scenario";
import { z } from "zod";

/** The config file in the user directory. */
export const CONFIG_FILE = "config.yaml";

const PathSchema = z
  .string()
  .min(1)
  .describe(
    "A path. ~ at the start is the home folder; a relative path is relative to the user directory.",
  );

/**
 * The content of config.yaml. Strict at every level, so an unknown key, such as a typo or a
 * pasted API key, is an error. There is deliberately no provider field: the provider stays mock
 * unless a command names another.
 */
export const UserConfigSchema = z.strictObject({
  version: z.literal(1),
  library: PathSchema.optional().describe("Default for --library and VD_LIBRARY."),
  serve: z
    .strictObject({
      port: z.number().int().min(1).max(65535).optional(),
      host: z.string().min(1).optional(),
    })
    .optional(),
  init: z
    .strictObject({
      publishUse: z.enum(PUBLISH_USES).optional().describe("Default publish.use for vd init."),
    })
    .optional(),
  render: z
    .strictObject({
      creditsTemplate: PathSchema.optional().describe("Credits template for vd render."),
    })
    .optional(),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

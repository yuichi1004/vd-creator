import { toJSONSchema } from "zod";
import { ScenarioSchema } from "./schema.js";

/**
 * The JSON Schema of scenario.yaml, generated from the Zod schema. The committed copy is
 * schema/scenario.schema.json; regenerate it with `npm run generate-schema -w packages/scenario`.
 */
export function scenarioJsonSchema(): Record<string, unknown> {
  return {
    ...toJSONSchema(ScenarioSchema, { io: "input", target: "draft-2020-12" }),
    title: "vd-creator scenario",
  };
}

import { toJSONSchema } from "zod";
import { ScenarioSchema, VoiceSettingsSchema } from "./schema.js";

// The values of voice settings. Validation checks them on the parsed data (see
// validate.ts), so the Zod schema leaves them open and the JSON Schema adds them here.
// JSON Schema cannot express finite numbers or acyclic data, and JSON has neither.
const JSON_VALUE = {
  description:
    "Plain JSON: a string, finite number, true, false, null, list, or mapping with string keys.",
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "array", items: { $ref: "#/$defs/JsonValue" } },
    { type: "object", additionalProperties: { $ref: "#/$defs/JsonValue" } },
  ],
};

/**
 * The JSON Schema of scenario.yaml, generated from the Zod schema. The committed copy is
 * schema/scenario.schema.json; regenerate it with `npm run generate-schema -w packages/scenario`.
 */
export function scenarioJsonSchema(): Record<string, unknown> {
  const schema = toJSONSchema(ScenarioSchema, {
    io: "input",
    target: "draft-2020-12",
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema === VoiceSettingsSchema) {
        jsonSchema.additionalProperties = { $ref: "#/$defs/JsonValue" };
      }
    },
  });
  return {
    ...schema,
    title: "vd-creator scenario",
    $defs: { ...schema.$defs, JsonValue: JSON_VALUE },
  };
}

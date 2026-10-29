import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { scenarioJsonSchema } from "./index.js";

test("the committed JSON Schema is up to date", async () => {
  const committed = JSON.parse(
    await readFile(new URL("../schema/scenario.schema.json", import.meta.url), "utf8"),
  );
  // If this fails, run `npm run generate-schema -w packages/scenario` and commit the result.
  expect(committed).toEqual(scenarioJsonSchema());
});

test("voice settings take any keys with plain JSON values", () => {
  // biome-ignore lint/suspicious/noExplicitAny: walks into the generated schema.
  const schema = scenarioJsonSchema() as any;
  const settings = schema.properties.speakers.items.properties.voice.properties.settings;
  expect(settings).toMatchObject({
    type: "object",
    additionalProperties: { $ref: "#/$defs/JsonValue" },
  });
  expect(schema.$defs.JsonValue.anyOf.map((s: { type: string }) => s.type)).toEqual([
    "string",
    "number",
    "boolean",
    "null",
    "array",
    "object",
  ]);
});

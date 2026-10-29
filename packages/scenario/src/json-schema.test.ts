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

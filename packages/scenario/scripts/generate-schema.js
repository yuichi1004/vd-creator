// Writes schema/scenario.schema.json from the built package. Run it through
// `npm run generate-schema -w packages/scenario`, which builds first.
import { mkdir, writeFile } from "node:fs/promises";
import { scenarioJsonSchema } from "../dist/index.js";

const dir = new URL("../schema/", import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(
  new URL("scenario.schema.json", dir),
  `${JSON.stringify(scenarioJsonSchema(), null, 2)}\n`,
);

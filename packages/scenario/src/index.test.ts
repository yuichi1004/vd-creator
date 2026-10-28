import { expect, test } from "vitest";
import { moduleName } from "./index.js";

test("exports its module name", () => {
  expect(moduleName).toBe("@vd-creator/scenario");
});

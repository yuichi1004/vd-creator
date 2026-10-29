import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseScenario } from "@vd-creator/scenario";
import { expect, test } from "vitest";
import { placeIssues } from "./issues.js";
import type { LicenseIssue, Scenario } from "./types.js";

const SAMPLE = fileURLToPath(
  new URL("../../../packages/scenario/fixtures/sample.yaml", import.meta.url),
);

async function sample(): Promise<Scenario> {
  const { scenario } = parseScenario(await readFile(SAMPLE, "utf8"));
  if (!scenario) throw new Error("the sample is not valid");
  return scenario as Scenario;
}

test("a license issue without a target is a general issue", async () => {
  const issue: LicenseIssue = {
    message: "credits.json is not valid; fix it or delete it",
    severity: "error",
  };
  const placed = placeIssues(await sample(), [], [issue]);
  expect(placed.general).toEqual([issue]);
  expect(placed.byItem.size).toBe(0);
});

test("a license issue of an entry is placed on the items of that kind that use it", async () => {
  const sfx: LicenseIssue = {
    target: { type: "entry", kind: "sfx", id: "door-creak-wood-01" },
    message: "sfx/door-creak-wood-01 is not verified",
    severity: "warning",
  };
  const bgm: LicenseIssue = {
    target: { type: "entry", kind: "bgm", id: "ambient-hum-low" },
    message: "bgm/ambient-hum-low is not verified",
    severity: "warning",
  };
  const provider: LicenseIssue = {
    target: { type: "provider", id: "mock" },
    message: "Provider mock has unknown terms",
    severity: "warning",
  };
  const placed = placeIssues(await sample(), [], [sfx, bgm, provider]);
  expect(placed.byItem.get("0/2")).toEqual([{ message: sfx.message, severity: "warning" }]);
  expect(placed.byItem.get("1/bgm")).toEqual([{ message: bgm.message, severity: "warning" }]);
  expect(placed.byItem.size).toBe(2);
  expect(placed.general).toEqual([{ message: provider.message, severity: "warning" }]);
});

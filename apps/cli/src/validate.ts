import { formatPath, type Issue, loadScenario, type Scenario } from "@vd-creator/scenario";

/** Formats an issue as `path: message`, marking warnings. */
export function formatIssue(issue: Issue): string {
  const suffix = issue.severity === "warning" ? " (warning)" : "";
  return `${formatPath(issue.path)}: ${issue.message}${suffix}`;
}

/** Loads and validates `<dir>/scenario.yaml`. Throws if the file cannot be read. */
export async function validateProject(
  dir: string,
): Promise<{ scenario?: Scenario; issues: Issue[]; ok: boolean }> {
  const { scenario, issues } = await loadScenario(dir);
  return { scenario, issues, ok: !issues.some((i) => i.severity === "error") };
}

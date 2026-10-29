import type { core } from "zod";
import { ITEM_KINDS, type Scenario, ScenarioSchema } from "./schema.js";

export type IssuePath = (string | number)[];

export type Issue = {
  path: IssuePath;
  message: string;
  severity: "error" | "warning";
};

export type ValidationResult = { scenario?: Scenario; issues: Issue[] };

/**
 * Validates plain data, such as the result of parsing scenario.yaml, against schema
 * version 1, and checks IDs and references. `scenario` is set only when there are no
 * errors. Warnings do not block it.
 */
export function validateScenarioData(data: unknown): ValidationResult {
  const result = ScenarioSchema.safeParse(data);
  const issues = result.success ? [] : result.error.issues.flatMap((i) => toIssues(i, [], data));
  issues.push(...checkIds(data), ...checkReferences(data));
  const hasError = issues.some((i) => i.severity === "error");
  return { scenario: result.success && !hasError ? result.data : undefined, issues };
}

/** Formats an issue path as `scenes.0.items.2.id`. */
export function formatPath(path: IssuePath): string {
  return path.length === 0 ? "(root)" : path.join(".");
}

function toIssues(issue: core.$ZodIssue, base: IssuePath, root: unknown): Issue[] {
  const path = [...base, ...issue.path.map((p) => (typeof p === "number" ? p : String(p)))];
  switch (issue.code) {
    case "unrecognized_keys":
      return issue.keys.map((key) => error([...path, key], `Unknown key "${key}"`));
    case "invalid_type": {
      const last = path.at(-1);
      if (last !== undefined && !hasKey(valueAt(root, path.slice(0, -1)), last)) {
        return [error(path, `Missing required field "${last}"`)];
      }
      return [error(path, issue.message)];
    }
    case "invalid_union":
      return unionIssues(issue, path, root);
    default:
      return [error(path, issue.message)];
  }
}

// A union error lists the errors of every branch. Report only the branch the author
// meant, chosen by the key that identifies it, so that messages stay readable.
function unionIssues(issue: core.$ZodIssueInvalidUnion, path: IssuePath, root: unknown): Issue[] {
  const value = valueAt(root, path);
  const last = path.at(-1);
  const parent = path.at(-2);
  let branch: number;
  if (parent === "items" && typeof last === "number") {
    const found = presentKeys(value, ITEM_KINDS);
    if (found.length !== 1) {
      return [
        error(
          path,
          found.length === 0
            ? "Item must have exactly one of line, sfx, pause, or image"
            : `Item must have exactly one of line, sfx, pause, or image, but has ${found.join(", ")}`,
        ),
      ];
    }
    branch = ITEM_KINDS.indexOf(found[0] as (typeof ITEM_KINDS)[number]);
  } else if (last === "bgm") {
    const found = presentKeys(value, ["prompt", "library"]);
    if (found.length !== 1) {
      return [error(path, "BGM must have exactly one of prompt or library")];
    }
    branch = found[0] === "prompt" ? 0 : 1;
  } else if (last === "sfx") {
    if (typeof value === "string") branch = 0;
    else if (isRecord(value)) branch = 1;
    else return [error(path, "SFX must be a prompt string or { library: <entry-id> }")];
  } else {
    // Fall back to the branch with the fewest errors.
    branch = 0;
    issue.errors.forEach((errors, i) => {
      if (errors.length < (issue.errors[branch]?.length ?? Infinity)) branch = i;
    });
  }
  const errors = issue.errors[branch];
  if (!errors || errors.length === 0) return [error(path, issue.message)];
  return errors.flatMap((e) => toIssues(e, path, root));
}

function checkIds(data: unknown): Issue[] {
  const issues: Issue[] = [];
  const checkUnique = (
    seen: Map<string, IssuePath>,
    id: unknown,
    path: IssuePath,
    what: string,
  ) => {
    if (typeof id !== "string") return;
    const first = seen.get(id);
    if (first) {
      issues.push(error(path, `Duplicate ${what} id "${id}", first used at ${formatPath(first)}`));
    } else {
      seen.set(id, path);
    }
  };

  const speakerIds = new Map<string, IssuePath>();
  for (const [i, speaker] of records(field(data, "speakers"))) {
    checkUnique(speakerIds, field(speaker, "id"), ["speakers", i, "id"], "speaker");
  }
  const imageIds = new Map<string, IssuePath>();
  for (const [i, image] of records(field(data, "images"))) {
    checkUnique(imageIds, field(image, "id"), ["images", i, "id"], "image");
  }
  // Scenes and items share one namespace: the UI, the cache, and agents refer to them by ID.
  const itemIds = new Map<string, IssuePath>();
  for (const [i, scene] of records(field(data, "scenes"))) {
    checkUnique(itemIds, field(scene, "id"), ["scenes", i, "id"], "scene or item");
    for (const [j, item] of records(field(scene, "items"))) {
      checkUnique(itemIds, field(item, "id"), ["scenes", i, "items", j, "id"], "scene or item");
    }
  }
  return issues;
}

function checkReferences(data: unknown): Issue[] {
  const issues: Issue[] = [];
  const idsOf = (list: unknown) =>
    new Set(
      records(list)
        .map(([, entry]) => field(entry, "id"))
        .filter((id) => id !== undefined),
    );
  const speakers = idsOf(field(data, "speakers"));
  const images = idsOf(field(data, "images"));

  for (const [i, scene] of records(field(data, "scenes"))) {
    for (const [j, item] of records(field(scene, "items"))) {
      const path = ["scenes", i, "items", j];
      const speaker = field(item, "speaker");
      if (hasKey(item, "line") && typeof speaker === "string" && !speakers.has(speaker)) {
        issues.push(error([...path, "speaker"], `Unknown speaker "${speaker}"`));
      }
      const image = field(item, "image");
      if (typeof image === "string" && !images.has(image)) {
        issues.push(error([...path, "image"], `Unknown image "${image}"`));
      }
    }
  }
  return issues;
}

function error(path: IssuePath, message: string): Issue {
  return { path, message, severity: "error" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKey(value: unknown, key: string | number): boolean {
  if (Array.isArray(value)) return typeof key === "number" && key < value.length;
  return isRecord(value) && Object.hasOwn(value, key);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function records(value: unknown): [number, Record<string, unknown>][] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, i) => (isRecord(entry) ? [[i, entry]] : []));
}

function presentKeys(value: unknown, keys: readonly string[]): string[] {
  return keys.filter((key) => hasKey(value, key));
}

function valueAt(root: unknown, path: IssuePath): unknown {
  let value = root;
  for (const key of path) {
    if (Array.isArray(value) && typeof key === "number") value = value[key];
    else if (isRecord(value)) value = value[key];
    else return undefined;
  }
  return value;
}

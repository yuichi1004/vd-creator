// Places validation and license issues next to the items they concern.

import type { Issue, LicenseIssue, Scenario, TimelineItem } from "./types.js";

/** Key of an item by position, as `<scene index>/<item index>`, or `<scene index>/bgm`. */
export type ItemKey = string;

export type PlacedIssues = {
  byItem: Map<ItemKey, { message: string; severity: "error" | "warning" }[]>;
  /** Issues that concern no single item, such as a speaker or the provider. */
  general: { message: string; severity: "error" | "warning" }[];
};

/**
 * Places scenario issues by their path (`scenes.<i>.items.<j>...` or `scenes.<i>.bgm...`)
 * and license issues on every SFX or BGM that uses the library entry.
 */
export function placeIssues(
  scenario: Scenario | undefined,
  issues: readonly Issue[],
  licenseIssues: readonly LicenseIssue[],
): PlacedIssues {
  const placed: PlacedIssues = { byItem: new Map(), general: [] };
  const add = (
    key: ItemKey | undefined,
    issue: { message: string; severity: Issue["severity"] },
  ) => {
    const entry = { message: issue.message, severity: issue.severity };
    if (key === undefined) {
      placed.general.push(entry);
      return;
    }
    const list = placed.byItem.get(key) ?? [];
    list.push(entry);
    placed.byItem.set(key, list);
  };

  for (const issue of issues) {
    const [root, scene, field, item] = issue.path;
    if (root === "scenes" && typeof scene === "number" && field === "bgm") {
      add(`${scene}/bgm`, issue);
    } else if (root === "scenes" && typeof scene === "number" && field === "items") {
      add(typeof item === "number" ? `${scene}/${item}` : undefined, issue);
    } else {
      add(undefined, issue);
    }
  }

  for (const issue of licenseIssues) {
    // An issue without a target, such as an unreadable credits.json, concerns the project.
    const target = issue.target;
    const keys = target?.type === "entry" && scenario ? libraryUsers(scenario, target) : [];
    if (keys.length === 0) add(undefined, issue);
    for (const key of keys) add(key, issue);
  }
  return placed;
}

/** The items that use a library entry, by key. */
function libraryUsers(scenario: Scenario, entry: { kind: "sfx" | "bgm"; id: string }): ItemKey[] {
  const keys: ItemKey[] = [];
  scenario.scenes.forEach((scene, sceneIndex) => {
    const bgm = scene.bgm;
    if (entry.kind === "bgm" && bgm && "library" in bgm && bgm.library === entry.id) {
      keys.push(`${sceneIndex}/bgm`);
    }
    scene.items.forEach((item, itemIndex) => {
      if (entry.kind !== "sfx") return;
      if ("sfx" in item && typeof item.sfx === "object" && item.sfx.library === entry.id) {
        keys.push(`${sceneIndex}/${itemIndex}`);
      }
    });
  });
  return keys;
}

export type ItemStatus = "ready" | "missing" | "unresolved" | "invalid" | "generating";

/** Status of an item's audio, from the timeline and the items being generated. */
export function itemStatus(
  entry: Pick<TimelineItem, "missing" | "unresolved" | "invalid"> | undefined,
  generating: boolean,
): ItemStatus {
  if (generating) return "generating";
  if (!entry?.missing) return "ready";
  if (entry.invalid) return "invalid";
  if (entry.unresolved) return "unresolved";
  return "missing";
}

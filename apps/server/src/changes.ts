// Which targets changed since the user last reviewed. See "Marks in the UI" in
// docs/plans/0015-change-log-and-draft-audio.md.

import type { ChangeEntry, ChangeTarget } from "@vd-creator/core";
import type { ChangedTarget } from "./api.js";

/**
 * The targets with `file` or `ui` entries after the last `review` entry, and the targets of
 * earlier entries that an `agent` entry after it explains. Keyed by kind and ID, since a speaker
 * and an item may share an ID. `count` is the number of entries. `ui` entries of `session` are
 * left out, so the page does not mark its own changes.
 */
export function changedSinceReview(
  entries: readonly ChangeEntry[],
  session?: string,
): ChangedTarget[] {
  const reviewId = entries.findLast((e) => e.source === "review")?.id ?? 0;
  const found = new Map<string, ChangedTarget>();
  const mark = (target: ChangeTarget) => {
    const key = `${target.kind}\0${target.id}`;
    const known = found.get(key);
    if (known) known.count++;
    else found.set(key, { kind: target.kind, id: target.id, count: 1 });
  };
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const entry of entries) {
    if (entry.id <= reviewId) continue;
    if (entry.source === "file" || (entry.source === "ui" && entry.session !== session)) {
      mark(entry.target);
    } else if (entry.source === "agent") {
      // A reason recorded after the review shows the changes it explains, however old.
      for (const ref of entry.refs) {
        const explained = byId.get(ref);
        if (explained && explained.id <= reviewId && "target" in explained) mark(explained.target);
      }
    }
  }
  return [...found.values()];
}

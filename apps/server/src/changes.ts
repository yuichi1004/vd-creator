// Which targets changed since the user last reviewed. See "Marks in the UI" in
// docs/plans/0015-change-log-and-draft-audio.md.

import type { ChangeEntry, ChangeTarget } from "@vd-creator/core";
import type { ChangedTarget, ChangeEntryView } from "./api.js";

/**
 * An entry as a client sees it. The stored session ID is never sent, since another client could
 * copy it into `X-VD-Session` to hide its changes from a page. `own: true` marks a `ui` entry
 * made by the requester's own session.
 */
export function entryView(entry: ChangeEntry, session?: string): ChangeEntryView {
  if (entry.source !== "ui") return entry;
  const { session: stored, ...rest } = entry;
  return session !== undefined && stored === session ? { ...rest, own: true } : rest;
}

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
    const own = entry.source === "ui" && session !== undefined && entry.session === session;
    if (entry.source === "file" || (entry.source === "ui" && !own)) {
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

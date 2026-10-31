import { useState } from "react";
import { type ChangeGroup, describeChange, type TargetMark } from "../changes.js";

/** The ID of the Changes list, for `aria-controls` of the header button. */
export const CHANGES_PANEL_ID = "changes-panel";

/** What changed in one target, with the old and new values and the reason. */
export function ChangeDetails({ mark, id }: { mark: TargetMark; id?: string }) {
  return (
    <ul className="change-details" id={id}>
      {mark.details.length === 0 && <li className="muted">Explained by a note of an agent.</li>}
      {mark.details.map((d) => (
        <li key={d.entry.id}>
          <span className="muted">{d.origin}:</span> {describeChange(d.entry)}
          {d.reason && <div className="reason">Reason: {d.reason}</div>}
        </li>
      ))}
    </ul>
  );
}

/** The "changed" mark of a target. Tapping it shows the changes. */
export function ChangedMark({ mark, label }: { mark: TargetMark | undefined; label: string }) {
  const [open, setOpen] = useState(false);
  if (!mark) return null;
  const detailsId = `changes-${mark.kind}-${mark.id}`;
  return (
    <span className="changed-wrap">
      <button
        type="button"
        className="changed-mark"
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        aria-label={`changed: ${label}`}
        onClick={() => setOpen(!open)}
      >
        changed
      </button>
      {open && <ChangeDetails mark={mark} id={detailsId} />}
    </span>
  );
}

/** The "Changes" list of the header, with "Mark all reviewed". */
export function ChangesPanel(props: {
  groups: ChangeGroup[];
  busy: boolean;
  onMarkReviewed: () => void;
}) {
  const { groups } = props;
  return (
    <section className="changes-panel" id={CHANGES_PANEL_ID} aria-label="Changes">
      <div className="changes-head">
        <h2>Changes</h2>
        <button type="button" disabled={props.busy} onClick={props.onMarkReviewed}>
          Mark all reviewed
        </button>
      </div>
      {groups.length === 0 && <p className="muted">Nothing to review.</p>}
      {groups.map((group) => (
        <div key={group.key} className="changes-group">
          <h3>{group.title}</h3>
          <ul>
            {group.targets.map((mark) => (
              <li key={`${mark.kind}:${mark.id}`}>
                <strong>
                  {mark.kind} <code>{mark.id}</code>
                </strong>
                <ChangeDetails mark={mark} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

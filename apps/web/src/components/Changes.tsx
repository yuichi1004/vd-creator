import { useState } from "react";
import { type ChangeGroup, describeChange, type TargetMark } from "../changes.js";

/** What changed in one target, with the old and new values and the reason. */
export function ChangeDetails({ mark }: { mark: TargetMark }) {
  return (
    <ul className="change-details">
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
  return (
    <span className="changed-wrap">
      <button
        type="button"
        className="changed-mark"
        aria-expanded={open}
        aria-label={`Changes of ${label}`}
        onClick={() => setOpen(!open)}
      >
        changed
      </button>
      {open && <ChangeDetails mark={mark} />}
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
    <section className="changes-panel" aria-label="Changes">
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

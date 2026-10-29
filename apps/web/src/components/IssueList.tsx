type Props = { issues: readonly { message: string; severity: "error" | "warning" }[] };

/** Validation and license issues, shown next to what they concern. */
export function IssueList({ issues }: Props) {
  if (issues.length === 0) return null;
  return (
    <ul className="issues">
      {issues.map((issue, index) => (
        // Issues have no ID, and the list is replaced as a whole on reload.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <li key={index} className={issue.severity}>
          {issue.severity === "error" ? "Error: " : "Warning: "}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

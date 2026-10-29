import type { LibraryEntryInfo, LibraryResponse } from "@vd-creator/server";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../client.js";
import { formatTime } from "../playback.js";
import type { LibraryKind } from "../types.js";

/** The SFX item or scene BGM that "use" writes the entry into. `id` is the scene ID for BGM. */
export type LibraryTarget = { kind: LibraryKind; id: string; label: string };

type Props = {
  client: ApiClient;
  target: LibraryTarget | undefined;
  onUse: (entryId: string) => void;
  /** Closes the full-screen sheet on a phone. Absent in the PC side panel. */
  onClose?: () => void;
  onError: (error: unknown) => void;
};

/** Search, preview, use, and verify library sounds. See "Library in the UI" in plan 0005. */
export function LibraryPanel({ client, target, onUse, onClose, onError }: Props) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<LibraryKind | "">(target?.kind ?? "");
  const [result, setResult] = useState<LibraryResponse>();
  const [verifying, setVerifying] = useState<string>();
  const [previewing, setPreviewing] = useState<string>();
  const audio = useRef<HTMLAudioElement>(undefined);

  useEffect(() => {
    if (target) setKind(target.kind);
  }, [target]);

  const search = useCallback(async () => {
    try {
      setResult(await client.getLibrary({ q: q.trim() || undefined, kind: kind || undefined }));
    } catch (error) {
      onError(error);
    }
  }, [client, q, kind, onError]);

  useEffect(() => {
    const timer = setTimeout(() => void search(), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => () => audio.current?.pause(), []);

  const preview = (entry: LibraryEntryInfo) => {
    const key = `${entry.kind}/${entry.id}`;
    audio.current?.pause();
    if (previewing === key) {
      setPreviewing(undefined);
      return;
    }
    const element = new Audio(client.libraryFileUrl(entry.kind, entry.id));
    element.onended = () => setPreviewing(undefined);
    audio.current = element;
    setPreviewing(key);
    element.play().catch(() => setPreviewing(undefined));
  };

  const replaceEntry = (entry: LibraryEntryInfo) => {
    setResult(
      (current) =>
        current && {
          ...current,
          entries: current.entries.map((e) =>
            e.kind === entry.kind && e.id === entry.id ? entry : e,
          ),
        },
    );
  };

  return (
    <section className="library" aria-label="Library">
      <div className="library-header">
        <h2>Library{result ? `: ${result.name}` : ""}</h2>
        {onClose && (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      <p className="muted">
        {target ? `Choosing for ${target.label}` : "Pick an SFX or BGM item to use a sound."}
      </p>
      <div className="library-search">
        <input
          type="search"
          aria-label="Search the library"
          placeholder="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as LibraryKind | "")}
        >
          <option value="">All</option>
          <option value="sfx">SFX</option>
          <option value="bgm">BGM</option>
        </select>
      </div>
      <ul className="library-entries">
        {result?.entries.map((entry) => {
          const key = `${entry.kind}/${entry.id}`;
          return (
            <li key={key} className="library-entry">
              <div className="entry-title">
                <strong>{entry.title}</strong> <code>{entry.id}</code>{" "}
                <span className="muted">
                  {entry.kind.toUpperCase()}
                  {entry.durationSec ? ` · ${formatTime(entry.durationSec)}` : ""}
                  {entry.loopable ? " · loops" : ""}
                </span>
              </div>
              <div className="entry-license">
                {entry.licenseTerms?.name ?? entry.license.id}
                {entry.license.attribution ? ` · ${entry.license.attribution}` : ""}{" "}
                <span className={`status ${entry.license.verified ? "ready" : "missing"}`}>
                  {entry.license.verified ? "verified" : "unverified"}
                </span>
              </div>
              {entry.tags.length > 0 && <div className="muted">{entry.tags.join(", ")}</div>}
              <div className="entry-actions">
                <button type="button" onClick={() => preview(entry)}>
                  {previewing === key ? "Stop" : "Preview"}
                </button>
                {target && target.kind === entry.kind && (
                  <button type="button" className="primary" onClick={() => onUse(entry.id)}>
                    Use for this {entry.kind.toUpperCase()}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setVerifying(verifying === key ? undefined : key)}
                >
                  {verifying === key ? "Hide license" : "Verify"}
                </button>
              </div>
              {verifying === key && (
                <VerifyPanel
                  client={client}
                  entry={entry}
                  onVerified={replaceEntry}
                  onError={onError}
                />
              )}
            </li>
          );
        })}
        {result && result.entries.length === 0 && <li className="muted">No entries found.</li>}
      </ul>
    </section>
  );
}

/** Only http and https links are shown as links. */
function safeLink(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

function VerifyPanel(props: {
  client: ApiClient;
  entry: LibraryEntryInfo;
  onVerified: (entry: LibraryEntryInfo) => void;
  onError: (error: unknown) => void;
}) {
  const { entry } = props;
  const terms = entry.licenseTerms;
  const needsApproval =
    terms?.commercialUse === "conditional" || terms?.commercialUse === "unknown";
  const [checked, setChecked] = useState(false);
  const [approveCommercial, setApproveCommercial] = useState(false);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const sourceUrl = "url" in entry.source ? safeLink(entry.source.url) : undefined;
  const termsUrl = safeLink(terms?.url);

  const verify = async () => {
    setBusy(true);
    try {
      const response = await props.client.verifyLibraryEntry(entry.kind, entry.id, {
        confirm: true,
        ...(needsApproval && approveCommercial ? { approveCommercial: true } : {}),
      });
      props.onVerified(response.entry);
      setMessage(response.verified ? "Marked as verified." : response.message);
    } catch (error) {
      props.onError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="verify">
      <dl>
        <dt>License</dt>
        <dd>
          {termsUrl ? (
            <a href={termsUrl} target="_blank" rel="noreferrer noopener">
              {terms?.name ?? entry.license.id}
            </a>
          ) : (
            (terms?.name ?? entry.license.id)
          )}
        </dd>
        {terms && (
          <>
            <dt>Terms</dt>
            <dd>
              attribution {terms.attribution}, commercial use {terms.commercialUse}, modification{" "}
              {terms.modification}, share-alike {String(terms.shareAlike)}
              {terms.conditions ? `. ${terms.conditions}` : ""}
            </dd>
          </>
        )}
        <dt>Attribution</dt>
        <dd>{entry.license.attribution ?? "none"}</dd>
        <dt>Source</dt>
        <dd>
          {entry.source.type}
          {"site" in entry.source && entry.source.site ? ` · ${entry.source.site}` : ""}
          {"author" in entry.source && entry.source.author ? ` · ${entry.source.author}` : ""}
          {sourceUrl && (
            <>
              {" · "}
              <a href={sourceUrl} target="_blank" rel="noreferrer noopener">
                evidence link
              </a>
            </>
          )}
        </dd>
        <dt>Evidence copy</dt>
        <dd>{entry.license.evidence ?? "none"}</dd>
        <dt>Verified</dt>
        <dd>
          {entry.license.verified
            ? `yes${entry.license.verifiedAt ? `, ${entry.license.verifiedAt}` : ""}`
            : "no"}
          {entry.license.approvedFor ? `, approved for ${entry.license.approvedFor} use` : ""}
        </dd>
      </dl>
      {!entry.license.verified && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            I checked the source and the license record above.
          </label>
          {needsApproval && (
            <label className="check">
              <input
                type="checkbox"
                checked={approveCommercial}
                onChange={(e) => setApproveCommercial(e.target.checked)}
              />
              Also approve these terms for commercial use.
            </label>
          )}
          <button
            type="button"
            className="primary"
            disabled={!checked || busy}
            onClick={() => void verify()}
          >
            Mark as verified
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

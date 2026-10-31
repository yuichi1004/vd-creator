import type { ServerInfoResponse } from "@vd-creator/server";
import { useEffect, useState } from "react";
import { ApiRequestError, UNKNOWN_ERROR_MESSAGE } from "../client.js";
import {
  formatSpeed,
  MAX_SPEED,
  MIN_SPEED,
  type Settings,
  SPEED_PRESETS,
  SPEED_STEP,
} from "../settings.js";

type Props = {
  settings: Settings;
  onChange: (settings: Settings) => void;
  /** Loads the facts about the server. */
  loadServer: () => Promise<ServerInfoResponse>;
  onBack: () => void;
};

/** The settings screen: full screen on a phone, a page in place of the review screen on a PC. */
export function SettingsScreen({ settings, onChange, loadServer, onBack }: Props) {
  const [server, setServer] = useState<ServerInfoResponse>();
  const [serverError, setServerError] = useState<string>();
  useEffect(() => {
    let current = true;
    loadServer().then(
      (info) => current && setServer(info),
      (error) =>
        current &&
        setServerError(error instanceof ApiRequestError ? error.message : UNKNOWN_ERROR_MESSAGE),
    );
    return () => {
      current = false;
    };
  }, [loadServer]);

  const keepPitchAvailable = server?.preview.keepPitch !== false;

  return (
    <div className="settings-screen">
      <header className="settings-header">
        <button type="button" onClick={onBack}>
          <span aria-hidden="true">←</span> Back
        </button>
        <h1>Settings</h1>
      </header>

      <section className="settings-section" aria-labelledby="settings-playback">
        <h2 id="settings-playback">Playback</h2>
        <div className="setting">
          <label htmlFor="speed-slider">Speed</label>
          <output className="speed-value" htmlFor="speed-slider">
            {formatSpeed(settings.speed)}
          </output>
          <input
            id="speed-slider"
            className="speed-slider"
            type="range"
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={SPEED_STEP}
            value={settings.speed}
            onChange={(e) => onChange({ ...settings, speed: Number(e.target.value) })}
          />
          <div className="speed-presets">
            {SPEED_PRESETS.map((speed) => (
              <button
                key={speed}
                type="button"
                aria-pressed={settings.speed === speed}
                className={settings.speed === speed ? "primary" : undefined}
                onClick={() => onChange({ ...settings, speed })}
              >
                {formatSpeed(speed)}
              </button>
            ))}
          </div>
        </div>
        <div className="setting">
          <label className="check" htmlFor="keep-pitch">
            <input
              id="keep-pitch"
              type="checkbox"
              checked={settings.keepPitch}
              disabled={!keepPitchAvailable}
              aria-describedby="keep-pitch-note"
              onChange={(e) => onChange({ ...settings, keepPitch: e.target.checked })}
            />
            Keep pitch
          </label>
          <p id="keep-pitch-note" className="muted">
            {keepPitchAvailable
              ? "When off, speed works like a tape: faster is higher."
              : "Unavailable: the server needs ffmpeg to keep the pitch. Playback speed changes the pitch."}
          </p>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-server">
        <h2 id="settings-server">About this server</h2>
        {serverError && (
          <p role="alert" className="notice error">
            {serverError}
          </p>
        )}
        {!server && !serverError && <p role="status">Loading…</p>}
        {server && (
          <dl className="server-facts">
            <dt>Provider</dt>
            <dd>
              {server.provider.id} ({server.provider.paid ? "paid" : "free"})
            </dd>
            {server.library && (
              <>
                <dt>Library</dt>
                <dd>{server.library.name}</dd>
              </>
            )}
            <dt>vd version</dt>
            <dd>{server.version}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}

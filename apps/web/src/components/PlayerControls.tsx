import type { UnlockState } from "../audio.js";
import { formatTime } from "../playback.js";
import { formatSpeed } from "../settings.js";

type Props = {
  playing: boolean;
  unlockState: UnlockState;
  position: number;
  duration: number;
  disabled: boolean;
  /** True while a play waits for the first sounds to be decoded. */
  loading: boolean;
  /** Playback speed, shown on the quick speed button. */
  speed: number;
  onSpeed: () => void;
  onPlay: () => void;
  onStop: () => void;
  onRestart: () => void;
};

/** Play controls: in the header on a PC, in the bottom bar on a phone. */
export function PlayerControls(props: Props) {
  const { playing, unlockState, position, duration, disabled, loading, speed } = props;
  return (
    <div className="player-controls">
      <button
        type="button"
        className="primary"
        disabled={disabled || unlockState === "unsupported"}
        onClick={playing || loading ? props.onStop : props.onPlay}
      >
        {playing || loading ? "Stop" : "Play"}
      </button>
      <button type="button" disabled={disabled} onClick={props.onRestart}>
        From start
      </button>
      <button
        type="button"
        className="speed-button"
        aria-label={`Playback speed ${formatSpeed(speed)}. Tap to change.`}
        onClick={props.onSpeed}
      >
        {formatSpeed(speed)}
      </button>
      <span className="time">
        {formatTime(position)} / {formatTime(duration)}
      </span>
      {loading && (
        <span className="hint" role="status">
          Loading…
        </span>
      )}
      {unlockState === "locked" && <span className="hint">Tap play to enable sound</span>}
      {unlockState === "unsupported" && <span className="hint">No Web Audio in this browser</span>}
    </div>
  );
}

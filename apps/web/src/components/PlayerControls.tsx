import type { UnlockState } from "../audio.js";
import { formatTime } from "../playback.js";

type Props = {
  playing: boolean;
  unlockState: UnlockState;
  position: number;
  duration: number;
  disabled: boolean;
  onPlay: () => void;
  onStop: () => void;
  onRestart: () => void;
};

/** Play controls: in the header on a PC, in the bottom bar on a phone. */
export function PlayerControls(props: Props) {
  const { playing, unlockState, position, duration, disabled } = props;
  return (
    <div className="player-controls">
      <button
        type="button"
        className="primary"
        disabled={disabled || unlockState === "unsupported"}
        onClick={playing ? props.onStop : props.onPlay}
      >
        {playing ? "Stop" : "Play"}
      </button>
      <button type="button" disabled={disabled} onClick={props.onRestart}>
        From start
      </button>
      <span className="time">
        {formatTime(position)} / {formatTime(duration)}
      </span>
      {unlockState === "locked" && <span className="hint">Tap play to enable sound</span>}
      {unlockState === "unsupported" && <span className="hint">No Web Audio in this browser</span>}
    </div>
  );
}

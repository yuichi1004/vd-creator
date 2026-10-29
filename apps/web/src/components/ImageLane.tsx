import type { ApiClient } from "../client.js";
import { formatTime } from "../playback.js";
import type { ImageSpan, Timeline } from "../types.js";

type Props = {
  timeline: Timeline;
  client: ApiClient;
  current: ImageSpan | undefined;
  onSeek: (sec: number) => void;
};

/** The still images along the timeline. Tapping one moves the position to it. */
export function ImageLane({ timeline, client, current, onSeek }: Props) {
  if (timeline.images.length === 0) return null;
  const total = timeline.durationSec || 1;
  return (
    <section className="image-lane" aria-label="Images">
      <div className="image-lane-bar">
        {timeline.images.map((span) => (
          <button
            type="button"
            key={`${span.imageId}@${span.startSec}`}
            className={`image-span${span === current ? " current" : ""}`}
            style={{ flexGrow: Math.max(span.endSec - span.startSec, total / 50) }}
            onClick={() => onSeek(span.startSec)}
            title={`${span.imageId} at ${formatTime(span.startSec)}`}
          >
            {span.file ? (
              <img src={client.assetUrl(span.file)} alt={span.imageId} loading="lazy" />
            ) : (
              <span>{span.imageId}</span>
            )}
            <span className="image-time">{formatTime(span.startSec)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

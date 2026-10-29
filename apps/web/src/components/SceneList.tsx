import type { ItemPatchRequest, ScenePatchRequest } from "@vd-creator/server";
import { type ReactNode, useEffect, useState } from "react";
import { type ItemKey, type ItemStatus, itemStatus, type PlacedIssues } from "../issues.js";
import { formatTime } from "../playback.js";
import type { Bgm, Item, Scenario, Scene, Speaker, Timeline, TimelineItem } from "../types.js";
import { EditableText, NumberField } from "./fields.js";
import { IssueList } from "./IssueList.js";
import type { LibraryTarget } from "./LibraryPanel.js";

type Handlers = {
  onPatchItem: (id: string, patch: ItemPatchRequest) => Promise<boolean>;
  onPatchScene: (id: string, patch: ScenePatchRequest) => Promise<boolean>;
  onRegenerate: (id: string, take: number) => void;
  onGenerate: (id: string) => void;
  onPlayFrom: (id: string) => void;
  onEditLine: (id: string) => void;
  onOpenLibrary: (target: LibraryTarget) => void;
};

type Props = Handlers & {
  scenario: Scenario;
  timeline: Timeline | undefined;
  issues: PlacedIssues["byItem"];
  generating: ReadonlySet<string>;
  currentItemId: string | undefined;
  isPhone: boolean;
  hasLibrary: boolean;
  libraryTarget: LibraryTarget | undefined;
};

/** The scenes with their BGM and items. */
export function SceneList(props: Props) {
  const { scenario, timeline } = props;
  return (
    <div className="scene-list">
      {scenario.scenes.map((scene, sceneIndex) => (
        <SceneBlock
          key={scene.id}
          {...props}
          scene={scene}
          sceneIndex={sceneIndex}
          timelineItems={timeline?.items.filter((i) => i.sceneId === scene.id) ?? []}
          bgmMissing={timeline?.bgm.find((b) => b.sceneId === scene.id)}
        />
      ))}
    </div>
  );
}

type SceneProps = Props & {
  scene: Scene;
  sceneIndex: number;
  timelineItems: TimelineItem[];
  bgmMissing: Timeline["bgm"][number] | undefined;
};

function SceneBlock(props: SceneProps) {
  const { scene, sceneIndex, timelineItems, issues } = props;
  return (
    <section className="scene" aria-label={`Scene ${scene.title ?? scene.id}`}>
      <h2>
        {scene.title ?? scene.id}
        {scene.title && <span className="muted"> {scene.id}</span>}
      </h2>
      {scene.bgm && (
        <BgmRow
          {...props}
          bgm={scene.bgm}
          status={itemStatus(props.bgmMissing, props.generating.has(scene.id))}
          issueKey={`${sceneIndex}/bgm`}
        />
      )}
      <ol className="items">
        {scene.items.map((item, itemIndex) => {
          const key: ItemKey = `${sceneIndex}/${itemIndex}`;
          const entry = timelineItems.find((t) => t.index === itemIndex);
          return (
            <li key={item.id ?? key} className={rowClass(item, props.currentItemId)}>
              <ItemRow {...props} item={item} entry={entry} />
              <IssueList issues={issues.get(key) ?? []} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function rowClass(item: Item, currentItemId: string | undefined): string {
  const kind =
    "line" in item ? "line" : "sfx" in item ? "sfx" : "pause" in item ? "pause" : "image";
  return `item ${kind}${item.id !== undefined && item.id === currentItemId ? " current" : ""}`;
}

function StatusBadge({ status }: { status: ItemStatus }) {
  return <span className={`status ${status}`}>{status}</span>;
}

type ItemRowProps = SceneProps & { item: Item; entry: TimelineItem | undefined };

function ItemRow(props: ItemRowProps) {
  const { item, entry } = props;
  const time = entry ? <span className="time">{formatTime(entry.startSec)}</span> : null;
  if ("line" in item) return <LineRow {...props} item={item} time={time} />;
  if ("sfx" in item) return <SfxRow {...props} item={item} time={time} />;
  if ("pause" in item) {
    return (
      <div className="row">
        {time}
        <span className="muted">Pause {item.pause} s</span>
      </div>
    );
  }
  return (
    <div className="row">
      {time}
      <span className="muted">Image {item.image}</span>
    </div>
  );
}

type RowProps<T> = ItemRowProps & { item: T; time: ReactNode };

function speakerName(speakers: readonly Speaker[], id: string): string {
  return speakers.find((s) => s.id === id)?.name ?? id;
}

function LineRow(props: RowProps<Extract<Item, { line: string }>>) {
  const { item, entry, time, scenario, isPhone, generating } = props;
  const status = itemStatus(entry, generating.has(item.id));
  const take = (
    <TakeControls
      id={item.id}
      take={item.take}
      status={status}
      onPatchItem={props.onPatchItem}
      onRegenerate={props.onRegenerate}
    />
  );
  if (isPhone) {
    return (
      <div className="row">
        <button
          type="button"
          className="line-tap"
          onClick={() => props.onEditLine(item.id)}
          aria-label={`Edit line ${item.id}`}
        >
          <span className="speaker">{speakerName(scenario.speakers, item.speaker)}</span>
          <span className="text">{item.line}</span>
        </button>
        <div className="row-tools">
          {time}
          <PlayFromButton id={item.id} onPlayFrom={props.onPlayFrom} />
          <span className="take">take {item.take}</span>
          <StatusBadge status={status} />
        </div>
      </div>
    );
  }
  return (
    <div className="row">
      <div className="row-main">
        <select
          className="speaker"
          aria-label={`Speaker of ${item.id}`}
          value={item.speaker}
          onChange={(e) => void props.onPatchItem(item.id, { speaker: e.target.value })}
        >
          {scenario.speakers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <EditableText
          label={`Text of ${item.id}`}
          multiline
          value={item.line}
          onSave={(text) => props.onPatchItem(item.id, { text })}
        />
      </div>
      <div className="row-tools">
        {time}
        <PlayFromButton id={item.id} onPlayFrom={props.onPlayFrom} />
        <span className="field gap">
          gap
          <NumberField
            label={`Gap before ${item.id} in seconds`}
            value={item.gapBeforeSec}
            min={-1}
            step={0.1}
            onSave={(gapBeforeSec) => props.onPatchItem(item.id, { gapBeforeSec })}
          />
        </span>
        {take}
      </div>
    </div>
  );
}

function SfxRow(props: RowProps<Extract<Item, { sfx: unknown }>>) {
  const { item, entry, time, generating, hasLibrary, libraryTarget } = props;
  const status = itemStatus(entry, generating.has(item.id));
  const selected = libraryTarget?.kind === "sfx" && libraryTarget.id === item.id;
  return (
    <div className={`row${selected ? " selected" : ""}`}>
      <div className="row-main">
        <span className="kind">SFX</span>
        <SourceField
          id={item.id}
          source={typeof item.sfx === "string" ? { prompt: item.sfx } : item.sfx}
          onSave={(source) => props.onPatchItem(item.id, { source })}
        />
      </div>
      <div className="row-tools">
        {time}
        <PlayFromButton id={item.id} onPlayFrom={props.onPlayFrom} />
        {hasLibrary && (
          <button
            type="button"
            onClick={() => props.onOpenLibrary({ kind: "sfx", id: item.id, label: item.id })}
          >
            Library
          </button>
        )}
        <TakeControls
          id={item.id}
          take={item.take}
          status={status}
          onPatchItem={props.onPatchItem}
          onRegenerate={props.onRegenerate}
        />
      </div>
    </div>
  );
}

function BgmRow(props: SceneProps & { bgm: Bgm; status: ItemStatus; issueKey: ItemKey }) {
  const { scene, bgm, status, hasLibrary, libraryTarget } = props;
  const selected = libraryTarget?.kind === "bgm" && libraryTarget.id === scene.id;
  const [volume, setVolume] = useState(bgm.volume);
  useEffect(() => setVolume(bgm.volume), [bgm.volume]);
  const commitVolume = () => {
    if (volume !== bgm.volume) void props.onPatchScene(scene.id, { volume });
  };
  return (
    <div className={`bgm item${selected ? " selected" : ""}`}>
      <div className="row">
        <div className="row-main">
          <span className="kind">BGM</span>
          <SourceField
            id={`${scene.id} BGM`}
            source={"library" in bgm ? { library: bgm.library } : { prompt: bgm.prompt }}
            onSave={(source) => props.onPatchScene(scene.id, { bgm: source })}
          />
        </div>
        <div className="row-tools">
          <label className="volume">
            volume
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              aria-label={`BGM volume of ${scene.id}`}
              onChange={(e) => setVolume(Number(e.target.value))}
              onPointerUp={commitVolume}
              onKeyUp={commitVolume}
              onBlur={commitVolume}
            />
          </label>
          {hasLibrary && (
            <button
              type="button"
              onClick={() =>
                props.onOpenLibrary({ kind: "bgm", id: scene.id, label: `${scene.id} BGM` })
              }
            >
              Library
            </button>
          )}
          <StatusBadge status={status} />
          {status === "missing" && (
            <button type="button" onClick={() => props.onGenerate(scene.id)}>
              Generate
            </button>
          )}
        </div>
      </div>
      <IssueList issues={props.issues.get(props.issueKey) ?? []} />
    </div>
  );
}

type Source = { prompt: string } | { library: string };

/** The source of an SFX or BGM: an editable prompt, or a library entry. */
function SourceField(props: {
  id: string;
  source: Source;
  onSave: (s: Source) => Promise<boolean>;
}) {
  const { id, source } = props;
  if ("library" in source) {
    return (
      <span className="source">
        library: <code>{source.library}</code>
      </span>
    );
  }
  return (
    <EditableText
      label={`Prompt of ${id}`}
      value={source.prompt}
      onSave={(prompt) => props.onSave({ prompt })}
    />
  );
}

function PlayFromButton({ id, onPlayFrom }: { id: string; onPlayFrom: (id: string) => void }) {
  return (
    <button
      type="button"
      className="icon"
      aria-label={`Play from ${id}`}
      title="Play from here"
      onClick={() => onPlayFrom(id)}
    >
      ▶
    </button>
  );
}

function TakeControls(props: {
  id: string;
  take: number;
  status: ItemStatus;
  onPatchItem: Handlers["onPatchItem"];
  onRegenerate: Handlers["onRegenerate"];
}) {
  const { id, take, status } = props;
  return (
    <>
      <span className="field take">
        take
        <NumberField
          label={`Take of ${id}`}
          value={take}
          min={0}
          step={1}
          integer
          onSave={(next) => props.onPatchItem(id, { take: next })}
        />
      </span>
      <button
        type="button"
        disabled={status === "generating"}
        onClick={() => props.onRegenerate(id, take)}
      >
        Regenerate
      </button>
      <StatusBadge status={status} />
    </>
  );
}

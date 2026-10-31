import type { TakeInfo } from "@vd-creator/server";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ApiClient } from "../client.js";
import { SequencePlayer } from "../contextAudio.js";
import {
  assetFileOf,
  type EditFields,
  formatSettings,
  mergeSettings,
  proposalDiff,
  type RetakeController,
  type RetakeState,
} from "../retake.js";
import type { LineItem } from "../types.js";

/** A line shown for context, with the asset file of its current take. */
export type ContextLine = { id: string; speaker: string; text: string; file?: string };

export type RetakeActions = {
  ask: (instruction: string) => void;
  cancel: () => void;
  discard: () => void;
  tryProposal: () => void;
  tryEdit: (fields: EditFields) => void;
  keep: () => void;
  dropTrial: () => void;
  takeBack: (take: TakeInfo) => void;
  /** Today's plain regenerate: raises the take in the scenario. */
  regenerate: () => void;
  /** Plays these URLs in a row. Called inside the tap. */
  play: (urls: string[], id: string) => void;
  stop: () => void;
  close: () => void;
  dismiss: () => void;
};

export type RetakeViewProps = {
  line: LineItem;
  speakerName: string;
  before: ContextLine | undefined;
  after: ContextLine | undefined;
  /** The asset file of the line's current take. */
  currentFile: string | undefined;
  state: RetakeState;
  /** The agent that answers instructions. Absent: the box is hidden. */
  agent: { command: string } | undefined;
  /** URL of an asset file. */
  assetUrl: (file: string) => string;
  /** The ID of the sound being played, to show Stop on its button. */
  playingId: string | undefined;
  /** True while the plain regenerate runs. */
  generating: boolean;
  actions: RetakeActions;
};

const MAX_INSTRUCTION = 1000;

/** The retake screen of one line. It shows `state` and calls `actions`; it holds only form text. */
export function RetakeView(props: RetakeViewProps) {
  const { line, state, actions, agent, assetUrl } = props;
  const busy = state.working !== undefined;
  const [instruction, setInstruction] = useState("");
  const [fields, setFields] = useState<EditFields>({
    text: line.line,
    direction: line.direction ?? "",
    settings: formatSettings(line.voice?.settings),
  });
  const { proposal, trial } = state;

  const playButton = (label: string, urls: (string | undefined)[], id: string) => {
    const list = urls.filter((u): u is string => u !== undefined);
    const active = props.playingId === id;
    return (
      <button
        type="button"
        disabled={list.length === 0}
        onClick={() => (active ? actions.stop() : actions.play(list, id))}
      >
        {active ? "Stop" : label}
      </button>
    );
  };

  const urlOf = (file: string | undefined) => (file === undefined ? undefined : assetUrl(file));
  const beforeUrl = urlOf(props.before?.file);
  const afterUrl = urlOf(props.after?.file);
  const currentUrl = urlOf(props.currentFile);
  const trialUrl = trial ? assetUrl(assetFileOf(trial.url)) : undefined;

  const editProposal = () => {
    if (!proposal) return;
    setFields({
      text: proposal.text ?? fields.text,
      direction: proposal.direction ?? fields.direction,
      // Proposed settings stay as proposed: they are merged over the line's own.
      settings: formatSettings(mergeSettings(proposal.base.voiceSettings, proposal.settings)),
    });
  };

  return (
    <section className="retake" aria-label={`Retake ${line.id}`}>
      <header className="retake-header">
        <button type="button" onClick={actions.close}>
          <span aria-hidden="true">←</span> Back
        </button>
        <h2>Retake {line.id}</h2>
      </header>

      {state.message && (
        <div
          className={`notice ${state.message.kind}`}
          role={state.message.kind === "error" ? "alert" : "status"}
        >
          <span>{state.message.text}</span>
          <button type="button" className="link" onClick={actions.dismiss}>
            Dismiss
          </button>
        </div>
      )}

      <section className="retake-section" aria-labelledby="retake-context">
        <h3 id="retake-context">In context</h3>
        <ol className="retake-context">
          {props.before && (
            <li className="muted">
              <span className="speaker">{props.before.speaker}</span> {props.before.text}
            </li>
          )}
          <li className="here">
            <span className="speaker">{props.speakerName}</span> {line.line}
          </li>
          {props.after && (
            <li className="muted">
              <span className="speaker">{props.after.speaker}</span> {props.after.text}
            </li>
          )}
        </ol>
        <div className="retake-actions">
          {playButton("Play in context", [beforeUrl, currentUrl, afterUrl], "context")}
          {playButton("Play this take", [currentUrl], "current")}
          <span className="muted">take {line.take}</span>
        </div>
      </section>

      {agent && (
        <section className="retake-section" aria-labelledby="retake-agent">
          <h3 id="retake-agent">Ask the agent</h3>
          <label className="retake-field">
            What should change?
            <textarea
              value={instruction}
              maxLength={MAX_INSTRUCTION}
              rows={3}
              placeholder="More surprised, and a short pause before the last word"
              disabled={state.asking}
              onChange={(e) => setInstruction(e.target.value)}
            />
          </label>
          <p className="muted">
            The agent ({agent.command}) runs on the server and is billed by its provider. It only
            proposes; nothing changes until you keep a take.
          </p>
          <div className="retake-actions">
            {state.asking ? (
              <>
                <span role="status">The agent is working…</span>
                <button type="button" onClick={actions.cancel}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={instruction.trim() === ""}
                onClick={() => actions.ask(instruction)}
              >
                Ask
              </button>
            )}
          </div>
        </section>
      )}

      {proposal && (
        <section className="retake-section" aria-labelledby="retake-proposal">
          <h3 id="retake-proposal">Proposal</h3>
          <p>{proposal.reason}</p>
          <ProposalDiff proposal={proposal} />
          <div className="retake-actions">
            <button type="button" className="primary" disabled={busy} onClick={actions.tryProposal}>
              Try it
            </button>
            <button type="button" disabled={busy} onClick={editProposal}>
              Edit
            </button>
            <button type="button" disabled={busy} onClick={actions.discard}>
              Discard
            </button>
          </div>
        </section>
      )}

      {(state.working === "trial" || trial) && (
        <section className="retake-section" aria-labelledby="retake-trial">
          <h3 id="retake-trial">Trial take</h3>
          {state.working === "trial" && <p role="status">Making a trial take…</p>}
          {trial && (
            <>
              <p className="muted">
                Not kept yet. The line in the scenario has not changed. (trial take {trial.take})
              </p>
              <div className="retake-actions">
                {playButton("Play in context", [beforeUrl, trialUrl, afterUrl], "trial-context")}
                {playButton("Play", [trialUrl], "trial")}
              </div>
              <div className="retake-actions">
                <button type="button" className="primary" disabled={busy} onClick={actions.keep}>
                  {state.working === "keep" ? "Keeping…" : "Keep"}
                </button>
                <button type="button" disabled={busy} onClick={actions.dropTrial}>
                  Not this one
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="retake-section" aria-labelledby="retake-edit">
        <h3 id="retake-edit">Edit</h3>
        <label className="retake-field">
          Text
          <textarea
            rows={3}
            value={fields.text}
            maxLength={500}
            onChange={(e) => setFields({ ...fields, text: e.target.value })}
          />
        </label>
        <label className="retake-field">
          Direction
          <input
            type="text"
            value={fields.direction}
            maxLength={300}
            onChange={(e) => setFields({ ...fields, direction: e.target.value })}
          />
        </label>
        <label className="retake-field">
          Voice settings (JSON, for this line only)
          <textarea
            rows={3}
            spellCheck={false}
            value={fields.settings}
            onChange={(e) => setFields({ ...fields, settings: e.target.value })}
          />
        </label>
        <div className="retake-actions">
          <button type="button" disabled={busy} onClick={() => actions.tryEdit(fields)}>
            Try
          </button>
          <button type="button" disabled={busy || props.generating} onClick={actions.regenerate}>
            {props.generating ? "Generating…" : "Regenerate"}
          </button>
        </div>
      </section>

      <section className="retake-section" aria-labelledby="retake-takes">
        <h3 id="retake-takes">Takes</h3>
        {state.takesError && (
          <p role="alert" className="notice error">
            {state.takesError}
          </p>
        )}
        {!state.takes && !state.takesError && <p role="status">Loading…</p>}
        {state.takes && state.takes.length === 0 && <p className="muted">No earlier takes.</p>}
        {state.takes && state.takes.length > 0 && (
          <ul className="retake-takes">
            {state.takes.map((take) => (
              <TakeRow
                key={take.key}
                take={take}
                busy={busy}
                playingId={props.playingId}
                assetUrl={assetUrl}
                actions={actions}
              />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function ProposalDiff({ proposal }: { proposal: NonNullable<RetakeState["proposal"]> }) {
  const rows = proposalDiff(proposal);
  if (rows.length === 0) return <p className="muted">The proposal changes nothing.</p>;
  return (
    <dl className="retake-diff">
      {rows.map((row) => (
        <div key={row.label} className="diff-row">
          <dt>{row.label}</dt>
          <dd className="old">
            <span className="visually-hidden">Old: </span>
            {row.old}
          </dd>
          <dd className="new">
            <span className="visually-hidden">New: </span>
            {row.next}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TakeRow(props: {
  take: TakeInfo;
  busy: boolean;
  playingId: string | undefined;
  assetUrl: (file: string) => string;
  actions: RetakeActions;
}) {
  const { take, actions } = props;
  const url = take.url === undefined ? undefined : props.assetUrl(assetFileOf(take.url));
  const id = `take:${take.key}`;
  const active = props.playingId === id;
  return (
    <li className={`retake-take${take.current ? " current" : ""}`}>
      <div className="take-text">{take.text}</div>
      {take.direction && <div className="muted">{take.direction}</div>}
      <div className="take-meta muted">
        take {take.take} · {take.provider}
        {take.trial ? " · trial" : ""}
        {take.current ? " · current" : ""}
      </div>
      {take.reason && <div className="muted">{take.reason}</div>}
      <div className="retake-actions">
        {url !== undefined && (
          <button type="button" onClick={() => (active ? actions.stop() : actions.play([url], id))}>
            {active ? "Stop" : "Play"}
          </button>
        )}
        {take.canUse && !take.current && (
          <button type="button" disabled={props.busy} onClick={() => actions.takeBack(take)}>
            Use this take
          </button>
        )}
      </div>
      {!take.canUse && take.why && <div className="take-why muted">{take.why.message}</div>}
    </li>
  );
}

type Props = {
  controller: RetakeController;
  client: ApiClient;
  line: LineItem;
  speakerName: string;
  before: ContextLine | undefined;
  after: ContextLine | undefined;
  currentFile: string | undefined;
  agent: { command: string } | undefined;
  speed: number;
  generating: boolean;
  onRegenerate: () => void;
  onClose: () => void;
};

/** Connects the controller and the audio to the view. */
export function RetakeScreen(props: Props) {
  const { controller, client } = props;
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [, setTick] = useState(0);
  const player = useRef<SequencePlayer>(undefined);
  if (!player.current) player.current = new SequencePlayer(undefined, () => setTick((n) => n + 1));

  useEffect(() => {
    void controller.loadTakes();
  }, [controller]);
  useEffect(() => {
    const current = player.current;
    return () => current?.stop();
  }, []);

  const actions: RetakeActions = {
    ask: (text) => void controller.ask(text),
    cancel: () => void controller.cancel(),
    discard: () => void controller.discard(),
    tryProposal: () => void controller.tryProposal(),
    tryEdit: (fields) => void controller.tryEdit(fields),
    keep: () => void controller.keep(),
    dropTrial: () => controller.dropTrial(),
    takeBack: (take) => void controller.takeBack(take),
    regenerate: props.onRegenerate,
    play: (urls, id) => player.current?.play(urls, props.speed, id),
    stop: () => player.current?.stop(),
    close: props.onClose,
    dismiss: () => controller.dismissMessage(),
  };

  return (
    <RetakeView
      // A new line (after Keep, a restore, or a reload) starts the fields again from it.
      key={JSON.stringify([
        props.line.line,
        props.line.direction,
        props.line.voice,
        props.line.take,
      ])}
      line={props.line}
      speakerName={props.speakerName}
      before={props.before}
      after={props.after}
      currentFile={props.currentFile}
      state={state}
      agent={props.agent}
      assetUrl={(file) => client.assetUrl(file)}
      playingId={player.current.id}
      generating={props.generating}
      actions={actions}
    />
  );
}

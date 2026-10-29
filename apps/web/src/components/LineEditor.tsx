import type { ItemPatchRequest } from "@vd-creator/server";
import { useEffect, useState } from "react";
import type { LineItem, Speaker } from "../types.js";

type Props = {
  item: LineItem;
  speakers: readonly Speaker[];
  generating: boolean;
  onSave: (patch: ItemPatchRequest) => Promise<void>;
  onRegenerate: () => void;
  onCancel: () => void;
};

/** The full-screen line editor of the phone layout. */
export function LineEditor({ item, speakers, generating, onSave, onRegenerate, onCancel }: Props) {
  const [text, setText] = useState(item.line);
  const [speaker, setSpeaker] = useState(item.speaker);
  const [take, setTake] = useState(String(item.take));
  const [saving, setSaving] = useState(false);
  // Regenerate changes the take on the server; show the new one.
  useEffect(() => setTake(String(item.take)), [item.take]);

  const save = async () => {
    const patch: ItemPatchRequest = {};
    if (text !== item.line) patch.text = text;
    if (speaker !== item.speaker) patch.speaker = speaker;
    const takeNumber = Number(take);
    if (Number.isInteger(takeNumber) && takeNumber >= 0 && takeNumber !== item.take) {
      patch.take = takeNumber;
    }
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    await onSave(patch);
    setSaving(false);
  };

  return (
    <div className="sheet editor" role="dialog" aria-modal="true" aria-labelledby="editor-title">
      <h2 id="editor-title">Edit line {item.id}</h2>
      <label>
        Text
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} />
      </label>
      <label>
        Speaker
        <select value={speaker} onChange={(e) => setSpeaker(e.target.value)}>
          {speakers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Take
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={take}
          onChange={(e) => setTake(e.target.value)}
        />
      </label>
      <button type="button" disabled={generating} onClick={onRegenerate}>
        {generating ? "Generating…" : "Regenerate"}
      </button>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
}

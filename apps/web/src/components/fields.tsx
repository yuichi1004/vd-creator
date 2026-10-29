// Inputs that save when the edit is done: on Enter or when focus leaves.

import { type KeyboardEvent, useEffect, useRef, useState } from "react";

type TextProps = {
  value: string;
  label: string;
  multiline?: boolean;
  onSave: (value: string) => Promise<boolean>;
};

/** Text edited in place. Escape restores the saved value. */
export function EditableText({ value, label, multiline, onSave }: TextProps) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const cancelled = useRef(false);
  // A reload replaces the draft unless the user is typing.
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const commit = async () => {
    editing.current = false;
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = draft.trim();
    if (next === value || next.length === 0) {
      setDraft(value);
      return;
    }
    if (!(await onSave(next))) setDraft(value);
  };
  const common = {
    "aria-label": label,
    value: draft,
    onFocus: () => {
      editing.current = true;
    },
    onBlur: () => void commit(),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        cancelled.current = true;
        setDraft(value);
        e.currentTarget.blur();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
  };
  return multiline ? (
    <textarea
      className="editable"
      rows={Math.min(6, Math.max(1, Math.ceil(draft.length / 60)))}
      {...common}
      onChange={(e) => setDraft(e.target.value)}
    />
  ) : (
    <input className="editable" {...common} onChange={(e) => setDraft(e.target.value)} />
  );
}

type NumberProps = {
  value: number;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  onSave: (value: number) => Promise<boolean>;
};

/** A number saved when focus leaves, if it is valid and changed. */
export function NumberField({ value, label, min, max, step, integer, onSave }: NumberProps) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);

  const commit = async () => {
    editing.current = false;
    const next = Number(draft);
    const valid =
      draft.trim() !== "" &&
      Number.isFinite(next) &&
      (!integer || Number.isInteger(next)) &&
      (min === undefined || next >= min) &&
      (max === undefined || next <= max);
    if (!valid || next === value) {
      setDraft(String(value));
      return;
    }
    if (!(await onSave(next))) setDraft(String(value));
  };
  return (
    <input
      type="number"
      className="number"
      inputMode={integer ? "numeric" : "decimal"}
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

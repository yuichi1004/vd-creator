// Edits of a scene's BGM. The scenario package has `updateItem` for items but no scene
// helper, so this edits a copy of the parsed `yaml` Document, which keeps comments, and
// checks that nothing but the BGM changed.

import { ScenarioDocument, ScenarioEditError } from "@vd-creator/scenario";
import type { ScenePatchRequest } from "./api.js";

/** The plain data of the document, or undefined if it does not convert. */
export function documentData(doc: ScenarioDocument): unknown {
  if (doc.yamlIssues().some((i) => i.severity === "error")) return undefined;
  try {
    return doc.document.toJS();
  } catch {
    return undefined;
  }
}

/** The index of the scene with the ID in the document's data, or -1. */
export function sceneIndex(data: unknown, id: string): number {
  const scenes = isRecord(data) && Array.isArray(data.scenes) ? data.scenes : [];
  return scenes.findIndex((scene) => isRecord(scene) && scene.id === id);
}

/**
 * Sets the BGM source and volume of the scene at `index`, in place. Throws a
 * `ScenarioEditError`, leaving the document unchanged, if the edit cannot be made, if the
 * edited document would differ anywhere else, or if it would not validate.
 */
export function updateSceneBgm(doc: ScenarioDocument, index: number, patch: ScenePatchRequest) {
  const at = ["scenes", index, "bgm"];
  const before = documentData(doc);
  const scenes = isRecord(before) && Array.isArray(before.scenes) ? before.scenes : [];
  const scene = scenes[index];
  if (!isRecord(scene)) throw refusal("The scene cannot be edited");
  const current = isRecord(scene.bgm) ? scene.bgm : undefined;
  if (!current && !patch.bgm) throw refusal("The scene has no BGM to set the volume of");

  const expected: Record<string, unknown> = { ...current };
  if (patch.bgm) {
    delete expected.prompt;
    delete expected.library;
    Object.assign(expected, patch.bgm);
  }
  if (patch.volume !== undefined) expected.volume = patch.volume;

  let text: string;
  try {
    const edited = doc.document.clone();
    if (!current) {
      edited.setIn(at, edited.createNode(expected));
    } else {
      if (patch.bgm) {
        for (const key of ["prompt", "library"]) {
          if (key in current && !(key in patch.bgm)) edited.deleteIn([...at, key]);
        }
        for (const [key, value] of Object.entries(patch.bgm)) edited.setIn([...at, key], value);
      }
      if (patch.volume !== undefined) edited.setIn([...at, "volume"], patch.volume);
    }
    text = edited.toString();
  } catch {
    // For example a scene or BGM defined by an alias, which the edit cannot go through.
    throw refusal("The scene uses YAML features that the editor does not support");
  }

  const next = new ScenarioDocument(text);
  const after = documentData(next);
  const wanted = structuredClone(before) as { scenes: Record<string, unknown>[] };
  (wanted.scenes[index] as Record<string, unknown>).bgm = expected;
  if (after === undefined || canonical(after) !== canonical(wanted)) {
    throw refusal("The scene uses YAML features that the editor does not support");
  }
  const errors = next.validate().issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw new ScenarioEditError("Refusing an edit that makes the scenario invalid", errors);
  }
  doc.setText(text);
}

function refusal(message: string): ScenarioEditError {
  return new ScenarioEditError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON with sorted keys, so that key order does not matter.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

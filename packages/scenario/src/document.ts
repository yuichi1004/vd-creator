import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Document,
  isMap,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  parseDocument,
  Scalar,
  stringify,
  type YAMLMap,
} from "yaml";
import { ITEM_KINDS, type ItemPatch } from "./schema.js";
import { type Issue, type ValidationResult, validateScenarioData } from "./validate.js";

/** File name of the scenario inside a project folder. */
export const SCENARIO_FILE = "scenario.yaml";

/**
 * A scenario.yaml file as YAML source. Edits splice the source text and re-parse it,
 * so everything outside the edited value, including comments and formatting, is kept
 * byte for byte.
 */
export class ScenarioDocument {
  #text: string;
  #doc: Document.Parsed;

  constructor(text: string) {
    this.#text = text;
    this.#doc = parseDocument(text);
  }

  /** The current YAML source. */
  get text(): string {
    return this.#text;
  }

  /** The parsed `yaml` Document. Treat it as read-only; edit through the helpers. */
  get document(): Document.Parsed {
    return this.#doc;
  }

  /** YAML syntax errors and warnings. Errors mean the text is not valid YAML. */
  yamlIssues(): Issue[] {
    return [
      ...this.#doc.errors.map((e) => ({
        path: [],
        message: e.message,
        severity: "error" as const,
      })),
      ...this.#doc.warnings.map((w) => ({
        path: [],
        message: w.message,
        severity: "warning" as const,
      })),
    ];
  }

  /** Validates the current content. */
  validate(): ValidationResult {
    const yamlIssues = this.yamlIssues();
    if (yamlIssues.some((i) => i.severity === "error")) return { issues: yamlIssues };
    const result = validateScenarioData(this.#doc.toJS());
    return { scenario: result.scenario, issues: [...yamlIssues, ...result.issues] };
  }

  toString(): string {
    return this.#text;
  }

  /** Replaces `text[start, end)` and re-parses. Throws, keeping the old text, if the result is not valid YAML. */
  splice(start: number, end: number, replacement: string): void {
    const text = this.#text.slice(0, start) + replacement + this.#text.slice(end);
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
      throw new Error(`Edit would make the YAML invalid: ${doc.errors[0]?.message}`);
    }
    this.#text = text;
    this.#doc = doc;
  }
}

/** Parses and validates scenario.yaml text. */
export function parseScenario(text: string): ValidationResult {
  return new ScenarioDocument(text).validate();
}

/** Reads and validates `<projectDir>/scenario.yaml`. Throws if the file cannot be read. */
export async function loadScenario(
  projectDir: string,
): Promise<ValidationResult & { doc: ScenarioDocument }> {
  const doc = new ScenarioDocument(await readFile(join(projectDir, SCENARIO_FILE), "utf8"));
  return { ...doc.validate(), doc };
}

/** Writes the document to `<projectDir>/scenario.yaml`, replacing the file atomically. */
export async function saveScenario(projectDir: string, doc: ScenarioDocument): Promise<void> {
  const target = join(projectDir, SCENARIO_FILE);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, doc.text, "utf8");
  await rename(temp, target);
}

/**
 * Sets or removes fields of the scene item with the given ID, in place. A value of
 * `undefined` removes the key. The kind key and `id` of an item cannot be removed.
 * Only the edited values change in the YAML source. Throws if no item has the ID.
 * The patch is not validated; call `doc.validate()` afterwards.
 */
export function updateItem(doc: ScenarioDocument, id: string, patch: ItemPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    const item = findItem(doc, id);
    if (!item) throw new Error(`No item with id "${id}"`);
    if (item.flow) {
      replaceFlowItem(doc, item, key, value);
    } else {
      updateBlockItem(doc, item, key, value);
    }
    // Follow a renamed item.
    if (key === "id" && typeof value === "string") id = value;
  }
}

function findItem(doc: ScenarioDocument, id: string): YAMLMap | undefined {
  const root = doc.document.contents;
  if (!isMap(root)) return undefined;
  const scenes = root.get("scenes", true);
  if (!isSeq(scenes)) return undefined;
  for (const scene of scenes.items) {
    if (!isMap(scene)) continue;
    const items = scene.get("items", true);
    if (!isSeq(items)) continue;
    for (const item of items.items) {
      if (isMap(item) && item.get("id") === id) return item;
    }
  }
  return undefined;
}

function findPair(map: YAMLMap, key: string): Pair<Node, Node | null> | undefined {
  return (map.items as Pair<Node, Node | null>[]).find(
    (pair) => isScalar(pair.key) && pair.key.value === key,
  );
}

function updateBlockItem(doc: ScenarioDocument, item: YAMLMap, key: string, value: unknown): void {
  const text = doc.text;
  const pair = findPair(item, key);

  if (value === undefined) {
    if (!pair) return;
    if (key === "id" || (ITEM_KINDS as readonly string[]).includes(key)) {
      throw new Error(`Cannot remove "${key}" from an item`);
    }
    const keyStart = requireRange(pair.key)[0];
    const start = lineStart(text, keyStart);
    if (text.slice(start, keyStart).trim() !== "") {
      throw new Error(`Cannot remove "${key}": it shares a line with the sequence indicator`);
    }
    const end = lineEnd(text, pair.value ? requireRange(pair.value)[1] : requireRange(pair.key)[1]);
    doc.splice(start, end, "");
    return;
  }

  if (pair) {
    if (pair.value && sameValue(pair.value.toJSON(), value)) return;
    if (!pair.value?.range) throw new Error(`Cannot locate the value of "${key}"`);
    const [start, end] = pair.value.range;
    doc.splice(start, end, valueText(value, pair.value));
    return;
  }

  const first = item.items[0] as Pair<Node, Node | null> | undefined;
  const last = item.items.at(-1) as Pair<Node, Node | null> | undefined;
  if (!first || !last) throw new Error("Cannot add a key to an empty item");
  const firstKeyStart = requireRange(first.key)[0];
  const indent = " ".repeat(firstKeyStart - lineStart(text, firstKeyStart));
  const at = lineEnd(text, last.value ? requireRange(last.value)[1] : requireRange(last.key)[1]);
  const prefix = at > 0 && text[at - 1] !== "\n" ? "\n" : "";
  doc.splice(at, at, `${prefix}${indent}${key}: ${valueText(value, undefined)}\n`);
}

// A flow map item, such as `- { pause: 1 }`, is rewritten as a whole.
function replaceFlowItem(doc: ScenarioDocument, item: YAMLMap, key: string, value: unknown): void {
  const data = item.toJSON() as Record<string, unknown>;
  if (value === undefined) {
    if (key === "id" || (ITEM_KINDS as readonly string[]).includes(key)) {
      throw new Error(`Cannot remove "${key}" from an item`);
    }
    delete data[key];
  } else {
    data[key] = value;
  }
  const [start, end] = requireRange(item);
  doc.splice(start, end, stringify(data, { collectionStyle: "flow", lineWidth: 0 }).trimEnd());
}

// Formats a value to replace `previous`. Strings keep their quote style where possible.
function valueText(value: unknown, previous: Node | undefined): string {
  if (typeof value === "object" && value !== null) {
    return stringify(value, { collectionStyle: "flow", lineWidth: 0 }).trimEnd();
  }
  const node = new Scalar(value);
  if (typeof value === "string") {
    const type = isScalar(previous) ? previous.type : undefined;
    if (value.includes("\n")) node.type = Scalar.QUOTE_DOUBLE;
    else if (
      type === Scalar.PLAIN ||
      type === Scalar.QUOTE_DOUBLE ||
      type === Scalar.QUOTE_SINGLE
    ) {
      node.type = type;
    }
  }
  return new Document(node).toString({ lineWidth: 0 }).trimEnd();
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function requireRange(node: Node | null | undefined): [number, number, number] {
  if (!node?.range) throw new Error("YAML node has no source range");
  return node.range;
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}

// The index just after the newline that ends the line containing `index`. An index at
// the start of a line counts as the end of the previous line.
function lineEnd(text: string, index: number): number {
  if (index > 0 && text[index - 1] === "\n") return index;
  const newline = text.indexOf("\n", index);
  return newline === -1 ? text.length : newline + 1;
}

import {
  Composer,
  CST,
  type Document,
  isMap,
  isSeq,
  type Node,
  Parser,
  parse,
  type Scalar,
  stringify,
  type YAMLMap,
} from "yaml";
import type { ScenarioDocument } from "./document.js";
import { ITEM_KINDS, type ItemPatch } from "./schema.js";

// Edits work on the CST (concrete syntax tree) of the source, which keeps every space,
// newline, and comment. Values are changed on the tokens in place and the tree is
// stringified again, so only the edited values change in the output.

type MapToken = CST.BlockMap | CST.FlowCollection;
type Item = CST.CollectionItem;

/**
 * Sets or removes fields of the scene item with the given ID, in place. A value of
 * `undefined` removes the key. The patch is applied all or nothing: if any field
 * cannot be applied, the document is left unchanged and an error is thrown.
 *
 * Throws if no item has the ID, if the patch removes the item's kind key or `id`, or
 * if it renames the item to an ID that another scene or item already uses. Field
 * values are not validated; call `doc.validate()` afterwards. `saveScenario` refuses
 * to write an invalid document.
 */
export function updateItem(doc: ScenarioDocument, id: string, patch: ItemPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined && (key === "id" || (ITEM_KINDS as readonly string[]).includes(key))) {
      throw new Error(`Cannot remove "${key}" from an item`);
    }
  }

  const tokens = Array.from(new Parser().parse(doc.text));
  const composed = Array.from(new Composer({ keepSourceTokens: true }).compose(tokens));
  const document = composed[0];
  if (!document || composed.some((d) => d.errors.length > 0)) {
    throw new Error("Cannot edit a document with YAML errors");
  }
  const { item, otherIds } = findItem(document, id);
  if (!item) throw new Error(`No item with id "${id}"`);
  if (typeof patch.id === "string" && patch.id !== id && otherIds.has(patch.id)) {
    throw new Error(`Cannot rename "${id}" to "${patch.id}": the id is already used`);
  }
  const token = item.srcToken;
  if (!isMapToken(token)) throw new Error(`Item "${id}" is not a mapping`);

  for (const [key, value] of Object.entries(patch)) {
    const current = item.get(key, true) as Node | undefined;
    if (value !== undefined && current && sameValue(current.toJSON(), value)) continue;
    setField(token, key, value);
  }

  let text = tokens.map((t) => CST.stringify(t)).join("");
  if (usesCrlf(doc.text)) text = text.replace(/\r?\n/g, "\r\n");
  doc.setText(text);
}

function findItem(
  document: Document,
  id: string,
): { item: YAMLMap | undefined; otherIds: Set<unknown> } {
  let item: YAMLMap | undefined;
  const otherIds = new Set<unknown>();
  const scenes = isMap(document.contents) ? document.contents.get("scenes", true) : undefined;
  for (const scene of isSeq(scenes) ? scenes.items : []) {
    if (!isMap(scene)) continue;
    otherIds.add(scene.get("id"));
    const items = scene.get("items", true);
    for (const node of isSeq(items) ? items.items : []) {
      if (!isMap(node)) continue;
      if (!item && node.get("id") === id) item = node;
      else otherIds.add(node.get("id"));
    }
  }
  return { item, otherIds };
}

function setField(map: MapToken, key: string, value: unknown): void {
  const index = map.items.findIndex((item) => keyOf(item) === key);
  if (value === undefined) {
    if (index !== -1) removeItem(map, index);
  } else if (index === -1) {
    addItem(map, key, value);
  } else {
    setValue(map.items[index] as Item, value, map.type === "flow-collection");
  }
}

function setValue(item: Item, value: unknown, inFlow: boolean): void {
  const token = item.value;
  if (!token) {
    // A key without a value, such as `direction:`.
    const newline = item.sep?.some((t) => t.type === "newline");
    item.sep = [colon(), space(1)];
    item.value = valueToken(value, 0, inFlow, newline ? [newlineToken()] : []);
    return;
  }
  if (isRecord(value)) {
    if (isMapToken(token)) {
      for (const [k, v] of Object.entries(value)) setField(token, k, v);
      for (const k of token.items.map(keyOf)) {
        if (k !== undefined && !Object.hasOwn(value, k)) setField(token, k, undefined);
      }
      return;
    }
    const trailing = takeTrailing(token);
    if (token.type === "block-seq") fixSeparator(item);
    item.value = valueToken(value, 0, inFlow, trailing);
    return;
  }
  if (token.type === "block-map" || token.type === "block-seq") fixSeparator(item);
  const { source, type } = scalarSource(value, token, inFlow);
  CST.setScalarValue(token, source, { afterKey: !inFlow, inFlow, type });
  escapeDoubleQuoted(token, value);
}

// The yaml stringifier folds line breaks in double-quoted strings over several lines.
// JSON strings are valid YAML double-quoted scalars and keep the value on one line.
function escapeDoubleQuoted(token: CST.Token, value: unknown): void {
  if (token.type === "double-quoted-scalar" && typeof value === "string") {
    token.source = JSON.stringify(value);
  }
}

function addItem(map: MapToken, key: string, value: unknown): void {
  const keyToken = CST.createScalarToken(key, { indent: 0, end: [] });
  if (map.type === "block-map") {
    const last = findLastIndex(map.items, (item) => item.key !== undefined);
    const previous = map.items[last];
    if (previous) ensureNewline(previous);
    map.items.splice(last + 1, 0, {
      start: map.indent > 0 ? [space(map.indent)] : [],
      key: keyToken,
      sep: [colon(), space(1)],
      value: valueToken(value, map.indent, false, [newlineToken()]),
    });
  } else {
    // Move the whitespace and comments before the closing brace after the new pair.
    const previous = map.items.at(-1);
    const trailing = previous?.value ? takeTrailing(previous.value) : [];
    map.items.push({
      start: previous ? [comma(), space(1)] : [space(1)],
      key: keyToken,
      sep: [colon(), space(1)],
      value: valueToken(value, map.indent, true, trailing),
    });
  }
}

function removeItem(map: MapToken, index: number): void {
  const [removed] = map.items.splice(index, 1);
  if (!removed) return;
  const next = map.items[index];
  if (map.type === "block-map") {
    // The first pair of `- key: value` follows the sequence indicator on its line.
    if (index === 0 && next) {
      const start = [...next.start];
      if (start[0]?.type === "space") start.shift();
      next.start = [...removed.start, ...start];
    }
    return;
  }
  if (index === 0 && next) {
    next.start = next.start.filter((t) => t.type !== "comma");
    if (next.start[0]?.type !== "space") next.start.unshift(...removed.start);
  }
  const last = map.items.at(-1);
  if (!next && last?.value && removed.value) {
    putTrailing(last.value, takeTrailing(removed.value));
  }
}

// After a block collection value turns into a flow value, the value follows the key on
// the same line.
function fixSeparator(item: Item): void {
  item.sep = [colon(), space(1)];
}

function valueToken(value: unknown, indent: number, inFlow: boolean, end: CST.SourceToken[]) {
  if (isRecord(value)) {
    const source = stringify(value, { collectionStyle: "flow", lineWidth: 0 }).trimEnd();
    const parsed = Array.from(new Parser().parse(source)).find((t) => t.type === "document");
    const token = parsed?.value;
    if (token?.type !== "flow-collection") throw new Error("Cannot format the value");
    token.end = [...token.end.filter((t) => t.type.startsWith("flow-")), ...end];
    return token;
  }
  const { source, type } = scalarSource(value, undefined, inFlow);
  const token = CST.createScalarToken(source, { indent, inFlow, type: type ?? "PLAIN", end });
  escapeDoubleQuoted(token, value);
  return token;
}

// Chooses how to write a scalar. Strings keep the quote or block style of the value
// they replace. Plain strings are used only where they read back as the same string.
function scalarSource(
  value: unknown,
  previous: CST.Token | undefined,
  inFlow: boolean,
): { source: string; type: Scalar.Type | undefined } {
  if (typeof value !== "string") return { source: String(value), type: "PLAIN" };
  if (
    previous &&
    (previous.type === "single-quoted-scalar" ||
      previous.type === "double-quoted-scalar" ||
      previous.type === "block-scalar")
  ) {
    return { source: value, type: undefined };
  }
  return { source: value, type: isPlainSafe(value, inFlow) ? "PLAIN" : "QUOTE_DOUBLE" };
}

function isPlainSafe(value: string, inFlow: boolean): boolean {
  if (value.includes("\n") || value.trim() !== value || value === "") return false;
  const token = CST.createScalarToken(value, { indent: 0, inFlow, type: "PLAIN" });
  if (token.type !== "scalar" || token.source !== value) return false;
  try {
    return inFlow ? parse(`[${value}]`)?.[0] === value : parse(`k: ${value}`)?.k === value;
  } catch {
    return false;
  }
}

// Removes and returns the spaces, comments, and newline after a value.
function takeTrailing(token: CST.Token): CST.SourceToken[] {
  switch (token.type) {
    case "block-scalar": {
      const trailing = token.props.slice(1) as CST.SourceToken[];
      token.props = token.props.slice(0, 1);
      return trailing;
    }
    case "block-map":
    case "block-seq":
      return [newlineToken()];
    case "flow-collection": {
      const close = token.end.findIndex((t) => t.type.startsWith("flow-"));
      return token.end.splice(close + 1);
    }
    default: {
      if (!isFlowScalar(token) || !token.end) return [];
      const trailing = token.end;
      token.end = [];
      return trailing;
    }
  }
}

function putTrailing(token: CST.Token, trailing: CST.SourceToken[]): void {
  if (token.type === "flow-collection") token.end.push(...trailing);
  else if (isFlowScalar(token)) token.end = [...(token.end ?? []), ...trailing];
}

// A flow scalar has no `end` array when nothing follows it on its line.
function isFlowScalar(token: CST.Token): token is CST.FlowScalar {
  return (
    token.type === "scalar" ||
    token.type === "single-quoted-scalar" ||
    token.type === "double-quoted-scalar" ||
    token.type === "alias"
  );
}

// Makes sure that a block map pair ends with a newline, so that a pair can follow it.
function ensureNewline(item: Item): void {
  const value = item.value;
  if (!value) {
    if (!item.sep?.some((t) => t.type === "newline"))
      item.sep = [...(item.sep ?? []), newlineToken()];
    return;
  }
  switch (value.type) {
    case "block-scalar":
      if (!value.source.endsWith("\n")) value.source += "\n";
      return;
    case "block-map":
    case "block-seq": {
      const last = value.items.at(-1);
      if (last) ensureNewline(last);
      return;
    }
    case "flow-collection":
      if (!value.end.some((t) => t.type === "newline")) value.end.push(newlineToken());
      return;
    default:
      if (isFlowScalar(value) && !value.end?.some((t) => t.type === "newline")) {
        value.end = [...(value.end ?? []), newlineToken()];
      }
  }
}

function keyOf(item: Item): string | undefined {
  if (!item.key || !CST.isScalar(item.key)) return undefined;
  return CST.resolveAsScalar(item.key, false, () => {})?.value;
}

function isMapToken(token: unknown): token is MapToken {
  if (typeof token !== "object" || token === null) return false;
  const t = token as CST.Token;
  return t.type === "block-map" || (t.type === "flow-collection" && t.start.source === "{");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function usesCrlf(text: string): boolean {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
}

function findLastIndex<T>(list: T[], predicate: (entry: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i] as T)) return i;
  return -1;
}

function colon(): CST.SourceToken {
  return { type: "map-value-ind", offset: -1, indent: 0, source: ":" };
}

function comma(): CST.SourceToken {
  return { type: "comma", offset: -1, indent: 0, source: "," };
}

function space(width: number): CST.SourceToken {
  return { type: "space", offset: -1, indent: 0, source: " ".repeat(width) };
}

function newlineToken(): CST.SourceToken {
  return { type: "newline", offset: -1, indent: 0, source: "\n" };
}

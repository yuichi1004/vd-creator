import { Composer, CST, type Document, isMap, Parser, parse, type Scalar, stringify } from "yaml";
import { ScenarioDocument } from "./document.js";
import { ITEM_KINDS, type ItemPatch } from "./schema.js";
import { formatPath, type Issue } from "./validate.js";

// Edits work on the CST (concrete syntax tree) of the source, which keeps every space,
// newline, and comment. Values are changed on the tokens in place and the tree is
// stringified again, so only the edited values change in the output.

type MapToken = CST.BlockMap | CST.FlowCollection;
type Item = CST.CollectionItem;

/** Thrown by `updateItem` when it refuses an edit. The document is left unchanged. */
export class ScenarioEditError extends Error {
  readonly issues: Issue[];

  constructor(message: string, issues: Issue[] = [{ path: [], message, severity: "error" }]) {
    super(message);
    this.name = "ScenarioEditError";
    this.issues = issues;
  }
}

/**
 * Sets or removes fields of the scene item with the given ID, in place. A value of
 * `undefined` removes the key. The patch is applied all or nothing: if any field
 * cannot be applied, the document is left unchanged and an error is thrown.
 *
 * Throws if no item has the ID, if the patch removes the item's kind key or `id`, or
 * if it renames the item to an ID that another scene or item already uses. As a last
 * check, the edited text is parsed and validated again. A `ScenarioEditError` is thrown
 * if the item would not read back as patched, or if a valid scenario would become
 * invalid, for example through an unknown speaker or an unresolved alias.
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
  const before = document && composed.every((d) => d.errors.length === 0) && toData(document);
  if (!before) throw new Error("Cannot edit a document with YAML errors");
  // IDs are compared on the resolved data, so that aliased IDs count like any other.
  const target = findItem(before, id);
  if (!target) throw new Error(`No item with id "${id}"`);
  const { path, current, otherIds } = target;
  if (typeof patch.id === "string" && patch.id !== id && otherIds.has(patch.id)) {
    throw new Error(`Cannot rename "${id}" to "${patch.id}": the id is already used`);
  }
  const item = document.getIn(path, true);
  const token = isMap(item) ? item.srcToken : undefined;
  if (!isMapToken(token)) throw new Error(`Item "${id}" is not a mapping`);

  const expected: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete expected[key];
    else expected[key] = value;
    if (value !== undefined && sameValue(current[key], value)) continue;
    setField(token, key, value);
  }

  let text = tokens.map((t) => CST.stringify(t)).join("");
  if (usesCrlf(doc.text)) text = text.replace(/\r?\n/g, "\r\n");
  checkEdit(doc, text, path, expected);
  doc.setText(text);
}

// Parses and validates the edited text again. Refuses text that does not parse, an item
// that does not read back as patched, and new errors in a scenario that was valid.
function checkEdit(
  doc: ScenarioDocument,
  text: string,
  path: (string | number)[],
  expected: Record<string, unknown>,
): void {
  const next = new ScenarioDocument(text);
  const yamlErrors = next.yamlIssues().filter((i) => i.severity === "error");
  if (yamlErrors.length > 0) {
    throw new ScenarioEditError(`Refusing an edit that breaks the YAML: ${yamlErrors[0]?.message}`);
  }
  const data = toData(next.document);
  const actual = data && getPath(data, path);
  if (!actual || canonical(actual) !== canonical(expected)) {
    const message =
      "Refusing an edit that would not read back as requested, for example because an alias depends on the edited value";
    throw new ScenarioEditError(message, [{ path, message, severity: "error" }]);
  }
  const errorsOf = (issues: Issue[]) => issues.filter((i) => i.severity === "error");
  if (errorsOf(doc.validate().issues).length > 0) return;
  const errors = errorsOf(next.validate().issues);
  if (errors.length > 0) {
    throw new ScenarioEditError(
      `Refusing an edit that makes the scenario invalid: ${errors
        .map((i) => `${formatPath(i.path)}: ${i.message}`)
        .join("; ")}`,
      errors,
    );
  }
}

// Plain data of the document with aliases resolved, or undefined if they do not resolve.
function toData(document: Document): unknown {
  try {
    return document.toJS() ?? null;
  } catch {
    return undefined;
  }
}

function findItem(
  data: unknown,
  id: string,
):
  | { path: (string | number)[]; current: Record<string, unknown>; otherIds: Set<unknown> }
  | undefined {
  let found: { path: (string | number)[]; current: Record<string, unknown> } | undefined;
  const otherIds = new Set<unknown>();
  const scenes = isRecord(data) ? data.scenes : undefined;
  for (const [i, scene] of (Array.isArray(scenes) ? scenes : []).entries()) {
    if (!isRecord(scene)) continue;
    otherIds.add(scene.id);
    const items = scene.items;
    for (const [j, node] of (Array.isArray(items) ? items : []).entries()) {
      if (!isRecord(node)) continue;
      if (!found && node.id === id) found = { path: ["scenes", i, "items", j], current: node };
      else otherIds.add(node.id);
    }
  }
  return found && { ...found, otherIds };
}

function getPath(data: unknown, path: (string | number)[]): Record<string, unknown> | undefined {
  let value = data;
  for (const key of path)
    value =
      isRecord(value) || Array.isArray(value)
        ? (value as Record<string | number, unknown>)[key]
        : undefined;
  return isRecord(value) ? value : undefined;
}

// JSON with sorted keys, so that key order does not matter.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
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
    const comments = token.type === "block-seq" ? fixSeparator(item) : [];
    item.value = valueToken(value, 0, inFlow, [...comments, ...trailing]);
    return;
  }
  const comments =
    token.type === "block-map" || token.type === "block-seq" ? fixSeparator(item) : [];
  const { source, type } = scalarSource(value, token, inFlow);
  CST.setScalarValue(token, source, { afterKey: !inFlow, inFlow, type });
  escapeDoubleQuoted(token, value);
  if (comments.length > 0 && isFlowScalar(token)) {
    const end = token.end ?? [];
    const newline = end.findIndex((t) => t.type === "newline");
    end.splice(newline === -1 ? end.length : newline, 0, ...comments);
    token.end = end;
  }
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
    // A trailing comma, as in `{ a: 1, }`, is an item without key or value. The new pair
    // goes before it. Otherwise, move the whitespace and comments before the closing
    // brace after the new pair.
    const last = map.items.at(-1);
    const sentinel = last && !last.key && !last.sep && !last.value;
    const previous = sentinel ? map.items.at(-2) : last;
    const trailing = !sentinel && previous?.value ? takeTrailing(previous.value) : [];
    map.items.splice(sentinel ? -1 : map.items.length, 0, {
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
// the same line. An anchor stays before the value, and comments on the key line move
// after it; they are returned to be put at the end of the new value. A tag cannot stay,
// because it names the collection type, so the edit is refused.
function fixSeparator(item: Item): CST.SourceToken[] {
  const sep = item.sep ?? [];
  const tag = sep.find((t) => t.type === "tag");
  if (tag) {
    throw new ScenarioEditError(
      `Cannot replace a collection tagged ${tag.source} with a value of another type`,
    );
  }
  const anchors = sep.filter((t) => t.type === "anchor");
  item.sep = [colon(), space(1), ...anchors.flatMap((t) => [t, space(1)])];
  return sep.filter((t) => t.type === "comment").flatMap((t) => [space(1), t]);
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

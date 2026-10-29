import {
  type Alias,
  Composer,
  CST,
  type Document,
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  type Node,
  Parser,
  parse,
  type Scalar,
  stringify,
  visit,
  type YAMLMap,
} from "yaml";
import { ScenarioDocument } from "./document.js";
import { ScenarioEditError } from "./errors.js";
import { ITEM_KINDS, type ItemPatch } from "./schema.js";
import { formatPath, type Issue, type IssuePath } from "./validate.js";

// Policy: forms that people actually write must be editable. That covers block and flow
// mappings, comments anywhere, quoted and block scalars, trailing commas, closing braces
// on their own line, and empty values. Exotic forms are refused cleanly: items, scenes,
// item lists, or the whole scenes list defined by an alias, explicit tags such as `!!str`
// on a field the edit touches, anchors or tags on the line after a key, and aliases that
// make a cycle. Every failure throws a `ScenarioEditError` whose issues say what is
// wrong and where, never a plain `Error`. As a safety net for forms nobody thought of,
// `updateItem` turns any other error into a `ScenarioEditError` with a generic issue at
// the item path.
//
// Edits work on the CST (concrete syntax tree) of the source, which keeps every space,
// newline, and comment. Values are changed on the tokens in place and the tree is
// stringified again, so only the edited values change in the output.

type MapToken = CST.BlockMap | CST.FlowCollection;
type Item = CST.CollectionItem;

/**
 * Sets or removes fields of the scene item with the given ID, in place. A value of
 * `undefined` removes the key. The patch is applied all or nothing: if any field
 * cannot be applied, the document is left unchanged.
 *
 * Throws a `ScenarioEditError` if no item has the ID, if the patch removes the item's
 * kind key or `id`, if it renames the item to an ID that another scene or item already
 * uses, or if the item cannot be edited in place. As a last check, the edited text is
 * parsed and validated again, and the edit is refused if the item would not read back
 * as patched or if a valid scenario would become invalid.
 */
export function updateItem(doc: ScenarioDocument, id: string, patch: ItemPatch): void {
  const at: { path: IssuePath } = { path: [] };
  try {
    applyPatch(doc, id, patch, at);
  } catch (e) {
    if (e instanceof ScenarioEditError) throw e;
    // The text of an unexpected error may describe internals, so it is kept only as
    // the cause and never shown in the issue.
    const message = `Item "${id}" uses YAML features that the editor does not support`;
    throw new ScenarioEditError(
      `Refusing the edit of item "${id}": ${message}`,
      [{ path: at.path, message, severity: "error" }],
      { cause: e },
    );
  }
}

// `at.path` is set to the item path once the item is found, for the generic refusal.
function applyPatch(
  doc: ScenarioDocument,
  id: string,
  patch: ItemPatch,
  at: { path: IssuePath },
): void {
  const tokens = Array.from(new Parser().parse(doc.text));
  const composed = Array.from(new Composer({ keepSourceTokens: true }).compose(tokens));
  const document = composed[0];
  const yamlErrors = composed.flatMap((d) => d.errors);
  if (!document || yamlErrors.length > 0) {
    throw new ScenarioEditError(
      "Cannot edit a document with YAML errors",
      yamlErrors.map((e) => ({ path: [], message: e.message, severity: "error" })),
    );
  }
  const before = toData(document);
  if (!before.ok) {
    throw new ScenarioEditError(
      "Cannot edit a document whose aliases do not resolve",
      before.issues,
    );
  }
  // IDs are compared on the resolved data, so that aliased IDs count like any other.
  const target = findItem(before.data, id);
  if (!target) throw new ScenarioEditError(`No item with id "${id}"`);
  const { path, current, otherIds } = target;
  at.path = path;
  const cycle = findCycle(before.data, []);
  if (cycle) {
    throw refusal(id, [
      {
        path: cycle,
        message:
          "Refers through an alias to a value that contains it, which the editor does not support",
        severity: "error",
      },
    ]);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined && (key === "id" || (ITEM_KINDS as readonly string[]).includes(key))) {
      throw refusal(id, [
        { path: [...path, key], message: `Cannot remove "${key}" from an item`, severity: "error" },
      ]);
    }
  }
  if (typeof patch.id === "string" && patch.id !== id && otherIds.has(patch.id)) {
    const message = `Cannot rename "${id}" to "${patch.id}": the id is already used`;
    throw new ScenarioEditError(message, [{ path: [...path, "id"], message, severity: "error" }]);
  }
  const { node, token } = itemNode(document, path, id);

  const expected: Record<string, unknown> = { ...current };
  const touched: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete expected[key];
    else expected[key] = value;
    if (value === undefined ? Object.hasOwn(current, key) : !sameValue(current[key], value)) {
      touched.push(key);
    }
  }
  const tagged = taggedNodes(node, path, touched);
  if (tagged.length > 0) throw refusal(id, tagged);
  for (const key of touched) setField(token, key, expected[key], [...path, key]);

  let text = tokens.map((t) => CST.stringify(t)).join("");
  if (usesCrlf(doc.text)) text = text.replace(/\r?\n/g, "\r\n");
  checkEdit(doc, text, id, path, expected);
  doc.setText(text);
}

function refusal(id: string, issues: Issue[], reason = ""): ScenarioEditError {
  const causes = issues.map((i) => `${formatPath(i.path)}: ${i.message}`).join("; ");
  return new ScenarioEditError(`Refusing the edit of item "${id}"${reason}: ${causes}`, issues);
}

// Returns the node and CST of the item. Refuses an item that is itself an alias, or that
// sits in a scene or list that is an alias, since editing it would edit the original.
function itemNode(
  document: Document,
  path: IssuePath,
  id: string,
): { node: YAMLMap; token: MapToken } {
  const [, sceneIndex, , itemIndex] = path as [string, number, string, number];
  const aliased = (what: string, alias: Alias): ScenarioEditError =>
    refusal(id, [
      {
        path,
        message: `Item "${id}" is defined by an alias: ${what} is *${alias.source}. Edit the anchored original instead`,
        severity: "error",
      },
    ]);
  const scenes = isMap(document.contents) ? document.contents.get("scenes", true) : undefined;
  if (isAlias(scenes)) throw aliased("the scene list", scenes);
  const scene = isSeq(scenes) ? scenes.items[sceneIndex] : undefined;
  if (isAlias(scene)) throw aliased("its scene", scene);
  const items = isMap(scene) ? scene.get("items", true) : undefined;
  if (isAlias(items)) throw aliased("its scene's item list", items);
  const item = isSeq(items) ? items.items[itemIndex] : undefined;
  if (isAlias(item)) throw aliased("the item", item);
  const token = isMap(item) ? item.srcToken : undefined;
  if (!isMap(item) || !isMapToken(token)) {
    throw refusal(id, [{ path, message: `Item "${id}" is not a mapping`, severity: "error" }]);
  }
  return { node: item as YAMLMap, token };
}

// Issues for explicit tags, such as `!!str` or `!!map`, on the item or anywhere in the
// touched fields: on their keys, their values, or any node inside the values. Tags name
// the type of a value, so a new value cannot keep them, and the editor does not drop them.
function taggedNodes(item: YAMLMap, path: IssuePath, touched: string[]): Issue[] {
  const issue = (at: IssuePath, tag: string): Issue => ({
    path: at,
    message: `Has the explicit tag ${tag.replace(/^tag:yaml\.org,2002:/, "!!")}, which the editor does not support`,
    severity: "error",
  });
  if (item.tag) return [issue(path, item.tag)];
  const issues: Issue[] = [];
  for (const pair of item.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
    if (key === undefined || !touched.includes(key)) continue;
    const at = [...path, key];
    if (isScalar(pair.key) && pair.key.tag) issues.push(issue(at, pair.key.tag));
    if (!pair.value) continue;
    visit(pair.value as Node, (_, node, ancestors) => {
      if ((isScalar(node) || isMap(node) || isSeq(node)) && node.tag) {
        issues.push(issue([...at, ...dataPath([...ancestors, node])], node.tag));
      }
    });
  }
  return issues;
}

// The path of the first collection that contains itself through an alias, if any.
function findCycle(
  value: unknown,
  path: IssuePath,
  ancestors = new Set<unknown>(),
): IssuePath | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (ancestors.has(value)) return path;
  ancestors.add(value);
  const entries = Array.isArray(value) ? [...value.entries()] : Object.entries(value);
  for (const [key, child] of entries) {
    const found = findCycle(child, [...path, key], ancestors);
    if (found) return found;
  }
  ancestors.delete(value);
  return undefined;
}

// Parses and validates the edited text again. Refuses text that does not parse, an item
// that does not read back as patched, and new errors in a scenario that was valid.
function checkEdit(
  doc: ScenarioDocument,
  text: string,
  id: string,
  path: IssuePath,
  expected: Record<string, unknown>,
): void {
  const next = new ScenarioDocument(text);
  const yamlErrors = next.yamlIssues().filter((i) => i.severity === "error");
  if (yamlErrors.length > 0) {
    throw new ScenarioEditError(
      `Refusing an edit that breaks the YAML: ${yamlErrors[0]?.message}`,
      yamlErrors,
    );
  }
  const data = toData(next.document);
  if (!data.ok) throw refusal(id, data.issues, ", which would break an alias");
  const actual = getPath(data.data, path);
  const mismatches = actual ? readBackIssues(next.document, path, actual, expected) : [];
  if (!actual) {
    mismatches.push({
      path,
      message: `Item "${id}" would no longer be a mapping`,
      severity: "error",
    });
  }
  if (mismatches.length > 0) {
    throw refusal(id, mismatches, ", which would not read back as patched");
  }
  const errorsOf = (issues: Issue[]) => issues.filter((i) => i.severity === "error");
  if (errorsOf(doc.validate().issues).length > 0) return;
  const errors = errorsOf(next.validate().issues);
  if (errors.length > 0) throw refusal(id, errors, ", which makes the scenario invalid");
}

// One issue per field that differs from the patched value, naming the anchor when the
// field is an alias whose anchored value the edit changed.
function readBackIssues(
  document: Document,
  path: IssuePath,
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): Issue[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys]
    .filter((key) => canonical(actual[key]) !== canonical(expected[key]))
    .map((key) => {
      const node = document.getIn([...path, key], true);
      const readBack = `would read back as ${show(actual[key])} instead of ${show(expected[key])}`;
      const message = isAlias(node)
        ? `"${key}" refers to anchor &${node.source}, which this edit changes; it ${readBack}`
        : `"${key}" ${readBack}`;
      return { path: [...path, key], message, severity: "error" as const };
    });
}

function show(value: unknown): string {
  return value === undefined ? "missing" : JSON.stringify(value);
}

// Plain data of the document with aliases resolved. If an alias does not resolve, the
// issues name the anchor and the field that refers to it.
function toData(document: Document): { ok: true; data: unknown } | { ok: false; issues: Issue[] } {
  try {
    return { ok: true, data: document.toJS() ?? null };
  } catch {
    const issues = unresolvedAliases(document);
    if (issues.length > 0) return { ok: false, issues };
    // For example too many alias expansions.
    const message = "The aliases of the document cannot be resolved";
    return { ok: false, issues: [{ path: [], message, severity: "error" }] };
  }
}

function unresolvedAliases(document: Document): Issue[] {
  const issues: Issue[] = [];
  visit(document, {
    Alias(_, node, ancestors) {
      if (node.resolve(document) !== undefined) return;
      const path = dataPath([...ancestors, node]);
      issues.push({
        path,
        message: `${formatPath(path)} refers to anchor &${node.source}, which would be removed or renamed`,
        severity: "error",
      });
    },
  });
  return issues;
}

// The data path of the last node in a chain of ancestors from `visit`.
function dataPath(chain: readonly unknown[]): IssuePath {
  const path: IssuePath = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const parent = chain[i];
    const child = chain[i + 1];
    if (isSeq(parent)) path.push(parent.items.indexOf(child as Node));
    else if (isPair(parent) && child === parent.value) {
      const key = parent.key;
      path.push(isScalar(key) ? String(key.value) : String(key));
    }
  }
  return path;
}

function findItem(
  data: unknown,
  id: string,
): { path: IssuePath; current: Record<string, unknown>; otherIds: Set<unknown> } | undefined {
  let found: { path: IssuePath; current: Record<string, unknown> } | undefined;
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

function getPath(data: unknown, path: IssuePath): Record<string, unknown> | undefined {
  let value = data;
  for (const key of path) {
    value =
      isRecord(value) || Array.isArray(value)
        ? (value as Record<string | number, unknown>)[key]
        : undefined;
  }
  return isRecord(value) ? value : undefined;
}

// JSON with sorted keys, so that key order does not matter.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

function setField(map: MapToken, key: string, value: unknown, path: IssuePath): void {
  const index = map.items.findIndex((item) => keyOf(item) === key);
  if (index !== -1) checkProps(map.items[index] as Item, path);
  if (value === undefined) {
    if (index !== -1) removeItem(map, index);
  } else if (index === -1) {
    addItem(map, key, value);
  } else {
    setValue(map, index, value, path);
  }
}

// Refuses a field whose anchor or tag is on a line after its key, as in `key:` followed
// by `&anchor value` on the next line. The editor keeps props only on the key line.
function checkProps(item: Item, path: IssuePath): void {
  const sep = item.sep ?? [];
  const newline = sep.findIndex((t) => t.type === "newline");
  const props = newline === -1 ? [] : sep.slice(newline).filter(isProp);
  const tags = sep.filter((t) => t.type === "tag");
  const found = props[0] ?? tags[0];
  if (!found) return;
  const message =
    found.type === "tag"
      ? `Has the explicit tag ${found.source}, which the editor does not support`
      : `Has the anchor ${found.source} on the line after its key, which the editor does not support`;
  throw new ScenarioEditError(`Refusing the edit: ${formatPath(path)}: ${message}`, [
    { path, message, severity: "error" },
  ]);
}

function isProp(token: CST.SourceToken): boolean {
  return token.type === "anchor" || token.type === "tag";
}

function setValue(map: MapToken, index: number, value: unknown, path: IssuePath): void {
  const item = map.items[index] as Item;
  const inFlow = map.type === "flow-collection";
  const token = item.value;
  if (!token) {
    fillEmpty(map, index, value);
    return;
  }
  if (isRecord(value)) {
    if (isMapToken(token)) {
      for (const [k, v] of Object.entries(value)) setField(token, k, v, [...path, k]);
      for (const k of token.items.map(keyOf)) {
        if (k !== undefined && !Object.hasOwn(value, k)) {
          setField(token, k, undefined, [...path, k]);
        }
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

// Fills a key without a value, such as `direction: # comment`. The separator holds the
// anchor, tag, and comment of the key line, then the line break and whatever comes
// before the next key, including its indentation. The props stay before the new value,
// the comment and line break go after it, and the rest moves to the next key.
function fillEmpty(map: MapToken, index: number, value: unknown): void {
  const item = map.items[index] as Item;
  const sep = item.sep ?? [];
  const newline = sep.findIndex((t) => t.type === "newline");
  const head = newline === -1 ? sep : sep.slice(0, newline);
  const [lineBreak, ...rest] = newline === -1 ? [] : sep.slice(newline);
  const props = head.filter(isProp);
  item.sep = [colon(), space(1), ...props.flatMap((t) => [t, space(1)])];
  const end = head.filter((t) => t.type === "comment").flatMap((t) => [space(1), t]);
  if (lineBreak) end.push(lineBreak);
  const next = map.items[index + 1];
  if (next) next.start = [...rest, ...next.start];
  else end.push(...rest);
  item.value = valueToken(value, map.indent, map.type === "flow-collection", end);
}

// The yaml stringifier folds line breaks in double-quoted strings over several lines.
// JSON strings are valid YAML double-quoted scalars and keep the value on one line.
function escapeDoubleQuoted(token: CST.Token, value: unknown): void {
  if (token.type === "double-quoted-scalar" && typeof value === "string") {
    token.source = JSON.stringify(value);
  }
}

// The entry without key or value at the end of a flow map, if any. It holds a trailing
// comma, as in `{ a: 1, }`, or the indentation of a closing brace on its own line.
function flowTail(map: CST.FlowCollection): { tail: Item | undefined; comma: boolean } {
  const last = map.items.at(-1);
  const tail = last && !last.key && !last.sep && !last.value ? last : undefined;
  return { tail, comma: tail?.start.some((t) => t.type === "comma") ?? false };
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
    // The new pair goes before the tail entry. Without a trailing comma, what follows
    // the last value, such as a comment or the line break before the closing brace,
    // moves after the new pair.
    const { tail, comma: trailingComma } = flowTail(map);
    const pairs = tail ? map.items.length - 1 : map.items.length;
    const previous = map.items[pairs - 1];
    const trailing = !trailingComma && previous?.value ? takeTrailing(previous.value) : [];
    map.items.splice(pairs, 0, {
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
  const { tail, comma: trailingComma } = flowTail(map);
  if (index === 0 && next && next !== tail) {
    next.start = next.start.filter((t) => t.type !== "comma");
    if (next.start[0]?.type !== "space") next.start.unshift(...removed.start);
  }
  // When the last pair goes, what followed its value moves to the new last pair.
  const last = map.items[tail ? map.items.length - 2 : map.items.length - 1];
  if ((!next || (next === tail && !trailingComma)) && last?.value && removed.value) {
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
    if (token?.type !== "flow-collection") {
      throw new ScenarioEditError(`Cannot write the value ${JSON.stringify(value)}`);
    }
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

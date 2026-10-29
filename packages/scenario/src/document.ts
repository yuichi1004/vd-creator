import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Document, parseDocument } from "yaml";
import { ScenarioEditError, ScenarioValidationError } from "./errors.js";
import { type Issue, type ValidationResult, validateScenarioData } from "./validate.js";

/** File name of the scenario inside a project folder. */
export const SCENARIO_FILE = "scenario.yaml";

/**
 * A scenario.yaml file as YAML source. Edit helpers such as `updateItem` change the
 * source through the `yaml` CST, so everything outside the edited values, including
 * comments and formatting, is kept byte for byte.
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

  /**
   * Replaces the source. Throws a `ScenarioEditError`, keeping the old source, if the new
   * one is not valid YAML.
   */
  setText(text: string): void {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
      const issues = doc.errors.map((e) => ({
        path: [],
        message: e.message,
        severity: "error" as const,
      }));
      throw new ScenarioEditError(`Invalid YAML: ${doc.errors[0]?.message}`, issues);
    }
    this.#text = text;
    this.#doc = doc;
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

  /** Validates the current content with the same rules as `loadScenario`. */
  validate(): ValidationResult {
    const yamlIssues = this.yamlIssues();
    if (yamlIssues.some((i) => i.severity === "error")) return { issues: yamlIssues };
    let data: unknown;
    try {
      data = this.#doc.toJS();
    } catch (e) {
      // For example an unresolved alias or too many alias expansions.
      const message = e instanceof Error ? e.message : String(e);
      return { issues: [...yamlIssues, { path: [], message, severity: "error" }] };
    }
    const result = validateScenarioData(data);
    return { scenario: result.scenario, issues: [...yamlIssues, ...result.issues] };
  }

  toString(): string {
    return this.#text;
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

/**
 * Writes the document to `<projectDir>/scenario.yaml`, replacing the file atomically.
 * Throws a `ScenarioValidationError`, leaving the file untouched, if the document has
 * errors that `loadScenario` would report.
 */
export async function saveScenario(projectDir: string, doc: ScenarioDocument): Promise<void> {
  const text = doc.text;
  const { issues } = new ScenarioDocument(text).validate();
  if (issues.some((i) => i.severity === "error")) throw new ScenarioValidationError(issues);
  const target = join(projectDir, SCENARIO_FILE);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

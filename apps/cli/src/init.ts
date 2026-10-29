import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SCENARIO_FILE } from "@vd-creator/scenario";

/** Folders that `vd init` creates next to scenario.yaml. */
export const PROJECT_FOLDERS = ["assets", "out"] as const;

/** Thrown when `vd init` refuses to create a project. */
export class InitError extends Error {
  override name = "InitError";
}

/** Path of the JSON Schema shipped with `@vd-creator/scenario`. */
export function scenarioSchemaPath(): string {
  const entry = createRequire(import.meta.url).resolve("@vd-creator/scenario");
  // The entry is <package>/dist/index.js; the schema is <package>/schema/scenario.schema.json.
  return join(dirname(entry), "..", "schema", "scenario.schema.json");
}

/**
 * The scenario.yaml that `vd init` writes: a minimal valid scenario derived from the
 * `@vd-creator/scenario` sample. `schemaRef` goes into the yaml-language-server comment.
 */
export function scenarioTemplate(title: string, schemaRef: string): string {
  // A JSON string is a valid YAML double-quoted scalar, so any title is safe.
  return `# yaml-language-server: $schema=${schemaRef}
# Created by vd init. Run "vd validate" after editing.
version: 1
title: ${JSON.stringify(title)}
publish:
  use: private # private | non-commercial | commercial
speakers:
  - id: narrator # Stable ID, referenced by lines
    name: Narrator
    voice:
      provider: mock # "mock" is always available and costs nothing
      voiceId: narrator
scenes:
  - id: s1 # Every scene, line, and SFX needs an ID, unique in the file
    title: Opening
    items:
      - line: "Once upon a time..."
        id: s1-l1
        speaker: narrator
`;
}

/**
 * How a new scenario.yaml refers to the schema: the absolute location of the installed
 * schema as a file:// URL. Unlike a path relative to the project, it keeps working when
 * the project folder moves on the same machine. If the vd installation moves, or the
 * project is opened on another machine, rerun `vd init` elsewhere or edit the comment.
 * The URL lands only in the user's project, never in this repository.
 */
export function scenarioSchemaUrl(): string {
  return pathToFileURL(scenarioSchemaPath()).href;
}

/** Entries that may already be in the folder that `vd init` fills, such as a fresh git repo. */
export const ALLOWED_EXISTING_ENTRIES: readonly string[] = [
  ".git",
  ".gitignore",
  ".gitattributes",
  ".DS_Store",
];

/**
 * Creates a project folder with a minimal valid scenario.yaml and empty `assets/` and
 * `out/` folders. Throws an `InitError`, naming `dir` as given, if the folder has entries
 * other than `ALLOWED_EXISTING_ENTRIES`. Returns the absolute path of the project folder.
 */
export async function initProject(dir: string): Promise<string> {
  const projectDir = resolve(dir);
  const existing = await readdir(projectDir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    if (e.code === "ENOTDIR") throw new InitError(`${dir} is a file or is inside a file`);
    throw e;
  });
  if (existing.some((name) => !ALLOWED_EXISTING_ENTRIES.includes(name))) {
    throw new InitError(`${dir} is not empty`);
  }

  await mkdir(projectDir, { recursive: true });
  const title = basename(projectDir) || "Untitled";
  // "wx" fails instead of overwriting if another process created the file meanwhile.
  await writeFile(join(projectDir, SCENARIO_FILE), scenarioTemplate(title, scenarioSchemaUrl()), {
    encoding: "utf8",
    flag: "wx",
  });
  for (const folder of PROJECT_FOLDERS) await mkdir(join(projectDir, folder));
  return projectDir;
}

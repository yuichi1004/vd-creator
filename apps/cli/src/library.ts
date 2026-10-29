import { isAbsolute, win32 } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  checkEntry,
  checkLibrary,
  findEntry,
  importEntry,
  initLibrary,
  type Library,
  type LibraryEntry,
  LibraryError,
  type LibraryIssue,
  type LibraryKind,
  readLibrary,
  searchEntries,
  verifyEntry,
} from "@vd-creator/library";
import { IdSchema } from "@vd-creator/scenario";
import type { CliOutput } from "./cli.js";
import { ConfigError, type Env, loadConfig } from "./config/index.js";

export const LIBRARY_USAGE = `Usage: vd library <command> [options]

Commands:
  init <path>       Create a library with the standard Creative Commons licenses
  import <file> --kind sfx|bgm --id <id> --license <license-id>
                    Copy a sound file into the library. It always starts unverified.
                    Nothing is downloaded
    --url <url>       Where the sound was downloaded from
    --site <name>     The site's name
    --author <name>   The sound's author
    --attribution <text>
                      Credit line, required by licenses that require attribution
    --evidence <file> A saved copy of the license terms as seen at download time
    --tags <a,b>      Comma-separated tags
    --title <text>    Title (default: the ID)
  search <words>    List entries whose ID, title, tags, or notes contain every word,
                    with their license and verification status
    --kind sfx|bgm    Only this kind
    --json            Print JSON
  verify <id>       Show the license record and its evidence, then ask a human to
                    confirm it by typing yes. Needs an interactive terminal
    --kind sfx|bgm    The kind, when an sfx and a bgm entry share the ID
    --approve-commercial
                      Also approve conditional or unknown terms for commercial use
  check             Check hashes, licenses, attribution, evidence, and IDs

Options:
  --library <path>  The library (overrides VD_LIBRARY and config.yaml; no default)
  -h, --help        Show this help`;

export const LIBRARY_OPTIONS = [
  "kind",
  "id",
  "license",
  "url",
  "site",
  "author",
  "attribution",
  "evidence",
  "tags",
  "title",
  "json",
  "approve-commercial",
] as const;

type LibraryOptions = Partial<Record<(typeof LIBRARY_OPTIONS)[number], string | boolean>> & {
  library?: string;
};

type Context = { output: CliOutput; env: Env; repoRoot: string };

const SUBCOMMAND_OPTIONS: Partial<Record<string, readonly string[]>> = {
  init: [],
  import: [
    "kind",
    "id",
    "license",
    "url",
    "site",
    "author",
    "attribution",
    "evidence",
    "tags",
    "title",
  ],
  search: ["kind", "json"],
  verify: ["kind", "approve-commercial"],
  check: [],
};

/**
 * For tests only: answers the verify confirmation instead of a human in a terminal. There is
 * no flag, environment variable, or setting that does this.
 */
export const libraryTestHooks: { confirm?: (prompt: string) => Promise<boolean> } = {};

/** Characters that are not printable on one line: controls, formats, and separators. */
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/gu;

/**
 * `text` made safe to print. Library output never shows paths outside the library, even with
 * VD_DEBUG. Metadata is user-controlled, so absolute paths in it are redacted, and characters
 * that are not printable on one line are written as \u{...}. `inputs`, the files the user
 * named, are redacted where library errors embed them if they are absolute, even with spaces;
 * a relative name is shown as typed. HTTP URLs stay readable.
 */
export function safeLibraryText(text: string, inputs: string[] = []): string {
  let result = text;
  const absolute = inputs.filter((input) => isAbsolute(input) || win32.isAbsolute(input));
  for (const input of absolute.sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(input, "[input file]");
  }
  return result
    .replace(
      /https?:\/\/[^\s"'<>]+|(?<![\p{L}\p{N}_./:\\-])(?:[A-Za-z]:[\\/]|\/)[^\s"'<>),;]*/gu,
      (match) => (/^https?:\/\//.test(match) ? match : "[path]"),
    )
    .replace(UNPRINTABLE, (c) => `\\u{${c.codePointAt(0)?.toString(16)}}`);
}

// A YAML parser message quotes the file's lines, so only its start is printed.
function issueMessage(message: string): string {
  return message.startsWith("Invalid YAML") ? "Invalid YAML" : message;
}

function printIssues(issues: LibraryIssue[], output: CliOutput): void {
  for (const issue of issues) {
    output.stderr(`${issue.severity}: ${issue.file}: ${issueMessage(issue.message)}`);
  }
}

function hasErrors(issues: LibraryIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

/** Runs `vd library <args>`. Returns the exit code. */
export async function libraryCommand(
  args: string[],
  options: LibraryOptions,
  context: Context,
): Promise<number> {
  const [command, ...rest] = args;
  const accepted =
    command !== undefined && Object.hasOwn(SUBCOMMAND_OPTIONS, command)
      ? SUBCOMMAND_OPTIONS[command]
      : undefined;
  const given = Object.keys(options).filter((key) => key !== "library" && key !== "help");
  const positionals =
    command === "search" ? rest.length > 0 : rest.length === (command === "check" ? 0 : 1);
  if (
    !accepted ||
    given.some((key) => !accepted.includes(key)) ||
    !positionals ||
    rest.some((value) => value.trim() === "") ||
    (options.kind !== undefined && options.kind !== "sfx" && options.kind !== "bgm") ||
    (command === "import" && (!options.kind || !options.id || !options.license))
  ) {
    context.output.stderr(LIBRARY_USAGE);
    return 2;
  }
  const inputs = command === "import" ? [rest[0] ?? "", String(options.evidence ?? "")] : [];
  const output: CliOutput = {
    stdout: (line) => context.output.stdout(safeLibraryText(line, inputs)),
    stderr: (line) => context.output.stderr(safeLibraryText(line, inputs)),
  };
  try {
    if (command === "init") {
      const library = await initLibrary(rest[0] as string);
      printIssues(library.issues, output);
      output.stdout(
        "Created a sound library. Set --library, VD_LIBRARY, or library in config.yaml to use it",
      );
      return hasErrors(library.issues) ? 1 : 0;
    }
    const config = await loadConfig({
      env: context.env,
      repoRoot: context.repoRoot,
      flags: { library: options.library },
    });
    if (config.userDirEnvSkipped) {
      output.stderr(
        `vd library ${command}: VD_USER_DIR is set, but it is not a folder; skipping it`,
      );
    }
    const root = config.settings.library.value;
    if (!root) {
      output.stderr(
        `vd library ${command}: no library is set; use --library, VD_LIBRARY, or library in config.yaml`,
      );
      return 1;
    }
    const kind = options.kind as LibraryKind | undefined;
    switch (command) {
      case "import":
        return await importCommand(root, rest[0] as string, options, output);
      case "search":
        return await searchCommand(root, rest, options, kind, output, context.output);
      case "verify":
        return await verifyCommand(root, rest[0] as string, options, kind, output);
      default: {
        const issues = await checkLibrary(root);
        printIssues(issues, output);
        if (hasErrors(issues)) return 1;
        output.stdout("Library check passed");
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems)
        output.stderr(`vd library ${command}: config.yaml: ${problem}`);
    } else if (error instanceof LibraryError) {
      output.stderr(`vd library ${command}: ${issueMessage(error.message)}`);
      printIssues(error.issues, output);
    } else {
      // Raw messages hold absolute paths, so only the error code is printed.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const shown = typeof code === "string" && /^E[A-Z]+$/.test(code) ? ` (${code})` : "";
      output.stderr(`vd library ${command}: operation failed${shown}`);
    }
    return 1;
  }
}

async function importCommand(
  root: string,
  file: string,
  options: LibraryOptions,
  output: CliOutput,
): Promise<number> {
  const text = (name: keyof LibraryOptions) => {
    const value = options[name];
    return typeof value === "string" ? value : undefined;
  };
  const result = await importEntry(root, file, {
    kind: options.kind as LibraryKind,
    id: options.id as string,
    license: options.license as string,
    url: text("url"),
    site: text("site"),
    author: text("author"),
    attribution: text("attribution"),
    evidence: text("evidence"),
    title: text("title"),
    tags: text("tags")
      ?.split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ""),
  });
  printIssues(result.issues, output);
  if (hasErrors(result.issues)) {
    output.stdout(`Imported ${result.entry.dir} (unverified), with errors to fix before verifying`);
    return 1;
  }
  output.stdout(
    `Imported ${result.entry.dir} (unverified). A human verifies it with vd library verify`,
  );
  return 0;
}

async function searchCommand(
  root: string,
  words: string[],
  options: LibraryOptions,
  kind: LibraryKind | undefined,
  output: CliOutput,
  raw: CliOutput,
): Promise<number> {
  const entries = await searchEntries(root, words, { kind });
  if (options.json) {
    // Each string is made safe before serialization, and the JSON is printed as is, since
    // escaping it as a whole could break it. IDs, license IDs, and folders are slugs.
    const safe = entries.map((entry) => ({
      ...entry,
      title: safeLibraryText(entry.title),
      tags: entry.tags.map((tag) => safeLibraryText(tag)),
    }));
    raw.stdout(JSON.stringify(safe));
    return 0;
  }
  for (const entry of entries) {
    const status = entry.verified ? "verified" : "unverified";
    const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
    output.stdout(`${entry.dir}: ${entry.title}${tags} (${entry.license}, ${status})`);
  }
  if (entries.length === 0) output.stdout("No matching entries");
  return 0;
}

async function verifyCommand(
  root: string,
  id: string,
  options: LibraryOptions,
  kind: LibraryKind | undefined,
  output: CliOutput,
): Promise<number> {
  if (!IdSchema.safeParse(id).success) {
    output.stderr(`vd library verify: invalid entry ID`);
    return 2;
  }
  const library = await readLibrary(root);
  const found = findEntry(library, id, kind);
  const { entry } = found;
  const { source, license } = entry;
  output.stdout(`Entry: ${found.dir} (${entry.title})`);
  output.stdout(`Source: ${source.type}`);
  if (source.type === "generated") {
    output.stdout(`Provider: ${source.provider}`);
  } else {
    if (source.url) output.stdout(`URL: ${source.url}`);
    if (source.site) output.stdout(`Site: ${source.site}`);
    if (source.author) output.stdout(`Author: ${source.author}`);
    if (source.retrievedAt) output.stdout(`Retrieved: ${source.retrievedAt}`);
  }
  output.stdout(`License: ${license.id}`);
  const terms = library.licenses[license.id];
  if (terms) {
    output.stdout(
      `Terms: ${terms.name}; attribution ${terms.attribution}; commercial use ${terms.commercialUse}; modification ${terms.modification}; share-alike ${terms.shareAlike ? "yes" : "no"}`,
    );
    if (terms.url) output.stdout(`License URL: ${terms.url}`);
    if (terms.conditions) output.stdout(`Conditions: ${terms.conditions}`);
  }
  output.stdout(`Attribution: ${license.attribution ?? "(none)"}`);
  output.stdout(`Evidence: ${license.evidence ?? "(none)"}, in the library folder`);

  // A broken record is refused before a human is asked to confirm it.
  const errors = (await checkEntry(library, found)).filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    printIssues(errors, output);
    output.stderr(`vd library verify: fix these first; ${found.dir} was not verified`);
    return 1;
  }

  const approve = options["approve-commercial"] === true;
  if (approve) output.stdout("This also approves the entry for commercial use.");
  const question = `Did you check this license record against its evidence${approve ? ", and approve commercial use" : ""}? Type yes to confirm: `;
  if (!(await (libraryTestHooks.confirm ?? confirmInTerminal)(question))) {
    output.stdout(`Not confirmed; ${found.dir} was not verified`);
    return 1;
  }
  // Refuse if the record or its license terms changed while the human was checking them.
  // verifyEntry reads entry.yaml once more, so this narrows that window but cannot close it.
  if (!sameEntry(found, library, await readLibrary(root), kind)) {
    output.stderr(
      `vd library verify: ${found.dir} changed meanwhile; it was not verified. Run verify again`,
    );
    return 1;
  }
  const result = await verifyEntry(root, id, { kind, approveCommercial: approve });
  if (!result.verified) {
    output.stderr(`vd library verify: ${result.message ?? `${found.dir} was not verified`}`);
    return 1;
  }
  output.stdout(
    `Verified ${result.entry.dir}${approve ? " and approved it for commercial use" : ""}`,
  );
  return 0;
}

function sameEntry(shown: LibraryEntry, before: Library, after: Library, kind?: LibraryKind) {
  try {
    const now = findEntry(after, shown.entry.id, kind);
    const license = shown.entry.license.id;
    return (
      now.dir === shown.dir &&
      JSON.stringify(now.entry) === JSON.stringify(shown.entry) &&
      JSON.stringify(after.licenses[license]) === JSON.stringify(before.licenses[license])
    );
  } catch (e) {
    if (e instanceof LibraryError) return false;
    throw e;
  }
}

async function confirmInTerminal(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new LibraryError(
      "verify needs a human at an interactive terminal; the entry was not changed",
    );
  }
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await reader.question(prompt)).trim() === "yes";
  } finally {
    reader.close();
  }
}

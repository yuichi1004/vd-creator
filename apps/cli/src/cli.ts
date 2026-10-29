import { parseArgs } from "node:util";
import { SCENARIO_FILE } from "@vd-creator/scenario";
import { InitError, initProject } from "./init.js";
import { formatIssue, validateProject } from "./validate.js";

/** Where the CLI writes its output. Each call writes one line. */
export interface CliOutput {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const USAGE = `Usage: vd <command> [options]

Commands:
  init <dir>        Create a project folder with a minimal scenario.yaml. The folder
                    must not exist or contain only dotfiles, such as .git
  validate [dir]    Check <dir>/scenario.yaml (default: the current folder)

Options:
  -h, --help        Show this help`;

/** Exit codes: 0 success, 1 failure such as validation errors, 2 bad usage. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const consoleOutput: CliOutput = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** Runs the vd command with `args` (without the node and script paths). Returns the exit code. */
export async function run(args: string[], output: CliOutput = consoleOutput): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (e) {
    output.stderr(`vd: ${e instanceof Error ? e.message : String(e)}`);
    output.stderr(USAGE);
    return EXIT_USAGE;
  }
  const [command, ...rest] = parsed.positionals;
  if (parsed.values.help) {
    output.stdout(USAGE);
    return EXIT_OK;
  }
  switch (command) {
    case "init":
      return init(rest, output);
    case "validate":
      return validate(rest, output);
    case undefined:
      output.stderr(USAGE);
      return EXIT_USAGE;
    default:
      output.stderr(`vd: unknown command "${command}"`);
      output.stderr(USAGE);
      return EXIT_USAGE;
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });
}

async function init(args: string[], output: CliOutput): Promise<number> {
  const [dir, ...extra] = args;
  if (dir === undefined || extra.length > 0) {
    output.stderr("Usage: vd init <dir>");
    return EXIT_USAGE;
  }
  try {
    const projectDir = await initProject(dir);
    output.stdout(`Created ${projectDir}`);
    return EXIT_OK;
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    output.stderr(`vd init: ${e.message}`);
    return EXIT_FAILURE;
  }
}

async function validate(args: string[], output: CliOutput): Promise<number> {
  const [dir = ".", ...extra] = args;
  if (extra.length > 0) {
    output.stderr("Usage: vd validate [dir]");
    return EXIT_USAGE;
  }
  let result: Awaited<ReturnType<typeof validateProject>>;
  try {
    result = await validateProject(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") throw e;
    output.stderr(`vd validate: cannot read ${SCENARIO_FILE} in ${dir}`);
    return EXIT_FAILURE;
  }
  for (const issue of result.issues) output.stderr(formatIssue(issue));
  if (!result.ok) return EXIT_FAILURE;
  output.stdout(`${SCENARIO_FILE} is valid`);
  return EXIT_OK;
}

import { parseArgs } from "node:util";
import {
  AssetCache,
  CACHE_FILE,
  CacheFormatError,
  defaultResolvers,
  GenerationError,
  type ItemResult,
  itemLabel,
  planGeneration,
  runGeneration,
  scenarioItems,
} from "@vd-creator/core";
import { providerIds } from "@vd-creator/providers";
import { SCENARIO_FILE, type Scenario } from "@vd-creator/scenario";
import { CleanInterruptedError, CleanRefusedError, cleanProject } from "./clean.js";
import {
  DEFAULT_PROVIDER,
  failureReason,
  formatPlan,
  isPaid,
  plural,
  providersFor,
} from "./generate.js";
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
                    must not exist, or contain only .git, .gitignore, .gitattributes,
                    or .DS_Store
  validate [dir]    Check <dir>/scenario.yaml (default: the current folder)
  generate [dir]    Generate the audio of every line, SFX, and BGM that is not cached.
                    Prints the plan and its estimated cost first
    --provider <id>   mock (default) or elevenlabs. Speakers' providers are ignored
    --only <id,...>   Only these items. A BGM uses its scene's ID
    --dry-run         Print the plan and stop
    --yes             Run a paid provider. Without it, a paid provider stops after the plan
  clean [dir]       Remove files in assets/voice, assets/sfx, and assets/bgm, and cache.json
                    entries, that the scenario no longer uses
    --dry-run         List what would be removed and stop

Options:
  -h, --help        Show this help

Set VD_DEBUG=1 to print stack traces of unexpected errors.`;

/** Exit codes: 0 success, 1 failure such as validation errors, 2 bad usage. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const consoleOutput: CliOutput = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** The Node error code of an error, such as ENOENT or ERR_MODULE_NOT_FOUND. */
function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The errno code, such as ENOENT or EACCES, of a file system error. */
function fsErrorCode(e: unknown): string | undefined {
  const code = errorCode(e);
  return code !== undefined && /^E[A-Z]+$/.test(code) ? code : undefined;
}

/**
 * Runs the vd command with `args` (without the node and script paths). Returns the exit code.
 * Messages name paths as the user typed them. Raw error messages and stacks, which can hold
 * absolute paths, are printed only when `env.VD_DEBUG` is "1".
 */
export async function run(
  args: string[],
  output: CliOutput = consoleOutput,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const debug = (e: unknown) => {
    if (env.VD_DEBUG === "1")
      output.stderr(e instanceof Error ? (e.stack ?? e.message) : String(e));
  };
  try {
    return await dispatch(args, output, debug);
  } catch (e) {
    const code = errorCode(e);
    output.stderr(`vd: unexpected error${code ? ` (${code})` : ""}`);
    debug(e);
    if (env.VD_DEBUG !== "1") output.stderr("Set VD_DEBUG=1 for details.");
    return EXIT_FAILURE;
  }
}

async function dispatch(
  args: string[],
  output: CliOutput,
  debug: (e: unknown) => void,
): Promise<number> {
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
  const allowed =
    command !== undefined && Object.hasOwn(COMMAND_OPTIONS, command)
      ? COMMAND_OPTIONS[command]
      : undefined;
  const unknown = Object.keys(parsed.values).filter(
    (name) => name !== "help" && !allowed?.includes(name),
  );
  if (allowed && unknown.length > 0) {
    output.stderr(`vd ${command}: unknown option --${unknown[0]}`);
    output.stderr(USAGE);
    return EXIT_USAGE;
  }
  switch (command) {
    case "init":
      return init(rest, output, debug);
    case "validate":
      return validate(rest, output, debug);
    case "generate":
      return generate(rest, parsed.values, output, debug);
    case "clean":
      return clean(rest, parsed.values, output, debug);
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
    options: {
      help: { type: "boolean", short: "h" },
      provider: { type: "string" },
      only: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
}

type Options = ReturnType<typeof parse>["values"];

/** The options each command accepts, besides --help. */
const COMMAND_OPTIONS: Partial<Record<string, readonly string[]>> = {
  init: [],
  validate: [],
  generate: ["provider", "only", "dry-run", "yes"],
  clean: ["dry-run"],
};

async function init(
  args: string[],
  output: CliOutput,
  debug: (e: unknown) => void,
): Promise<number> {
  const [dir, ...extra] = args;
  if (!dir || extra.length > 0) {
    output.stderr("Usage: vd init <dir>");
    return EXIT_USAGE;
  }
  try {
    await initProject(dir);
  } catch (e) {
    if (e instanceof InitError) {
      output.stderr(`vd init: ${e.message}`);
      return EXIT_FAILURE;
    }
    const code = fsErrorCode(e);
    if (code === undefined) throw e;
    output.stderr(`vd init: cannot create ${dir}: ${code}`);
    debug(e);
    return EXIT_FAILURE;
  }
  output.stdout(`Created ${dir}`);
  return EXIT_OK;
}

async function validate(
  args: string[],
  output: CliOutput,
  debug: (e: unknown) => void,
): Promise<number> {
  const [dir = ".", ...extra] = args;
  if (extra.length > 0) {
    output.stderr("Usage: vd validate [dir]");
    return EXIT_USAGE;
  }
  let result: Awaited<ReturnType<typeof validateProject>>;
  try {
    result = await validateProject(dir);
  } catch (e) {
    const code = fsErrorCode(e);
    if (code === undefined) throw e;
    output.stderr(`vd validate: cannot read ${SCENARIO_FILE} in ${dir}: ${code}`);
    debug(e);
    return EXIT_FAILURE;
  }
  for (const issue of result.issues) output.stderr(formatIssue(issue));
  if (!result.ok) return EXIT_FAILURE;
  output.stdout(`${SCENARIO_FILE} is valid`);
  return EXIT_OK;
}

const GENERATE_USAGE =
  "Usage: vd generate [dir] [--provider mock|elevenlabs] [--only <id,...>] [--dry-run] [--yes]";

async function generate(
  args: string[],
  options: Options,
  output: CliOutput,
  debug: (e: unknown) => void,
): Promise<number> {
  const [dir = ".", ...extra] = args;
  const providerId = options.provider ?? DEFAULT_PROVIDER;
  const only = options.only?.flatMap((list) => list.split(",")).map((id) => id.trim());
  if (extra.length > 0 || only?.some((id) => id === "")) {
    output.stderr(GENERATE_USAGE);
    return EXIT_USAGE;
  }
  if (!providerIds().includes(providerId)) {
    output.stderr(
      `vd generate: unknown provider "${providerId}"; known providers: ${providerIds().join(", ")}`,
    );
    return EXIT_USAGE;
  }

  const project = await loadProject("generate", dir, output, debug);
  if (typeof project === "number") return project;
  const { scenario, cache } = project;
  if (only) {
    const ids = new Set(scenarioItems(scenario).map((item) => item.id));
    const missing = only.filter((id) => !ids.has(id));
    if (missing.length > 0) {
      output.stderr(
        `vd generate: no item to generate has the ID ${missing.map((id) => JSON.stringify(id)).join(", ")}`,
      );
      return EXIT_FAILURE;
    }
  }

  // Only --yes, outside a dry run, lets a paid provider reach the network.
  const authorized = options.yes === true && options["dry-run"] !== true;
  const providers = providersFor(providerId, authorized);
  const resolvers = defaultResolvers(providers);
  let plan: Awaited<ReturnType<typeof planGeneration>>;
  try {
    plan = await planGeneration(scenario, cache, resolvers, { only });
  } catch (e) {
    if (!(e instanceof GenerationError)) throw e;
    output.stderr(`vd generate: cannot plan ${itemLabel({ kind: e.kind, id: e.itemId })}`);
    debug(e);
    return EXIT_FAILURE;
  }
  for (const line of formatPlan(plan, providerId)) output.stdout(line);

  // The gate: whatever the plan holds, a dry run, or a paid provider without --yes, stops here.
  if (options["dry-run"]) {
    output.stdout("Dry run: nothing was generated.");
    return EXIT_OK;
  }
  if (isPaid(providers) && !authorized) {
    output.stdout(
      `Provider ${providerId} is paid, so nothing was generated. Run again with --yes to generate.`,
    );
    return EXIT_OK;
  }

  // Generation is limited to the items the printed plan showed as to-generate, so that a
  // replan can never add one the user did not see.
  const planned = plan.items.filter((item) => item.status === "to-generate").map((i) => i.id);
  const invalid = plan.items.filter((item) => item.status === "invalid");
  let failed: Extract<ItemResult, { status: "failed" }>[] = [];
  if (planned.length === 0) {
    output.stdout("Nothing to generate.");
  } else {
    const result = await runGeneration(scenario, cache, resolvers, {
      only: planned,
      onItem: (item) => {
        if (item.status === "generated") {
          output.stdout(`Generated ${itemLabel(item)}: assets/${item.file}`);
        }
      },
    });
    const generated = result.items.filter((item) => item.status === "generated").length;
    failed = result.items.filter((item) => item.status === "failed");
    output.stdout(`Generated ${plural(generated, "item")}, ${failed.length} failed`);
  }
  // Only the kind, ID, and a fixed reason are printed: an error message can hold the item's text.
  for (const item of invalid)
    output.stderr(`vd generate: failed ${itemLabel(item)} (invalid request)`);
  for (const item of failed) {
    output.stderr(
      `vd generate: failed ${itemLabel(item)} (${failureReason(item.error, fsErrorCode)})`,
    );
    debug(item.error);
  }
  return invalid.length + failed.length > 0 ? EXIT_FAILURE : EXIT_OK;
}

async function clean(
  args: string[],
  options: Options,
  output: CliOutput,
  debug: (e: unknown) => void,
): Promise<number> {
  const [dir = ".", ...extra] = args;
  if (extra.length > 0) {
    output.stderr("Usage: vd clean [dir] [--dry-run]");
    return EXIT_USAGE;
  }
  const project = await loadProject("clean", dir, output, debug);
  if (typeof project === "number") return project;
  const dryRun = options["dry-run"] === true;
  let result: Awaited<ReturnType<typeof cleanProject>>;
  try {
    result = await cleanProject(project.scenario, project.cache, { dryRun });
  } catch (e) {
    if (e instanceof CleanInterruptedError) {
      output.stderr(`vd clean: stopped cleaning ${dir}: ${e.message}`);
      return EXIT_FAILURE;
    }
    if (e instanceof CleanRefusedError) {
      output.stderr(`vd clean: refusing to clean ${dir}: ${e.message}`);
      return EXIT_FAILURE;
    }
    const code = fsErrorCode(e);
    if (code === undefined) throw e;
    output.stderr(`vd clean: cannot clean the assets in ${dir}: ${code}`);
    debug(e);
    return EXIT_FAILURE;
  }
  const verb = dryRun ? "Would remove" : "Removed";
  for (const file of result.files) output.stdout(`${verb} assets/${file}`);
  output.stdout(
    `${verb} ${plural(result.files.length, "file")} and ${result.keys.length} cache ${result.keys.length === 1 ? "entry" : "entries"}`,
  );
  return EXIT_OK;
}

/**
 * Loads and validates the scenario of a project, like vd validate, and its cache. Prints the
 * problems and returns an exit code if either cannot be used.
 */
async function loadProject(
  command: string,
  dir: string,
  output: CliOutput,
  debug: (e: unknown) => void,
): Promise<{ scenario: Scenario; cache: AssetCache } | number> {
  let result: Awaited<ReturnType<typeof validateProject>>;
  try {
    result = await validateProject(dir);
  } catch (e) {
    const code = fsErrorCode(e);
    if (code === undefined) throw e;
    output.stderr(`vd ${command}: cannot read ${SCENARIO_FILE} in ${dir}: ${code}`);
    debug(e);
    return EXIT_FAILURE;
  }
  for (const issue of result.issues) output.stderr(formatIssue(issue));
  if (!result.ok || !result.scenario) return EXIT_FAILURE;
  try {
    return { scenario: result.scenario, cache: await AssetCache.load(dir) };
  } catch (e) {
    if (e instanceof CacheFormatError) {
      output.stderr(`vd ${command}: ${CACHE_FILE} in ${dir} is not a valid cache`);
    } else {
      const code = fsErrorCode(e);
      if (code === undefined) throw e;
      output.stderr(`vd ${command}: cannot read ${CACHE_FILE} in ${dir}: ${code}`);
    }
    debug(e);
    return EXIT_FAILURE;
  }
}

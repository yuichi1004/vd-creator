import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AssetCache,
  CACHE_FILE,
  CacheFormatError,
  checkLibraryLicenses,
  defaultResolvers,
  GenerationError,
  type ItemResult,
  itemLabel,
  libraryResolver,
  type ProjectLicenseIssue,
  planGeneration,
  runGeneration,
  scenarioItems,
} from "@vd-creator/core";
import { providerIds } from "@vd-creator/providers";
import { SCENARIO_FILE, type Scenario } from "@vd-creator/scenario";
import {
  DEFAULT_HOST,
  type RunningServer,
  type StartServerOptions,
  startServer,
} from "@vd-creator/server";
import { CleanInterruptedError, CleanRefusedError, cleanProject } from "./clean.js";
import {
  CONFIG_ENV_VARS,
  ConfigError,
  ConfigInitError,
  describeRule,
  type EffectiveConfig,
  type Env,
  findUserDir,
  initUserDir,
  LOCAL_DIR,
  loadConfig,
  REPO_ROOT,
  SETTINGS,
  type SettingName,
  type SettingSource,
} from "./config/index.js";
import {
  DEFAULT_PROVIDER,
  failureReason,
  formatPlan,
  isPaid,
  plural,
  providersFor,
} from "./generate.js";
import { InitError, initProject } from "./init.js";
import { LIBRARY_OPTIONS, LIBRARY_USAGE, libraryCommand, safeLibraryText } from "./library.js";
import {
  aborted,
  DEFAULT_SERVE_PORT,
  listenAddresses,
  listenHost,
  NETWORK_WARNING,
  parsePort,
  SERVE_USAGE,
  stopSignal,
  tokenUrls,
  WEB_DIR,
  webBuilt,
} from "./serve.js";
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
  validate [dir]    Check <dir>/scenario.yaml (default: the current folder), and the
                    licenses of its library sounds and providers against publish.use
  generate [dir]    Generate the audio of every line, SFX, and BGM that is not cached, and
                    copy library sounds into assets/library/, recorded in credits.json.
                    Prints the plan and its estimated cost first
    --provider <id>   mock (default) or elevenlabs. Speakers' providers are ignored
    --only <id,...>   Only these items. A BGM uses its scene's ID
    --dry-run         Print the plan and stop
    --yes             Run a paid provider. Without it, a paid provider stops after the plan
  clean [dir]       Remove files in assets/voice, assets/sfx, and assets/bgm, and cache.json
                    entries, that the scenario no longer uses. assets/library/ is kept
    --dry-run         List what would be removed and stop
  config path       Print the user directory and the rule that selected it: VD_USER_DIR,
                    local/ at the repository root, or vd-creator/ in XDG_CONFIG_HOME
                    (default: ~/.config). The first that exists is used
  config init       Create the user directory with config.yaml, AGENTS.md, and docs/.
                    Keeps files that exist
    --dir <path>      Where to create it (default: local/ at the repository root). A
                      folder inside the repository must be local/
  config show       Print each setting of config.yaml and where its value comes from
    --json            Print JSON
  library           Manage the shared sound library (vd library --help for commands)
  serve [dir]       Serve the review UI for the project in <dir> (default: the current
                    folder) and print its URL. Stop with Ctrl+C
    --port <n>        Port (default: 5310; 0 picks a free one)
    --provider <id>   mock (default) or elevenlabs. With a paid provider, the UI asks to
                      confirm each generation with its estimated characters
    --host <addr>     Listen on <addr>, such as 0.0.0.0, instead of 127.0.0.1. Every request
                      then needs a token, printed in the URLs. Anyone on the network with a
                      URL can edit the project; Tailscale is the recommended way instead
    --allow-host <name>
                      Also accept this Host header name, such as a reverse proxy's
                      (repeatable). Not needed with --host, where the token is checked
    --library <path>  Show the library panel for this library, and copy library sounds
                      the project has not copied yet when they are generated

Options:
  -h, --help        Show this help
  --library <path>  Sound library (overrides VD_LIBRARY and config.yaml)

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

export type RunOptions = {
  /** The repository whose `local/` is a user directory candidate. Defaults to `REPO_ROOT`. */
  repoRoot?: string;
  /** Stops a command that runs until stopped, such as vd serve. Defaults to SIGINT or SIGTERM. */
  signal?: AbortSignal;
  /** The built web UI that vd serve serves. Defaults to `WEB_DIR`. */
  webDir?: string;
};

/** What a command needs besides its arguments. */
type Context = {
  output: CliOutput;
  debug: (e: unknown) => void;
  env: Env;
  repoRoot: string;
  library?: string;
  signal?: AbortSignal;
  webDir: string;
};

/**
 * Runs the vd command with `args` (without the node and script paths). Returns the exit code.
 * Messages name paths as the user typed them. Raw error messages and stacks, which can hold
 * absolute paths, are printed only when `env.VD_DEBUG` is "1". The user directory and the home
 * folder are found from `env` only.
 */
export async function run(
  args: string[],
  output: CliOutput = consoleOutput,
  env: Env = process.env,
  options: RunOptions = {},
): Promise<number> {
  const debug = (e: unknown) => {
    if (env.VD_DEBUG !== "1") return;
    // Print the chain of causes too, such as the file system error behind a clean error.
    for (let error = e, depth = 0; error !== undefined && depth < 5; depth++) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      output.stderr(depth === 0 ? text : `Caused by: ${text}`);
      error = error instanceof Error ? error.cause : undefined;
    }
  };
  const context: Context = {
    output,
    debug,
    env,
    repoRoot: options.repoRoot ?? REPO_ROOT,
    webDir: options.webDir ?? WEB_DIR,
  };
  if (options.signal !== undefined) context.signal = options.signal;
  try {
    return await dispatch(args, context);
  } catch (e) {
    const code = errorCode(e);
    output.stderr(`vd: unexpected error${code ? ` (${code})` : ""}`);
    debug(e);
    if (env.VD_DEBUG !== "1") output.stderr("Set VD_DEBUG=1 for details.");
    return EXIT_FAILURE;
  }
}

async function dispatch(args: string[], context: Context): Promise<number> {
  const { output } = context;
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    output.stderr(`vd: ${args.includes("library") ? safeLibraryText(message) : message}`);
    output.stderr(USAGE);
    return EXIT_USAGE;
  }
  const [command, ...rest] = parsed.positionals;
  context.library = parsed.values.library;
  if (parsed.values.help) {
    output.stdout(command === "library" ? LIBRARY_USAGE : USAGE);
    return EXIT_OK;
  }
  const allowed =
    command !== undefined && Object.hasOwn(COMMAND_OPTIONS, command)
      ? COMMAND_OPTIONS[command]
      : undefined;
  const unknown = Object.keys(parsed.values).filter(
    (name) => name !== "help" && name !== "library" && !allowed?.includes(name),
  );
  if (allowed && unknown.length > 0) {
    output.stderr(`vd ${command}: unknown option --${unknown[0]}`);
    output.stderr(USAGE);
    return EXIT_USAGE;
  }
  switch (command) {
    case "init":
      return init(rest, context);
    case "validate":
      return validate(rest, context);
    case "generate":
      return generate(rest, parsed.values, context);
    case "clean":
      return clean(rest, parsed.values, context);
    case "config":
      return config(rest, parsed.values, context);
    case "library":
      return libraryCommand(rest, parsed.values, context);
    case "serve":
      return serve(rest, parsed.values, context);
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
      dir: { type: "string" },
      json: { type: "boolean" },
      library: { type: "string" },
      item: { type: "string" },
      kind: { type: "string" },
      id: { type: "string" },
      license: { type: "string" },
      url: { type: "string" },
      site: { type: "string" },
      author: { type: "string" },
      attribution: { type: "string" },
      evidence: { type: "string" },
      tags: { type: "string" },
      title: { type: "string" },
      "approve-commercial": { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      "allow-host": { type: "string", multiple: true },
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
  // Each subcommand checks which of these it takes.
  config: ["dir", "json"],
  library: LIBRARY_OPTIONS,
  serve: ["port", "provider", "host", "allow-host"],
};

async function init(args: string[], context: Context): Promise<number> {
  const { output, debug } = context;
  const [dir, ...extra] = args;
  if (!dir || extra.length > 0) {
    output.stderr("Usage: vd init <dir>");
    return EXIT_USAGE;
  }
  const config = await loadUserConfig("init", context);
  if (typeof config === "number") return config;
  try {
    await initProject(dir, { publishUse: config.settings["init.publishUse"].value });
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

async function validate(args: string[], context: Context): Promise<number> {
  const { output, debug } = context;
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
  if (!result.ok || !result.scenario) return EXIT_FAILURE;

  const config = await loadUserConfig("validate", context);
  if (typeof config === "number") return config;
  const library = libraryRoot(config);
  let licenses: ProjectLicenseIssue[];
  try {
    licenses = await checkLibraryLicenses(dir, result.scenario, { library });
  } catch (e) {
    const code = fsErrorCode(e);
    if (code === undefined) throw e;
    output.stderr(`vd validate: cannot check the licenses in ${dir}: ${code}`);
    debug(e);
    return EXIT_FAILURE;
  }
  for (const issue of licenses) output.stderr(formatLicenseIssue(issue));
  if (licenses.some((issue) => issue.severity === "error")) return EXIT_FAILURE;
  output.stdout(`${SCENARIO_FILE} is valid`);
  return EXIT_OK;
}

/** Formats a license issue like a scenario issue, with `licenses` as its path. */
function formatLicenseIssue(issue: ProjectLicenseIssue): string {
  const suffix = issue.severity === "warning" ? " (warning)" : "";
  return `licenses: ${safeLibraryText(issue.message)}${suffix}`;
}

/** The library root of a config, absolute, or `undefined` if none is set. */
function libraryRoot(config: EffectiveConfig): string | undefined {
  const library = config.settings.library.value;
  return library === undefined ? undefined : resolve(library);
}

const GENERATE_USAGE =
  "Usage: vd generate [dir] [--provider mock|elevenlabs] [--only <id,...>] [--dry-run] [--yes]";

async function generate(args: string[], options: Options, context: Context): Promise<number> {
  const { output, debug } = context;
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
  const config = await loadUserConfig("generate", context);
  if (typeof config === "number") return config;
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
  const resolvers = [libraryResolver(libraryRoot(config)), ...defaultResolvers(providers)];
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
  // An item is unresolved when the library resolver cannot copy it or no resolver handles it.
  // Library reasons can quote user-written metadata, so they are made safe to print.
  const unresolved = plan.items.filter((item) => item.status === "unresolved");
  for (const item of unresolved) {
    if (item.status === "unresolved") {
      output.stderr(`vd generate: unresolved ${itemLabel(item)}: ${safeLibraryText(item.reason)}`);
    }
  }

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
          const verb = item.resolver === "library" ? "Copied" : "Generated";
          output.stdout(`${verb} ${itemLabel(item)}: assets/${item.file}`);
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
      `vd generate: failed ${itemLabel(item)} (${safeLibraryText(failureReason(item.error, fsErrorCode))})`,
    );
    debug(item.error);
  }
  return invalid.length + failed.length + unresolved.length > 0 ? EXIT_FAILURE : EXIT_OK;
}

async function clean(args: string[], options: Options, context: Context): Promise<number> {
  const { output, debug } = context;
  const [dir = ".", ...extra] = args;
  if (extra.length > 0) {
    output.stderr("Usage: vd clean [dir] [--dry-run]");
    return EXIT_USAGE;
  }
  const project = await loadProject("clean", dir, output, debug);
  if (typeof project === "number") return project;
  // Library copies in assets/library/ are never cleaned, so the library itself is not read;
  // the config is still loaded so that a broken config.yaml is reported like elsewhere.
  const config = await loadUserConfig("clean", context);
  if (typeof config === "number") return config;
  const dryRun = options["dry-run"] === true;
  let result: Awaited<ReturnType<typeof cleanProject>>;
  try {
    result = await cleanProject(project.scenario, project.cache, { dryRun });
  } catch (e) {
    if (e instanceof CleanInterruptedError) {
      output.stderr(`vd clean: stopped cleaning ${dir}: ${e.message}`);
      debug(e);
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

async function serve(args: string[], options: Options, context: Context): Promise<number> {
  const { output, debug } = context;
  const [dir = ".", ...extra] = args;
  const providerId = options.provider ?? DEFAULT_PROVIDER;
  const port = options.port === undefined ? DEFAULT_SERVE_PORT : parsePort(options.port);
  const allowedHosts = options["allow-host"];
  if (
    extra.length > 0 ||
    port === undefined ||
    options.host === "" ||
    allowedHosts?.some((name) => name === "")
  ) {
    output.stderr(SERVE_USAGE);
    return EXIT_USAGE;
  }
  if (!providerIds().includes(providerId)) {
    output.stderr(
      `vd serve: unknown provider "${providerId}"; known providers: ${providerIds().join(", ")}`,
    );
    return EXIT_USAGE;
  }
  if (!existsSync(join(dir, SCENARIO_FILE))) {
    output.stderr(`vd serve: no ${SCENARIO_FILE} in ${dir}`);
    return EXIT_FAILURE;
  }
  const config = await loadUserConfig("serve", context);
  if (typeof config === "number") return config;

  // The server itself asks the UI to confirm every paid generation, so the provider is not
  // gated here. A paid provider is only used when chosen with --provider.
  const provider = providersFor(providerId, true);
  const serverOptions: StartServerOptions = { projectDir: resolve(dir), provider, port };
  const host = options.host === undefined ? undefined : listenHost(options.host);
  if (host !== undefined) serverOptions.host = host;
  if (allowedHosts !== undefined) serverOptions.allowedHosts = allowedHosts;
  const library = libraryRoot(config);
  if (library !== undefined) serverOptions.library = library;
  // The server puts these before its generated-item resolver.
  serverOptions.resolvers = [libraryResolver(library)];
  if (webBuilt(context.webDir)) {
    serverOptions.webDir = context.webDir;
  } else {
    output.stderr(
      "vd serve: the web UI is not built, so only the API is served; run npm run build",
    );
  }

  const stop = stopSignal(context.signal);
  try {
    let running: RunningServer;
    try {
      running = await startServer(serverOptions);
    } catch (e) {
      const code = errorCode(e);
      if (code === undefined) throw e;
      const shown = `${options.host ?? DEFAULT_HOST}:${port}`;
      output.stderr(`vd serve: cannot listen on ${shown}: ${code}`);
      debug(e);
      return EXIT_FAILURE;
    }
    if (running.token === undefined) {
      output.stdout(`Serving ${dir} at ${running.url}`);
    } else {
      output.stdout(`Serving ${dir}. Open one of these URLs:`);
      const addresses = listenAddresses(host ?? DEFAULT_HOST);
      for (const url of tokenUrls(addresses, running.port, running.token)) {
        output.stdout(`  ${url}`);
      }
      for (const line of NETWORK_WARNING) output.stderr(line);
    }
    if (isPaid(provider)) {
      output.stdout(
        `Provider ${providerId} is paid: the UI shows the estimated characters and asks to confirm each generation.`,
      );
    }
    output.stdout("Press Ctrl+C to stop.");
    await aborted(stop.signal);
    await running.close();
    output.stdout("Stopped.");
    return EXIT_OK;
  } finally {
    stop.dispose();
  }
}

const CONFIG_USAGE =
  "Usage: vd config path | vd config init [--dir <path>] | vd config show [--json]";

async function config(args: string[], options: Options, context: Context): Promise<number> {
  const { output } = context;
  const [subcommand, ...extra] = args;
  const allowed: Partial<Record<string, readonly string[]>> = {
    path: [],
    init: ["dir"],
    show: ["json"],
  };
  const accepted =
    subcommand !== undefined && Object.hasOwn(allowed, subcommand)
      ? allowed[subcommand]
      : undefined;
  const given = Object.keys(options).filter((name) => name !== "help" && name !== "library");
  if (!accepted || extra.length > 0 || given.some((name) => !accepted.includes(name))) {
    output.stderr(CONFIG_USAGE);
    return EXIT_USAGE;
  }
  switch (subcommand) {
    case "path":
      return configPath(context);
    case "init":
      return configInit(options.dir, context);
    default:
      return configShow(options.json === true, context);
  }
}

async function configPath(context: Context): Promise<number> {
  const { output, env, repoRoot } = context;
  const search = await findUserDir({ env, repoRoot });
  if (search.userDirEnvSkipped) {
    output.stderr("vd config path: VD_USER_DIR is set, but it is not a folder; skipping it");
  }
  if (!search.found) {
    output.stdout("No user directory; vd uses its built-in defaults. Checked, in order:");
    for (const candidate of search.candidates) output.stdout(`  ${printable(candidate.dir)}`);
    return EXIT_OK;
  }
  output.stdout(printable(search.found.dir));
  output.stdout(`Selected by ${describeRule(search.found.rule)}`);
  return EXIT_OK;
}

async function configInit(dir: string | undefined, context: Context): Promise<number> {
  const { output, debug, env, repoRoot } = context;
  if (dir === "") {
    output.stderr(CONFIG_USAGE);
    return EXIT_USAGE;
  }
  let result: Awaited<ReturnType<typeof initUserDir>>;
  try {
    result = await initUserDir(dir, { repoRoot });
  } catch (e) {
    if (e instanceof ConfigInitError) {
      output.stderr(`vd config init: ${e.message}`);
      return EXIT_FAILURE;
    }
    const code = fsErrorCode(e);
    if (code === undefined) throw e;
    output.stderr(`vd config init: cannot create ${dir ?? `${LOCAL_DIR}/`}: ${code}`);
    debug(e);
    return EXIT_FAILURE;
  }
  const shown = dir ?? result.dir;
  output.stdout(
    result.created.length > 0
      ? `Created ${result.created.join(", ")} in ${shown}`
      : `Nothing to create: ${shown} already has config.yaml, AGENTS.md, and docs/`,
  );
  const { found } = await findUserDir({ env, repoRoot });
  if (found && found.dir !== result.dir) {
    output.stderr(
      `vd config init: note: vd uses ${found.dir}, selected by ${describeRule(found.rule)}, not this folder`,
    );
  }
  return EXIT_OK;
}

async function configShow(json: boolean, context: Context): Promise<number> {
  const { output } = context;
  const config = await loadUserConfig("config show", context);
  if (typeof config === "number") return config;
  if (json) {
    const settings = Object.fromEntries(
      SETTINGS.map((name) => {
        const { value, source } = config.settings[name];
        const envName = source === "env" ? { env: CONFIG_ENV_VARS[name] } : {};
        return [name, { value: value ?? null, source, ...envName }];
      }),
    );
    const userDir = config.userDir ?? null;
    output.stdout(printableJson({ userDir, configFile: config.file ?? null, settings }));
    return EXIT_OK;
  }
  output.stdout(
    config.userDir
      ? `User directory: ${printable(config.userDir.dir)} (${describeRule(config.userDir.rule)})`
      : "User directory: none",
  );
  output.stdout(`Config file: ${printable(config.file ?? "none")}`);
  for (const name of SETTINGS) {
    const { value, source } = config.settings[name];
    const shown = value === undefined ? "(not set)" : printable(String(value));
    output.stdout(`${name}: ${shown} (${sourceLabel(name, source)})`);
  }
  return EXIT_OK;
}

/** Characters that are not printable on one line: controls, formats, and separators. */
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/gu;

/**
 * `text` with every character that is not printable on one line written as \u{...}. Settings
 * that passed the schema have none, but a folder from the environment, such as HOME, can.
 */
function printable(text: string): string {
  return text.replace(UNPRINTABLE, (c) => `\\u{${c.codePointAt(0)?.toString(16)}}`);
}

/**
 * Indented JSON with every character in a string that is not printable on one line escaped as
 * \uXXXX. JSON.stringify escapes U+0000 to U+001F in strings itself, so those left in its
 * output are the newlines and indentation between values.
 */
function printableJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(UNPRINTABLE, (c) =>
    c.length === 1 && c.charCodeAt(0) < 0x20
      ? c
      : [...Array(c.length).keys()]
          .map((i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`)
          .join(""),
  );
}

function sourceLabel(name: SettingName, source: SettingSource): string {
  switch (source) {
    case "flag":
      return "command-line flag";
    case "env":
      return `environment variable ${CONFIG_ENV_VARS[name]}`;
    case "file":
      return "config.yaml";
    case "default":
      return "default";
  }
}

/**
 * Loads the user config for `command`. Prints the problems and returns an exit code if it
 * cannot be used.
 */
async function loadUserConfig(
  command: string,
  context: Context,
): Promise<EffectiveConfig | number> {
  const { output, debug, env, repoRoot } = context;
  try {
    const config = await loadConfig({ env, repoRoot, flags: { library: context.library } });
    if (config.userDirEnvSkipped) {
      output.stderr(`vd ${command}: VD_USER_DIR is set, but it is not a folder; skipping it`);
    }
    return config;
  } catch (e) {
    if (e instanceof ConfigError) {
      for (const problem of e.problems) output.stderr(`vd ${command}: ${e.file}: ${problem}`);
      return EXIT_FAILURE;
    }
    const code = fsErrorCode(e);
    if (code === undefined) throw e;
    output.stderr(`vd ${command}: cannot read the user config: ${code}`);
    debug(e);
    return EXIT_FAILURE;
  }
}

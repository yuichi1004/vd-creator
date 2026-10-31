// Loading config.yaml and resolving each setting by precedence: command-line flag, then
// environment variable, then config.yaml, then the built-in default.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { PUBLISH_USES, type PublishUse } from "@vd-creator/scenario";
import { isAlias, isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import {
  type Env,
  findUserDir,
  homeDir,
  type LocationOptions,
  type UserDirLocation,
} from "./location.js";
import {
  AGENT_COMMANDS,
  AGENT_TIMEOUT_DEFAULT,
  AGENT_TIMEOUT_MAX,
  AGENT_TIMEOUT_MIN,
  type AgentCommand,
  CONFIG_FILE,
  HostSchema,
  MAX_PATH_LENGTH,
  PathSchema,
  PortSchema,
  type UserConfig,
  UserConfigSchema,
} from "./schema.js";

/** The settings, named by their dotted path in config.yaml, in the order they are shown. */
export const SETTINGS = [
  "library",
  "serve.port",
  "serve.host",
  "init.publishUse",
  "agent.command",
  "agent.timeoutSec",
  "render.creditsTemplate",
] as const;

export type SettingName = (typeof SETTINGS)[number];

/** The type of each setting's value. A path is absolute once resolved. */
export type ConfigValues = {
  /** The sound library folder. Undefined means library features are off. */
  library: string | undefined;
  "serve.port": number;
  "serve.host": string;
  "init.publishUse": PublishUse;
  /** The agent that answers instructions. Undefined means there is no agent. */
  "agent.command": AgentCommand | undefined;
  "agent.timeoutSec": number;
  /** The credits template file. Undefined means render's built-in template. */
  "render.creditsTemplate": string | undefined;
};

/** The built-in defaults. */
export const CONFIG_DEFAULTS: ConfigValues = {
  library: undefined,
  "serve.port": 5310,
  "serve.host": "127.0.0.1",
  "init.publishUse": "private",
  "agent.command": undefined,
  "agent.timeoutSec": AGENT_TIMEOUT_DEFAULT,
  "render.creditsTemplate": undefined,
};

/** The environment variable of each setting that has one. */
export const CONFIG_ENV_VARS: Partial<Record<SettingName, string>> = { library: "VD_LIBRARY" };

/** The settings whose value is a path, with `~` expanded and a relative path resolved. */
const PATH_SETTINGS: ReadonlySet<SettingName> = new Set(["library", "render.creditsTemplate"]);

export type SettingSource = "flag" | "env" | "file" | "default";

export type Setting<T> = { value: T; source: SettingSource };

export type EffectiveSettings = { [K in SettingName]: Setting<ConfigValues[K]> };

/**
 * Values that a command's flags set, as typed. A command passes only the flags it has. A path
 * is resolved against `cwd`.
 */
export type ConfigFlags = { [K in SettingName]?: ConfigValues[K] };

export type EffectiveConfig = {
  /** The user directory, or undefined if none exists. */
  userDir: UserDirLocation | undefined;
  /** True if `VD_USER_DIR` is set but is not a folder, so it was skipped. */
  userDirEnvSkipped: boolean;
  /** The config file that was read, or undefined if there is none. */
  file: string | undefined;
  settings: EffectiveSettings;
};

export type LoadConfigOptions = LocationOptions & {
  flags?: ConfigFlags;
  /** The folder that a relative path in a flag or environment variable is relative to. */
  cwd?: string;
};

/**
 * Thrown when config.yaml cannot be used. Each problem names a key or a line, never a value,
 * so that a pasted secret is not printed.
 */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`${file} is not a valid config: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Finds the user directory, reads its config.yaml if there is one, and resolves every setting.
 * Without a user directory or config.yaml, the settings come from flags, the environment, and
 * the defaults. Throws a `ConfigError` if config.yaml is invalid, and a file system error if it
 * cannot be read.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<EffectiveConfig> {
  const search = await findUserDir(options);
  const userDir = search.found;
  const file = userDir ? join(userDir.dir, CONFIG_FILE) : undefined;
  const config = file ? await readUserConfig(file) : undefined;
  const settings = resolveSettings({
    ...options,
    file: config && userDir && file ? { config, dir: userDir.dir, path: file } : undefined,
  });
  return {
    userDir,
    userDirEnvSkipped: search.userDirEnvSkipped,
    file: config ? file : undefined,
    settings,
  };
}

/**
 * Reads and checks a config file. Returns undefined if it does not exist. An empty file has no
 * settings. Throws a `ConfigError` if it is not valid YAML or does not match the schema.
 */
export async function readUserConfig(file: string): Promise<UserConfig | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  return parseUserConfig(text, file);
}

/**
 * What each key path of the schema must hold. A problem names only these paths and this fixed
 * text, never a key or value from the file, so that a pasted secret is not printed.
 */
const PATH_RULE = `must be a path on one line of printable characters, at most ${MAX_PATH_LENGTH} long`;
// A Map, so that a key such as "constructor" or "__proto__" is not found on a prototype.
const KEY_RULES: ReadonlyMap<string, string> = new Map([
  ["", "must be a mapping of settings"],
  ["version", "must be 1"],
  ["library", PATH_RULE],
  ["serve", "must be a mapping"],
  ["serve.port", "must be a whole number from 1 to 65535"],
  ["serve.host", "must be a host name or an IPv4 or IPv6 address"],
  ["init", "must be a mapping"],
  ["init.publishUse", `must be one of ${PUBLISH_USES.join(", ")}`],
  ["agent", "must be a mapping"],
  [
    "agent.command",
    `must be one of ${AGENT_COMMANDS.join(", ")} (codex is not supported: it cannot run without command execution)`,
  ],
  ["agent.timeoutSec", `must be a whole number from ${AGENT_TIMEOUT_MIN} to ${AGENT_TIMEOUT_MAX}`],
  ["render", "must be a mapping"],
  ["render.creditsTemplate", PATH_RULE],
]);

/** The schema of each setting, which a value from a flag or the environment must pass too. */
const SETTING_SCHEMAS: ReadonlyMap<SettingName, z.ZodType> = new Map<SettingName, z.ZodType>([
  ["library", PathSchema],
  ["serve.port", PortSchema],
  ["serve.host", HostSchema],
  ["init.publishUse", z.enum(PUBLISH_USES)],
  ["agent.command", z.enum(AGENT_COMMANDS)],
  ["agent.timeoutSec", z.number().int().min(AGENT_TIMEOUT_MIN).max(AGENT_TIMEOUT_MAX)],
  ["render.creditsTemplate", PathSchema],
]);

/**
 * Parses the text of a config file. `file` names it in errors.
 *
 * No text, key, or value from the file reaches an error, a process warning, or the cause of an
 * error: problems name a line, a key path of the schema, and fixed text. The YAML is checked
 * node by node and converted by hand, never with `toJS`, which can emit process warnings that
 * quote the source. Aliases, anchors, tags, and keys that are not plain scalars are rejected.
 */
export function parseUserConfig(text: string, file: string): UserConfig {
  let result: { config: UserConfig } | { problems: string[] };
  try {
    result = checkUserConfig(text);
  } catch {
    // An unexpected failure could quote the source, so it is replaced, without a cause.
    result = { problems: ["could not be read as YAML"] };
  }
  if ("problems" in result) throw new ConfigError(file, result.problems);
  return result.config;
}

function checkUserConfig(text: string): { config: UserConfig } | { problems: string[] } {
  const lineCounter = new LineCounter();
  // "silent" keeps the library from writing warnings; they are collected in doc.warnings.
  const doc = parseDocument(text, { lineCounter, logLevel: "silent", prettyErrors: false });
  const lineOf = (offset: number | undefined) =>
    offset === undefined ? "" : ` at line ${lineCounter.linePos(offset).line}`;
  // The messages of YAML errors and warnings quote the source, so only the line.
  const yamlProblems = [
    ...doc.errors.map((error) => `not valid YAML${lineOf(error.pos[0])}`),
    ...doc.warnings.map((warning) => `unsupported YAML${lineOf(warning.pos[0])}`),
  ];
  if (yamlProblems.length > 0) return { problems: yamlProblems };

  const problems: string[] = [];
  // Unknown keys are found here, with their line, so that the schema never sees one.
  const toPlain = (node: unknown, path: string, known: boolean): unknown => {
    if (node === null || node === undefined) return null;
    if (isAlias(node)) {
      problems.push(`aliases are not allowed${lineOf(node.range?.[0])}`);
      return null;
    }
    if (!isNode(node)) {
      problems.push(`unsupported YAML${lineOf(undefined)}`);
      return null;
    }
    const at = lineOf(node.range?.[0]);
    if (node.anchor !== undefined || node.tag !== undefined) {
      problems.push(`anchors and tags are not allowed${at}`);
      return null;
    }
    if (isScalar(node)) return node.value;
    if (isSeq(node)) return node.items.map((item) => toPlain(item, path, false));
    if (!isMap(node)) {
      problems.push(`unsupported YAML${at}`);
      return null;
    }
    const object: Record<string, unknown> = {};
    for (const pair of node.items) {
      const key = pair.key;
      const keyAt = lineOf(isNode(key) ? key.range?.[0] : node.range?.[0]);
      if (
        !isScalar(key) ||
        key.anchor !== undefined ||
        key.tag !== undefined ||
        (typeof key.value !== "string" && typeof key.value !== "number")
      ) {
        problems.push(`keys must be plain text${keyAt}`);
        continue;
      }
      const name = String(key.value);
      const child = path ? `${path}.${name}` : name;
      // A key is checked only inside a mapping of the schema.
      if (known && !KEY_RULES.has(child)) {
        problems.push(`unknown key${path ? ` in ${path}` : ""}${keyAt}`);
        continue;
      }
      // defineProperty, because assigning "__proto__" would replace the prototype.
      Object.defineProperty(object, name, {
        value: toPlain(pair.value, child, known && KEY_RULES.has(child)),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return object;
  };
  const data = doc.contents === null ? { version: 1 } : toPlain(doc.contents, "", true);
  if (problems.length > 0) return { problems };

  const result = UserConfigSchema.safeParse(data);
  if (result.success) return { config: result.data };
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    // Every path is a key of the schema, as unknown keys were rejected above; anything else is
    // not named.
    const rule = KEY_RULES.get(path);
    if (rule === undefined) return "a setting is not valid";
    return `${path || "the top level"}: ${rule}`;
  });
  return { problems: [...new Set(issues)] };
}

/**
 * Resolves every setting from `flags`, then `env`, then the config file, then the default.
 * A path from the file is relative to the user directory; one from a flag or the environment is
 * relative to `cwd`. `~` at the start of a path is the home folder from `env`.
 */
export function resolveSettings(options: {
  env: Env;
  flags?: ConfigFlags;
  cwd?: string;
  file?: { config: UserConfig; dir: string; path: string };
}): EffectiveSettings {
  const { env, flags = {}, cwd = process.cwd(), file } = options;
  const fromFile = file ? fileValues(file.config) : {};
  const settings: Partial<Record<SettingName, Setting<unknown>>> = {};
  const problems: string[] = [];
  for (const name of SETTINGS) {
    const envName = CONFIG_ENV_VARS[name];
    const envValue = envName ? env[envName] || undefined : undefined;
    let setting: Setting<unknown>;
    let base = cwd;
    if (flags[name] !== undefined) setting = { value: flags[name], source: "flag" };
    else if (envValue !== undefined) setting = { value: envValue, source: "env" };
    else if (fromFile[name] !== undefined) {
      setting = { value: fromFile[name], source: "file" };
      base = file?.dir ?? cwd;
    } else setting = { value: CONFIG_DEFAULTS[name], source: "default" };
    // A value from a flag or the environment must pass the same schema as one from the file.
    // The problem names where it came from, never the value.
    if (setting.source === "flag" || setting.source === "env") {
      const schema = SETTING_SCHEMAS.get(name);
      if (schema && !schema.safeParse(setting.value).success) {
        const from = setting.source === "env" ? envName : "the command-line flag";
        problems.push(`${name} from ${from}: ${KEY_RULES.get(name)}`);
        continue;
      }
    }
    if (PATH_SETTINGS.has(name) && typeof setting.value === "string") {
      const path = expandPath(setting.value, base, env);
      if (path === undefined) {
        problems.push(`${name}: cannot expand ~ because HOME is not set`);
        continue;
      }
      setting = { ...setting, value: path };
    }
    settings[name] = setting;
  }
  if (problems.length > 0) throw new ConfigError(file?.path ?? "the configuration", problems);
  return settings as EffectiveSettings;
}

/**
 * Expands `~` or `~/` at the start of `path` to the home folder from `env`, and resolves a
 * relative path against `base`. Returns undefined if the path starts with `~` and there is no
 * home folder.
 */
export function expandPath(path: string, base: string, env: Env): string | undefined {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    const home = homeDir(env);
    return home === undefined ? undefined : join(resolve(home), path.slice(1));
  }
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

/** The values the config file sets, by setting name. */
function fileValues(config: UserConfig): ConfigFlags {
  return {
    library: config.library,
    "serve.port": config.serve?.port,
    "serve.host": config.serve?.host,
    "init.publishUse": config.init?.publishUse,
    "agent.command": config.agent?.command,
    "agent.timeoutSec": config.agent?.timeoutSec,
    "render.creditsTemplate": config.render?.creditsTemplate,
  };
}

// Loading config.yaml and resolving each setting by precedence: command-line flag, then
// environment variable, then config.yaml, then the built-in default.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { PublishUse } from "@vd-creator/scenario";
import { parseDocument } from "yaml";
import {
  type Env,
  findUserDir,
  homeDir,
  type LocationOptions,
  type UserDirLocation,
} from "./location.js";
import { CONFIG_FILE, type UserConfig, UserConfigSchema } from "./schema.js";

/** The settings, named by their dotted path in config.yaml, in the order they are shown. */
export const SETTINGS = [
  "library",
  "serve.port",
  "serve.host",
  "init.publishUse",
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
  /** The credits template file. Undefined means render's built-in template. */
  "render.creditsTemplate": string | undefined;
};

/** The built-in defaults. */
export const CONFIG_DEFAULTS: ConfigValues = {
  library: undefined,
  "serve.port": 5310,
  "serve.host": "127.0.0.1",
  "init.publishUse": "private",
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

/** Parses the text of a config file. `file` names it in errors. */
export function parseUserConfig(text: string, file: string): UserConfig {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    // The YAML error message quotes the source, which could hold a secret, so only the line.
    const problems = doc.errors.map((error) => {
      const line = error.linePos?.[0].line;
      return line === undefined ? "not valid YAML" : `not valid YAML at line ${line}`;
    });
    throw new ConfigError(file, problems);
  }
  const data: unknown = doc.toJS() ?? { version: 1 };
  const result = UserConfigSchema.safeParse(data);
  if (result.success) return result.data;
  const problems = result.error.issues.flatMap((issue) => {
    const path = issue.path.map(String).join(".");
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => `unknown key "${path ? `${path}.${key}` : key}"`);
    }
    return [`${path || "the top level"}: ${issue.message}`];
  });
  throw new ConfigError(file, problems);
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
    "render.creditsTemplate": config.render?.creditsTemplate,
  };
}

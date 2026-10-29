// The user directory and its config.yaml (plan 0008). Commands read their defaults through
// loadConfig, so that no package other than the CLI reads the user directory.

export {
  AGENTS_TEMPLATE,
  CONFIG_TEMPLATE,
  ConfigInitError,
  DOCS_DIR,
  type InitUserDirOptions,
  initUserDir,
} from "./init.js";
export {
  CONFIG_DEFAULTS,
  CONFIG_ENV_VARS,
  ConfigError,
  type ConfigFlags,
  type ConfigValues,
  type EffectiveConfig,
  type EffectiveSettings,
  expandPath,
  type LoadConfigOptions,
  loadConfig,
  parseUserConfig,
  readUserConfig,
  resolveSettings,
  SETTINGS,
  type Setting,
  type SettingName,
  type SettingSource,
} from "./load.js";
export {
  describeRule,
  type Env,
  findUserDir,
  homeDir,
  LOCAL_DIR,
  type LocationOptions,
  REPO_ROOT,
  type UserDirLocation,
  type UserDirRule,
  type UserDirSearch,
  userDirCandidates,
} from "./location.js";
export { CONFIG_FILE, type UserConfig, UserConfigSchema } from "./schema.js";

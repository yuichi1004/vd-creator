// Where the user directory is. See "Location" in docs/plans/0008-user-config.md.

import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Environment variables, such as `process.env`. */
export type Env = Record<string, string | undefined>;

/**
 * The root of the vd-creator repository that holds this CLI. This module is at
 * apps/cli/src/config/ when tests run it and at apps/cli/dist/config/ when built.
 */
export const REPO_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

/** The folder name of the user directory at the repository root. */
export const LOCAL_DIR = "local";

/**
 * The rule that selected a user directory: `VD_USER_DIR`, `local/` at the repository root,
 * `$XDG_CONFIG_HOME/vd-creator/`, or `~/.config/vd-creator/` when `XDG_CONFIG_HOME` is not set.
 */
export type UserDirRule = "VD_USER_DIR" | "local" | "XDG_CONFIG_HOME" | "HOME";

export type UserDirLocation = { dir: string; rule: UserDirRule };

export type LocationOptions = {
  env: Env;
  /** The repository whose `local/` folder is a candidate. Defaults to `REPO_ROOT`. */
  repoRoot?: string;
};

export type UserDirSearch = {
  /** The first candidate that is a folder, or undefined if none is. */
  found: UserDirLocation | undefined;
  /** Every candidate, in order, including those that do not exist. */
  candidates: UserDirLocation[];
  /** True if `VD_USER_DIR` is set but is not a folder, so it was skipped. */
  userDirEnvSkipped: boolean;
};

/** A short description of a rule, for messages. */
export function describeRule(rule: UserDirRule): string {
  switch (rule) {
    case "VD_USER_DIR":
      return "the VD_USER_DIR environment variable";
    case "local":
      return `${LOCAL_DIR}/ at the repository root`;
    case "XDG_CONFIG_HOME":
      return "vd-creator/ in XDG_CONFIG_HOME";
    case "HOME":
      return "~/.config/vd-creator/";
  }
}

/** The home folder from `env`, or undefined. The real home is never read from elsewhere. */
export function homeDir(env: Env): string | undefined {
  return env.HOME || env.USERPROFILE || undefined;
}

/** The candidate user directories, in the order they are checked. Touches no file. */
export function userDirCandidates({
  env,
  repoRoot = REPO_ROOT,
}: LocationOptions): UserDirLocation[] {
  const candidates: UserDirLocation[] = [];
  if (env.VD_USER_DIR) candidates.push({ dir: resolve(env.VD_USER_DIR), rule: "VD_USER_DIR" });
  candidates.push({ dir: join(resolve(repoRoot), LOCAL_DIR), rule: "local" });
  const home = homeDir(env);
  if (env.XDG_CONFIG_HOME) {
    candidates.push({
      dir: join(resolve(env.XDG_CONFIG_HOME), "vd-creator"),
      rule: "XDG_CONFIG_HOME",
    });
  } else if (home) {
    candidates.push({ dir: join(resolve(home), ".config", "vd-creator"), rule: "HOME" });
  }
  return candidates;
}

/**
 * Finds the user directory: the first candidate that is a folder, following symbolic links.
 * Only one is used; they are not merged. Throws a file system error other than a missing path.
 */
export async function findUserDir(options: LocationOptions): Promise<UserDirSearch> {
  const candidates = userDirCandidates(options);
  let userDirEnvSkipped = false;
  for (const candidate of candidates) {
    if (await isFolder(candidate.dir)) {
      return { found: candidate, candidates, userDirEnvSkipped };
    }
    if (candidate.rule === "VD_USER_DIR") userDirEnvSkipped = true;
  }
  return { found: undefined, candidates, userDirEnvSkipped };
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
}

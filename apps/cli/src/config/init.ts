// vd config init: create the user directory layout.

import { mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LOCAL_DIR, REPO_ROOT } from "./location.js";
import { CONFIG_FILE } from "./schema.js";

/** The config.yaml that `vd config init` writes. Every setting is commented out. */
export const CONFIG_TEMPLATE = `# vd-creator user config. Every setting is optional.
# A command-line flag or an environment variable overrides the value here.
# Unknown keys are errors. Never put API keys here: keep them in environment variables.
version: 1

# Default sound library folder (--library, VD_LIBRARY). ~ at the start is the home
# folder, and a relative path is relative to this folder.
# library: ~/sounds/vd-library

# Defaults for vd serve.
# serve:
#   port: 5310
#   host: 127.0.0.1

# Default publish.use of a new scenario from vd init: private, non-commercial, or commercial.
# init:
#   publishUse: private

# Credits template for vd render, relative to this folder.
# render:
#   creditsTemplate: credits.template.txt
`;

/** The AGENTS.md that `vd config init` writes. */
export const AGENTS_TEMPLATE = `# My instructions for coding agents

Coding agents working on vd-creator read this file before they start. It adds to the
repository's AGENTS.md and cannot loosen its rules. Private notes go in docs/.
`;

/** The folder for private notes. */
export const DOCS_DIR = "docs";

/** Thrown when `vd config init` refuses a folder. */
export class ConfigInitError extends Error {
  override name = "ConfigInitError";
}

export type InitUserDirOptions = {
  /** The repository whose `local/` is the default. Defaults to `REPO_ROOT`. */
  repoRoot?: string;
  /** The folder that a relative `dir` is relative to. */
  cwd?: string;
};

/**
 * Creates the user directory layout in `dir`, or in `local/` at the repository root if `dir`
 * is undefined: config.yaml, AGENTS.md, and docs/. Existing files are kept. Throws a
 * `ConfigInitError`, before creating anything, if `dir` is inside the repository but is not
 * `local/`, because the gitignore covers only `local/`. Returns the absolute folder and the
 * entries it created.
 */
export async function initUserDir(
  dir: string | undefined,
  options: InitUserDirOptions = {},
): Promise<{ dir: string; created: string[] }> {
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
  const target =
    dir === undefined ? join(repoRoot, LOCAL_DIR) : resolve(options.cwd ?? process.cwd(), dir);
  await checkOutsideRepo(target, repoRoot, dir ?? `${LOCAL_DIR}/`);

  await mkdir(target, { recursive: true });
  // Checked again now that the folder exists, before any file is written in it.
  await checkOutsideRepo(target, repoRoot, dir ?? `${LOCAL_DIR}/`);
  const created: string[] = [];
  for (const [name, text] of [
    [CONFIG_FILE, CONFIG_TEMPLATE],
    ["AGENTS.md", AGENTS_TEMPLATE],
  ] as const) {
    try {
      // "wx" keeps a file that is already there.
      await writeFile(join(target, name), text, { encoding: "utf8", flag: "wx" });
      created.push(name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  try {
    await mkdir(join(target, DOCS_DIR));
    created.push(`${DOCS_DIR}/`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return { dir: target, created };
}

/**
 * Throws a `ConfigInitError` if `target` is the repository or inside it, other than `local/`.
 * The real path of the target, with every symbolic link resolved, decides for every route: it
 * must be the repository's own `local/` folder or outside the repository. So `local/` may be a
 * link to a folder elsewhere, but not to a folder in the repository, and a link from elsewhere
 * into the repository is refused. A path typed inside the repository is refused too, unless it
 * is `local/`.
 */
async function checkOutsideRepo(target: string, repoRoot: string, typed: string): Promise<void> {
  const realRepo = await realpathOf(repoRoot);
  const realTarget = await realpathOf(target);
  const realLocal = join(realRepo, LOCAL_DIR);
  const realOk = realTarget === realLocal || !isInside(realRepo, realTarget);
  const typedOk = target === join(repoRoot, LOCAL_DIR) || !isInside(repoRoot, target);
  if (!realOk || !typedOk) {
    throw new ConfigInitError(
      `${typed} is inside the vd-creator repository; use ${LOCAL_DIR}/, which git ignores, or a folder outside it`,
    );
  }
}

/** True if `path` is `folder` or inside it. */
function isInside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  // relative() returns an absolute path across Windows drives.
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The real path of `path`. If it does not exist, the real path of its nearest existing ancestor
 * with the rest appended, following a dangling symbolic link to where it points.
 */
async function realpathOf(path: string, links = 0): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const parent = dirname(path);
    if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === path) throw e;
    const link = await readlink(path).catch(() => undefined);
    if (link === undefined) return join(await realpathOf(parent, links), basename(path));
    // The same limit as the ELOOP of Linux.
    if (links >= 40) throw e;
    return realpathOf(resolve(await realpathOf(parent, links), link), links + 1);
  }
}

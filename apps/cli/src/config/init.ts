// vd config init: create the user directory layout.

import { type BigIntStats, constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
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

/** A device and inode number pair, which identifies a file or folder while it exists. */
type Identity = { dev: bigint; ino: bigint };

/** Something this run created, to remove if the run stops. */
type Created = { path: string; identity: Identity; folder: boolean };

/** Creates a file only if there is none, and never through a symbolic link at its name. */
const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

/**
 * Creates the user directory layout in `dir`, or in `local/` at the repository root if `dir`
 * is undefined: config.yaml, AGENTS.md, and docs/. Existing files are kept. Throws a
 * `ConfigInitError`, before creating anything, if `dir` is inside the repository but is not
 * `local/`, because the gitignore covers only `local/`. Returns the absolute folder as given and
 * the entries it created.
 *
 * Race policy, as in vd clean: the real path of the target is resolved and checked once, and
 * every later call uses that real path, never `dir`. After the folder is created, its real path
 * and its device and inode must still be the ones checked, and they are checked again before
 * each file or folder is created in it and once at the end. Files are created with O_EXCL and
 * O_NOFOLLOW. On any mismatch, or any other error, it stops with a `ConfigInitError` or that
 * error, and removes what this run created, each only if it is still the same file or folder.
 * Residual risk: Node has no openat or mkdirat, so a folder on the real path swapped for a
 * symbolic link in the instant between a check and the next call can still redirect that one
 * call. The check after it then finds the swap, and the run removes what that call created.
 */
export async function initUserDir(
  dir: string | undefined,
  options: InitUserDirOptions = {},
): Promise<{ dir: string; created: string[] }> {
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
  const typed = dir ?? `${LOCAL_DIR}/`;
  const target =
    dir === undefined ? join(repoRoot, LOCAL_DIR) : resolve(options.cwd ?? process.cwd(), dir);
  const real = await checkOutsideRepo(target, repoRoot, typed);
  const before = await lstatOrUndefined(real);

  const created: Created[] = [];
  let firstMade: string | undefined;
  const changed = () =>
    new ConfigInitError(
      `${typed} changed while it was being set up; stopped and removed what this run created`,
    );
  try {
    firstMade = await mkdir(real, { recursive: true });
    const folder = await lstat(real, { bigint: true });
    if (
      !folder.isDirectory() ||
      (before && !sameId(folder, idOf(before))) ||
      (await realpath(real)) !== real
    ) {
      throw changed();
    }
    const identity = idOf(folder);
    const ensureSame = async () => {
      const now = await lstatOrUndefined(real);
      const realNow = await realpath(real).catch(() => undefined);
      if (!now?.isDirectory() || !sameId(now, identity) || realNow !== real) throw changed();
    };

    for (const [name, text] of [
      [CONFIG_FILE, CONFIG_TEMPLATE],
      ["AGENTS.md", AGENTS_TEMPLATE],
    ] as const) {
      await ensureSame();
      const path = join(real, name);
      let handle: FileHandle;
      try {
        handle = await open(path, CREATE_FLAGS, 0o644);
      } catch (e) {
        // A file that is already there is kept.
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      try {
        created.push({ path, identity: idOf(await handle.stat({ bigint: true })), folder: false });
        await handle.writeFile(text, "utf8");
      } finally {
        await handle.close();
      }
    }
    await ensureSame();
    const docs = join(real, DOCS_DIR);
    try {
      await mkdir(docs);
      const stats = await lstat(docs, { bigint: true });
      if (stats.isDirectory()) created.push({ path: docs, identity: idOf(stats), folder: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    await ensureSame();
  } catch (e) {
    await removeCreated(created, firstMade, real);
    throw e;
  }
  const names = created.map((entry) => (entry.folder ? `${DOCS_DIR}/` : basename(entry.path)));
  return { dir: target, created: names };
}

/**
 * Removes what a stopped run created, newest first: each file or folder only if it is still the
 * same one, then the folders that mkdir made for `real`, from `real` up to `firstMade`, only if
 * they are empty. Errors are ignored, so the first error is the one reported.
 */
async function removeCreated(
  created: Created[],
  firstMade: string | undefined,
  real: string,
): Promise<void> {
  for (const entry of [...created].reverse()) {
    const stats = await lstatOrUndefined(entry.path).catch(() => undefined);
    if (!stats || !sameId(stats, entry.identity)) continue;
    await (entry.folder ? rmdir(entry.path) : unlink(entry.path)).catch(() => undefined);
  }
  if (firstMade === undefined || !(real === firstMade || real.startsWith(firstMade + sep))) return;
  for (let folder = real; ; folder = dirname(folder)) {
    const stats = await lstatOrUndefined(folder).catch(() => undefined);
    // rmdir removes only an empty folder, and never follows a link at the name.
    if (stats?.isDirectory()) await rmdir(folder).catch(() => undefined);
    if (folder === firstMade || dirname(folder) === folder) break;
  }
}

async function lstatOrUndefined(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function idOf(stats: BigIntStats): Identity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameId(stats: BigIntStats, identity: Identity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino;
}

/**
 * Throws a `ConfigInitError` if `target` is the repository or inside it, other than `local/`.
 * The real path of the target, with every symbolic link resolved, decides for every route: it
 * must be the repository's own `local/` folder or outside the repository. So `local/` may be a
 * link to a folder elsewhere, but not to a folder in the repository, and a link from elsewhere
 * into the repository is refused. A path typed inside the repository is refused too, unless it
 * is `local/`. Returns the real path of the target, which every later call uses.
 */
async function checkOutsideRepo(target: string, repoRoot: string, typed: string): Promise<string> {
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
  return realTarget;
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

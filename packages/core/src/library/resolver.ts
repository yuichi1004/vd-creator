// The resolver for library sounds. See "Project integration" in docs/plans/0007-sound-library.md.

import {
  checkEntry,
  findEntry,
  type Library,
  type LibraryEntry,
  LibraryError,
  readLibrary,
} from "@vd-creator/library";
import type { ScenarioItem } from "../items.js";
import type { AssetResolver, PlannedAsset, ResolveContext, ResolvedAsset } from "../resolver.js";
import {
  copyLibraryEntry,
  entryDuration,
  type LibraryRef,
  libraryRef,
  ProjectCreditsError,
  projectCopy,
  readCredits,
  readDurations,
  refLabel,
  removeOrphanCopies,
} from "./project.js";

/** Reason of a library item when no library is set. */
export const NO_LIBRARY =
  "No sound library is set; use --library, VD_LIBRARY, or library in config.yaml";

export type LibraryItemResolverOptions = {
  /** Root folder of the library. Without it, only items already copied resolve. */
  root?: string;
};

/**
 * Resolves library SFX and BGM. An item whose entry the project already has in credits.json,
 * with its copy in assets/library/ matching the credit's sha256, is cached and needs no
 * library; a copy that does not match is made again. Otherwise the entry must
 * be in the library and pass its checks; resolving copies it into
 * `assets/library/<sha256 prefix>.<ext>` and records it in credits.json. A copy costs nothing.
 * The license check against publish.use is not done here but by `checkLibraryLicenses`, so
 * that a project can be laid out before its licenses are settled.
 */
export class LibraryItemResolver implements AssetResolver {
  readonly id = "library";
  readonly root: string | undefined;
  // One read per plan or run, so that a long-running server sees library changes.
  #libraries = new WeakMap<ResolveContext, Promise<Library>>();
  // Orphan temporary copies are removed once per plan or run.
  #cleanups = new WeakMap<ResolveContext, Promise<void>>();

  constructor(options: LibraryItemResolverOptions = {}) {
    this.root = options.root;
  }

  handles(item: ScenarioItem): boolean {
    return libraryRef(item) !== undefined;
  }

  async plan(item: ScenarioItem, ctx: ResolveContext): Promise<PlannedAsset> {
    const ref = this.#ref(item);
    await this.#cleanup(ctx);
    try {
      const copy = await projectCopy(
        ctx.cache.projectDir,
        await readCredits(ctx.cache.projectDir),
        await readDurations(ctx.cache.projectDir),
        ref,
      );
      if (copy) {
        return { status: "cached", file: copy.credit.file, durationSec: copy.durationSec };
      }
      const found = await this.#entry(ref, ctx);
      if ((await entryDuration(found.library, found.item)) === undefined) {
        return {
          status: "unresolved",
          reason: `The duration of ${refLabel(ref)} is unknown; set durationSec in ${found.item.dir}/entry.yaml`,
        };
      }
      return { status: "to-generate", cost: { characters: 0, requests: 0 } };
    } catch (e) {
      if (e instanceof LibraryError || e instanceof ProjectCreditsError) {
        return { status: "unresolved", reason: e.message };
      }
      throw e;
    }
  }

  async resolve(item: ScenarioItem, ctx: ResolveContext): Promise<ResolvedAsset> {
    const ref = this.#ref(item);
    await this.#cleanup(ctx);
    const found = await this.#entry(ref, ctx);
    const copy = await copyLibraryEntry(ctx.cache.projectDir, found.library, found.item);
    return { file: copy.credit.file, durationSec: copy.durationSec, generated: true };
  }

  #cleanup(ctx: ResolveContext): Promise<void> {
    let cleanup = this.#cleanups.get(ctx);
    if (!cleanup) {
      cleanup = removeOrphanCopies(ctx.cache.projectDir);
      this.#cleanups.set(ctx, cleanup);
    }
    return cleanup;
  }

  #library(ctx: ResolveContext): Promise<Library> {
    if (this.root === undefined) return Promise.reject(new LibraryError(NO_LIBRARY));
    let library = this.#libraries.get(ctx);
    if (!library) {
      library = readLibrary(this.root);
      this.#libraries.set(ctx, library);
    }
    return library;
  }

  /** Finds an entry that passes its checks. Throws a `LibraryError` otherwise. */
  async #entry(
    ref: LibraryRef,
    ctx: ResolveContext,
  ): Promise<{ library: Library; item: LibraryEntry }> {
    const library = await this.#library(ctx);
    const item = findEntry(library, ref.id, ref.kind);
    const errors = (await checkEntry(library, item)).filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new LibraryError(
        `Library entry ${refLabel(ref)} has problems: ${errors.map((i) => i.message).join("; ")}`,
        errors,
      );
    }
    return { library, item };
  }

  #ref(item: ScenarioItem): LibraryRef {
    const ref = libraryRef(item);
    if (!ref) throw new Error(`The library resolver does not handle ${item.kind} "${item.id}"`);
    return ref;
  }
}

/** The library resolver for `root`, to put before the default resolvers. */
export function libraryResolver(root?: string): LibraryItemResolver {
  return new LibraryItemResolver({ root });
}

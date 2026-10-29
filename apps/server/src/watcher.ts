// Watches a project folder for changes to scenario.yaml and cache.json.

import { type FSWatcher, watch } from "node:fs";
import { CACHE_FILE } from "@vd-creator/core";
import { SCENARIO_FILE } from "@vd-creator/scenario";
import type { ProjectChangedEvent } from "./api.js";

/** Changes are reported this long after the last event for a file, so a save is one event. */
export const WATCH_DEBOUNCE_MS = 100;

const WATCHED = new Set<string>([SCENARIO_FILE, CACHE_FILE]);

export type ProjectListener = (event: ProjectChangedEvent) => void;

/** A source of `project-changed` events. */
export interface ProjectEvents {
  /** Calls `listener` on each change. Returns a function that stops it. */
  subscribe(listener: ProjectListener): () => void;
}

/**
 * Watches the project folder itself, not the two files, since saves replace them by rename,
 * which would end a watch on the file. Uses `node:fs` `watch`.
 */
export class ProjectWatcher implements ProjectEvents {
  #listeners = new Set<ProjectListener>();
  #timers = new Map<ProjectChangedEvent["file"], NodeJS.Timeout>();
  #watcher: FSWatcher;

  constructor(projectDir: string) {
    this.#watcher = watch(projectDir, { persistent: false }, (_type, name) => {
      if (name && WATCHED.has(name)) this.#changed(name as ProjectChangedEvent["file"]);
    });
    // A watch error, such as the folder being removed, ends the events; the UI then polls.
    this.#watcher.on("error", () => this.close());
  }

  subscribe(listener: ProjectListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#watcher.close();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#listeners.clear();
  }

  #changed(file: ProjectChangedEvent["file"]): void {
    clearTimeout(this.#timers.get(file));
    this.#timers.set(
      file,
      setTimeout(() => {
        this.#timers.delete(file);
        for (const listener of [...this.#listeners]) listener({ file });
      }, WATCH_DEBOUNCE_MS),
    );
  }
}

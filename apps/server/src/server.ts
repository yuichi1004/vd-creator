// `startServer`: the app on a node HTTP server, as `vd serve` runs it.

import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { type AssetResolver, reconcile } from "@vd-creator/core";
import type { AgentOptions } from "./agent/command.js";
import { type AppOptions, createApp, type ServerProviders } from "./app.js";
import { createToken, TOKEN_QUERY } from "./token.js";
import { ProjectWatcher, WatchError } from "./watcher.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4173;

export type StartServerOptions = {
  projectDir: string;
  provider: ServerProviders;
  /** Port to listen on; 0 picks a free one. */
  port?: number;
  /**
   * Address to listen on, 127.0.0.1 when absent. When given, every request needs the access
   * token, which is part of the returned URL.
   */
  host?: string;
  library?: string;
  webDir?: string;
  /**
   * Without `host`, host names accepted in the `Host` header besides `localhost`,
   * `127.0.0.1`, `[::1]`, and `.ts.net` names (`vd serve --allow-host`).
   */
  allowedHosts?: string[];
  /** Resolvers tried before the generated-item resolver, such as one for library items. */
  resolvers?: AssetResolver[];
  /** The agent that answers instructions (`agent` in the user's config.yaml, plan 0013). */
  agent?: AgentOptions;
};

export type RunningServer = {
  /** The URL to open, with `?token=` when a token is needed. */
  url: string;
  port: number;
  /** The address the server listens on, as resolved from `host`, such as 127.0.0.1 for 127.1. */
  address: string;
  token?: string;
  close(): Promise<void>;
};

/**
 * `addr` as the host part of a URL: an IPv6 address in brackets, with the `%` of a zone, as in
 * `fe80::1%eth0`, encoded as `%25` and the zone itself percent-encoded.
 */
export function urlHost(addr: string): string {
  const at = addr.indexOf("%");
  const address = at === -1 ? addr : addr.slice(0, at);
  if (!address.includes(":")) return addr;
  const zone = at === -1 ? "" : `%25${encodeURIComponent(addr.slice(at + 1))}`;
  return `[${address}${zone}]`;
}

/**
 * Starts the server and resolves once it listens. Rejects with a `WatchError` if the project
 * folder cannot be watched, and with the listen error if it cannot listen.
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const token = options.host !== undefined ? createToken() : undefined;
  let watcher: ProjectWatcher;
  try {
    // Edits made while no server ran are recorded now, before the first page load.
    await reconcile(options.projectDir).catch(() => {});
    watcher = new ProjectWatcher(options.projectDir, () => reconcile(options.projectDir));
  } catch (e) {
    throw new WatchError(e);
  }
  const ending = new AbortController();
  const appOptions: AppOptions = {
    projectDir: options.projectDir,
    provider: options.provider,
    events: watcher,
    signal: ending.signal,
  };
  if (options.library !== undefined) appOptions.library = options.library;
  if (options.webDir !== undefined) appOptions.webDir = options.webDir;
  if (options.allowedHosts !== undefined) appOptions.allowedHosts = options.allowedHosts;
  if (options.resolvers !== undefined) appOptions.resolvers = options.resolvers;
  if (options.agent !== undefined) appOptions.agent = options.agent;
  if (token !== undefined) appOptions.token = token;
  const app = createApp(appOptions);
  const server = createAdaptorServer({ fetch: app.fetch });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? DEFAULT_PORT, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    watcher.close();
    throw e;
  }

  const { port, address } = server.address() as AddressInfo;
  const query = token !== undefined ? `?${TOKEN_QUERY}=${token}` : "";
  const running: RunningServer = {
    url: `http://${urlHost(host)}:${port}/${query}`,
    port,
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        ending.abort();
        watcher.close();
        server.close((e) => (e ? reject(e) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  };
  if (token !== undefined) running.token = token;
  return running;
}

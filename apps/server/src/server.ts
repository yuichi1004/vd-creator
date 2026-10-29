// `startServer`: the app on a node HTTP server, as `vd serve` runs it.

import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { type AppOptions, createApp, type ServerProviders } from "./app.js";
import { createToken, TOKEN_QUERY } from "./token.js";
import { ProjectWatcher } from "./watcher.js";

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
};

export type RunningServer = {
  /** The URL to open, with `?token=` when a token is needed. */
  url: string;
  port: number;
  token?: string;
  close(): Promise<void>;
};

/** Starts the server and resolves once it listens. */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const token = options.host !== undefined ? createToken() : undefined;
  const watcher = new ProjectWatcher(options.projectDir);
  const ending = new AbortController();
  const appOptions: AppOptions = {
    projectDir: options.projectDir,
    provider: options.provider,
    events: watcher,
    signal: ending.signal,
  };
  if (options.library !== undefined) appOptions.library = options.library;
  if (options.webDir !== undefined) appOptions.webDir = options.webDir;
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

  const port = (server.address() as AddressInfo).port;
  const shown = host.includes(":") ? `[${host}]` : host;
  const query = token !== undefined ? `?${TOKEN_QUERY}=${token}` : "";
  const running: RunningServer = {
    url: `http://${shown}:${port}/${query}`,
    port,
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

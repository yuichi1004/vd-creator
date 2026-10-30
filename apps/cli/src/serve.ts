// `vd serve`: the review UI and its API over one project folder. See
// docs/plans/0005-review-ui.md.

import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { hostName, TOKEN_QUERY, urlHost } from "@vd-creator/server";
import { REPO_ROOT } from "./config/index.js";

export const DEFAULT_SERVE_PORT = 5310;

/** The built web UI (`npm run build -w apps/web`). */
export const WEB_DIR = join(REPO_ROOT, "apps", "web", "dist");

export const SERVE_USAGE =
  "Usage: vd serve [dir] [--port <n>] [--provider mock|elevenlabs] [--host <addr>] [--allow-host <name>]... [--library <path>]";

export const NETWORK_WARNING = [
  "Warning: the server listens on the network. Anyone on the network who has one of these URLs",
  "can edit the project and, with a paid provider, spend money. Traffic is plain HTTP.",
  "Tailscale is the recommended way to open the UI from a phone (see the phone access guide).",
];

/** The port given with --port: an integer from 0 to 65535, where 0 picks a free one. */
export function parsePort(value: string): number | undefined {
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return port <= 65535 ? port : undefined;
}

/**
 * True if `name`, given with --allow-host, can match a `Host` header: a host name, IPv4
 * address, or bracketed IPv6 address, without a port.
 */
export function allowHostValid(name: string): boolean {
  return hostName(name) === name.toLowerCase();
}

/** `host` as given with --host, without the brackets of an IPv6 address such as `[::]`. */
export function listenHost(host: string): string {
  return host.replace(/^\[(.*)\]$/, "$1");
}

/** `host` as a URL normalizes it, such as `[::]` for `0:0:0:0:0:0:0:0`, if it is IPv6. */
function ipv6Normal(host: string): string | undefined {
  // URL does not take a zone, as in fe80::1%eth0, and the zone does not matter here.
  const address = host.replace(/%.*$/, "");
  return isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname : undefined;
}

/** True if `host` is the IPv6 wildcard in any spelling, such as `::` or `0:0:0:0:0:0:0:0`. */
function ipv6Any(host: string): boolean {
  return ipv6Normal(host) === "[::]";
}

/**
 * True if a server listening on `host` is reachable only from this machine: `localhost`, an
 * address in 127.0.0.0/8, `::1`, or an IPv4-mapped 127.x address.
 */
export function loopbackHost(host: string): boolean {
  if (host.toLowerCase() === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  const normal = ipv6Normal(host);
  return normal === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:/.test(normal ?? "");
}

/**
 * The addresses to print for a server listening on `host`: each address of the machine when
 * `host` is a wildcard (IPv4 only for 0.0.0.0; IPv6 too for ::, without link-local ones, which
 * need a zone), or `host` itself.
 */
export function listenAddresses(
  host: string,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const ipv4 = host === "0.0.0.0";
  const any = ipv6Any(host);
  if (!ipv4 && !any) return [host];
  const addresses = Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((info) => info.family === "IPv4" || (any && !info.scopeid))
    .map((info) => info.address);
  return [...new Set(addresses)];
}

/** The URL with the token for each address. */
export function tokenUrls(addresses: string[], port: number, token: string): string[] {
  return addresses.map((addr) => `http://${urlHost(addr)}:${port}/?${TOKEN_QUERY}=${token}`);
}

/** True if the built web UI is in `dir`. */
export function webBuilt(dir: string): boolean {
  return existsSync(join(dir, "index.html"));
}

/**
 * `given`, or else a signal that aborts on the first SIGINT or SIGTERM, with a function to stop
 * listening for them.
 */
export function stopSignal(given?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  if (given !== undefined) return { signal: given, dispose: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}

/** Resolves when `signal` aborts. */
export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

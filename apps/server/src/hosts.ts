// The Host check of a server without a token, against DNS rebinding. See the paragraph after
// "Other VPNs and SSH tunnels" in docs/plans/0005-review-ui.md.

import type { MiddlewareHandler } from "hono";
import type { ApiError } from "./api.js";

/** Host names a server without a token always accepts. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const TAILNET_SUFFIX = ".ts.net";

const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/;
const PORT = /^[0-9]{1,5}$/;

/**
 * The host name of a `Host` header in lower case, without its port, or undefined if the
 * header is missing or is not a plain name, IPv4 address, or bracketed IPv6 address with an
 * optional port.
 */
export function hostName(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const value = header.trim().toLowerCase();
  const close = value.startsWith("[") ? value.indexOf("]") + 1 : 0;
  const colon = value.indexOf(":", close);
  const name = colon === -1 ? value : value.slice(0, colon);
  if (colon !== -1 && !PORT.test(value.slice(colon + 1))) return undefined;
  return NAME.test(name) || IPV6.test(name) ? name : undefined;
}

/** True if a server without a token accepts a request with this `Host` header. */
export function hostAllowed(header: string | undefined, allowedHosts: readonly string[] = []) {
  const name = hostName(header);
  if (name === undefined) return false;
  if (LOOPBACK_HOSTS.includes(name)) return true;
  if (name.endsWith(TAILNET_SUFFIX) && name.length > TAILNET_SUFFIX.length) return true;
  return allowedHosts.some((allowed) => allowed.toLowerCase() === name);
}

const FORBIDDEN: ApiError = {
  error: "unauthorized",
  message: "This host name is not allowed; open the URL printed by vd serve, or add --allow-host",
};

/** Refuses, with 403, every request whose `Host` header names no allowed host. */
export function hostCheck(allowedHosts: readonly string[] = []): MiddlewareHandler {
  return async (c, next) => {
    if (!hostAllowed(c.req.header("Host"), allowedHosts)) return c.json(FORBIDDEN, 403);
    await next();
  };
}

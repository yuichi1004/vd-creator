// The access token of `vd serve --host`. See "Access from a phone" in docs/plans/0005-review-ui.md.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { ApiError } from "./api.js";

/** Name of the cookie that holds the token after the first visit. */
export const TOKEN_COOKIE = "vd_token";
/** Name of the query parameter that carries the token on the first visit. */
export const TOKEN_QUERY = "token";

/** A new random token: 32 bytes, URL-safe base64. */
export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * True if `given` equals `token`, in time that does not depend on where they differ. Both are
 * hashed first, so that their lengths do not matter either.
 */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(given), digest(token));
}

const UNAUTHORIZED: ApiError = {
  error: "unauthorized",
  message: "This server needs the access token printed by vd serve",
};

/**
 * Checks the token on every request. A valid `?token=` query sets an `HttpOnly`,
 * `SameSite=Strict` cookie with no `Path`, so that it works under a path prefix; later
 * requests use the cookie. Anything else gets 401.
 */
export function tokenCheck(token: string): MiddlewareHandler {
  return async (c, next) => {
    const fromQuery = c.req.query(TOKEN_QUERY);
    if (tokenMatches(fromQuery, token)) {
      // Written by hand: Hono's setCookie always adds `Path=/`. The token is base64url, so
      // it needs no escaping.
      c.header("Set-Cookie", `${TOKEN_COOKIE}=${token}; HttpOnly; SameSite=Strict`, {
        append: true,
      });
      await next();
      return;
    }
    if (tokenMatches(getCookie(c, TOKEN_COOKIE), token)) {
      await next();
      return;
    }
    return c.json(UNAUTHORIZED, 401);
  };
}

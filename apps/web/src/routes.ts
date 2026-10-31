// Hash routes of the UI. See "Screens" in docs/plans/0010-settings-and-playback-speed.md.
// Only the fragment changes between screens, so every route works under a path prefix and the
// server needs no route of its own.

export type Route = { name: "review" } | { name: "settings" };

export const REVIEW_ROUTE: Route = { name: "review" };
export const SETTINGS_ROUTE: Route = { name: "settings" };

/** Parses a location hash such as `#/settings`. Anything unknown is the review screen. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed === "/settings" || trimmed === "settings" ? SETTINGS_ROUTE : REVIEW_ROUTE;
}

/** The hash of a route, such as `#/settings`. */
export function buildHash(route: Route): string {
  return route.name === "settings" ? "#/settings" : "#/";
}

/**
 * The URL of a route on the page `pageUrl` (normally `document.baseURI` or `location.href`).
 * The path prefix and the query stay as they are; only the fragment is replaced.
 */
export function buildHref(pageUrl: string, route: Route): string {
  const url = new URL(pageUrl);
  url.hash = buildHash(route);
  return url.href;
}

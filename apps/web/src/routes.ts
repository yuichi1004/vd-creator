// Hash routes of the UI. See "Screens" in docs/plans/0010-settings-and-playback-speed.md and
// "Retake screen" in docs/plans/0013-voice-retake-with-agent.md.
// Only the fragment changes between screens, so every route works under a path prefix and the
// server needs no route of its own.

export type Route = { name: "review" } | { name: "settings" } | { name: "line"; id: string };

export const REVIEW_ROUTE: Route = { name: "review" };
export const SETTINGS_ROUTE: Route = { name: "settings" };

/** The retake screen of the line `id`. */
export function lineRoute(id: string): Route {
  return { name: "line", id };
}

/**
 * Parses a location hash such as `#/settings` or `#/line/s0-l2`. Anything unknown is the review
 * screen.
 */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (trimmed === "/settings" || trimmed === "settings") return SETTINGS_ROUTE;
  const line = /^\/?line\/([^/]+)$/.exec(trimmed);
  if (line?.[1] !== undefined) {
    try {
      const id = decodeURIComponent(line[1]);
      if (id !== "") return lineRoute(id);
    } catch {
      // A bad escape is an unknown route.
    }
  }
  return REVIEW_ROUTE;
}

/** The hash of a route, such as `#/settings`. */
export function buildHash(route: Route): string {
  if (route.name === "settings") return "#/settings";
  if (route.name === "line") return `#/line/${encodeURIComponent(route.id)}`;
  return "#/";
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

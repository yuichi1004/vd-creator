import { useEffect, useState } from "react";
import { parseRoute, type Route } from "./routes.js";

/** The current route, following the location hash (including the browser's back button). */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

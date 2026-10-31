import { describe, expect, test } from "vitest";
import { buildHash, buildHref, parseRoute, REVIEW_ROUTE, SETTINGS_ROUTE } from "./routes.js";

describe("parseRoute", () => {
  test("#/ and an empty hash are the review screen", () => {
    expect(parseRoute("#/")).toEqual(REVIEW_ROUTE);
    expect(parseRoute("")).toEqual(REVIEW_ROUTE);
    expect(parseRoute("#")).toEqual(REVIEW_ROUTE);
  });

  test("#/settings is the settings screen", () => {
    expect(parseRoute("#/settings")).toEqual(SETTINGS_ROUTE);
    expect(parseRoute("#/settings/")).toEqual(SETTINGS_ROUTE);
  });

  test("unknown routes show the review screen", () => {
    expect(parseRoute("#/nope")).toEqual(REVIEW_ROUTE);
    expect(parseRoute("#/settings/extra")).toEqual(REVIEW_ROUTE);
    expect(parseRoute("settings")).toEqual(REVIEW_ROUTE);
  });
});

describe("buildHash and buildHref", () => {
  test("hashes round-trip", () => {
    expect(buildHash(REVIEW_ROUTE)).toBe("#/");
    expect(buildHash(SETTINGS_ROUTE)).toBe("#/settings");
    expect(parseRoute(buildHash(SETTINGS_ROUTE))).toEqual(SETTINGS_ROUTE);
  });

  test("a route keeps the path prefix and replaces only the fragment", () => {
    const page = "http://host.example/app/vd/#/settings";
    expect(buildHref(page, REVIEW_ROUTE)).toBe("http://host.example/app/vd/#/");
    expect(buildHref("http://host.example/app/vd/", SETTINGS_ROUTE)).toBe(
      "http://host.example/app/vd/#/settings",
    );
  });

  test("the query stays", () => {
    expect(buildHref("http://host.example/app/vd/?token=x", SETTINGS_ROUTE)).toBe(
      "http://host.example/app/vd/?token=x#/settings",
    );
  });

  test("a location under a prefix parses from its hash", () => {
    const url = new URL(buildHref("http://host.example/app/vd/", SETTINGS_ROUTE));
    expect(parseRoute(url.hash)).toEqual(SETTINGS_ROUTE);
  });
});

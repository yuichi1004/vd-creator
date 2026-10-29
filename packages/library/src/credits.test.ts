import type { PublishUse } from "@vd-creator/scenario";
import { describe, expect, test } from "vitest";
import {
  buildCreditsText,
  type CreditEntry,
  type Credits,
  CreditsSchema,
  checkProjectLicenses,
  type LicenseTerms,
  STANDARD_LICENSES,
} from "./index.js";

const CC0 = STANDARD_LICENSES["CC0-1.0"] as LicenseTerms;
const CC_BY = STANDARD_LICENSES["CC-BY-4.0"] as LicenseTerms;
const CC_BY_NC = STANDARD_LICENSES["CC-BY-NC-4.0"] as LicenseTerms;
const conditional: LicenseTerms = {
  name: "Example Sounds standard license",
  attribution: "appreciated",
  commercialUse: "conditional",
  modification: "allowed",
  shareAlike: false,
};

function entry(
  overrides: { license?: Partial<CreditEntry["license"]>; terms?: LicenseTerms | null } = {},
): CreditEntry {
  const terms = overrides.terms === undefined ? CC0 : overrides.terms;
  return {
    id: "door-01",
    kind: "sfx",
    title: "Door",
    file: "library/9c1e.wav",
    sha256: "0".repeat(64),
    source: { type: "downloaded", url: "https://example.com/1" },
    license: { id: "X", verified: true, ...overrides.license },
    ...(terms ? { terms } : {}),
  };
}

function credits(...entries: CreditEntry[]): Credits {
  return { version: 1, entries, providers: [] };
}

const USES: PublishUse[] = ["private", "non-commercial", "commercial"];

// Outcome per use, in the order of USES.
function outcomes(e: CreditEntry): string[] {
  return USES.map((use) => {
    const issues = checkProjectLicenses(credits(e), use);
    expect(issues.length).toBeLessThanOrEqual(1);
    return issues[0] ? `${issues[0].code}:${issues[0].severity}` : "ok";
  });
}

describe("checkProjectLicenses", () => {
  test("a verified CC0 entry is fine everywhere", () => {
    expect(outcomes(entry())).toEqual(["ok", "ok", "ok"]);
  });

  test("row: entry not verified", () => {
    expect(outcomes(entry({ license: { verified: false } }))).toEqual([
      "unverified:warning",
      "unverified:error",
      "unverified:error",
    ]);
  });

  test("row: commercialUse forbidden", () => {
    const e = entry({ terms: CC_BY_NC, license: { attribution: "by Jane" } });
    expect(outcomes(e)).toEqual(["ok", "ok", "commercial-forbidden:error"]);
  });

  test("forbidden commercial use cannot be approved", () => {
    const e = entry({
      terms: CC_BY_NC,
      license: { attribution: "by Jane", approvedFor: "commercial" },
    });
    expect(outcomes(e)).toEqual(["ok", "ok", "commercial-forbidden:error"]);
  });

  test("row: commercialUse conditional", () => {
    expect(outcomes(entry({ terms: conditional }))).toEqual([
      "ok",
      "commercial-conditional:warning",
      "commercial-conditional:error",
    ]);
  });

  test("row: commercialUse unknown, including terms missing from the registry", () => {
    const unknown = { ...conditional, commercialUse: "unknown" as const };
    const expected = ["ok", "commercial-conditional:warning", "commercial-conditional:error"];
    expect(outcomes(entry({ terms: unknown }))).toEqual(expected);
    expect(outcomes(entry({ terms: null }))).toEqual(expected);
  });

  test("row: conditional with approvedFor commercial is ok for commercial use", () => {
    const e = entry({ terms: conditional, license: { approvedFor: "commercial" } });
    expect(outcomes(e)).toEqual(["ok", "commercial-conditional:warning", "ok"]);
  });

  test("row: attribution required but missing", () => {
    expect(outcomes(entry({ terms: CC_BY }))).toEqual([
      "attribution-missing:warning",
      "attribution-missing:error",
      "attribution-missing:error",
    ]);
    expect(outcomes(entry({ terms: CC_BY, license: { attribution: "by Jane" } }))).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
  });

  test("reports every problem of every entry", () => {
    const bad = entry({ terms: CC_BY_NC, license: { verified: false } });
    const issues = checkProjectLicenses(credits(bad, { ...entry(), id: "ok-01" }), "commercial");
    expect(issues.map((i) => [i.entryId, i.code, i.severity])).toEqual([
      ["door-01", "unverified", "error"],
      ["door-01", "commercial-forbidden", "error"],
      ["door-01", "attribution-missing", "error"],
    ]);
  });
});

describe("buildCreditsText", () => {
  const full: Credits = CreditsSchema.parse({
    version: 1,
    entries: [
      entry({ terms: CC_BY, license: { attribution: '"Old door" by Jane Doe, CC BY 4.0' } }),
      { ...entry({ terms: conditional, license: { attribution: "Rain by Example" } }), id: "r" },
      { ...entry({ license: { attribution: "Not needed" } }), id: "cc0" },
    ],
    providers: [{ id: "elevenlabs", name: "ElevenLabs", kinds: ["voice"] }, { id: "mock" }],
  });

  test("default template lists attributions, then providers", () => {
    expect(buildCreditsText(full)).toBe(
      'Sounds:\n"Old door" by Jane Doe, CC BY 4.0\nRain by Example\n\nGenerated with: ElevenLabs, mock\n',
    );
  });

  test("drops empty sections", () => {
    expect(buildCreditsText({ ...full, entries: [] })).toBe("Generated with: ElevenLabs, mock\n");
    expect(buildCreditsText({ ...full, providers: [] })).toBe(
      'Sounds:\n"Old door" by Jane Doe, CC BY 4.0\nRain by Example\n',
    );
    expect(buildCreditsText(credits())).toBe("");
  });

  test("uses a custom template", () => {
    const template = "== Credits ==\n{{attributions}}\nVoices and music: {{providers}}\n";
    expect(buildCreditsText(full, template)).toBe(
      '== Credits ==\n"Old door" by Jane Doe, CC BY 4.0\nRain by Example\nVoices and music: ElevenLabs, mock\n',
    );
  });
});

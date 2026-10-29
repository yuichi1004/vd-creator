import type { PublishUse } from "@vd-creator/scenario";
import { describe, expect, test } from "vitest";
import {
  buildCreditsText,
  type CreditEntry,
  CreditEntrySchema,
  type CreditProvider,
  type Credits,
  CreditsSchema,
  checkProjectLicenses,
  LicenseRegistrySchema,
  type LicenseTerms,
  STANDARD_LICENSES,
  toCreditEntry,
  toCreditProvider,
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
    expect(outcomes(entry({ terms: null, license: { attribution: "by Jane" } }))).toEqual(expected);
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
    expect(issues.map((i) => [i.id, i.code, i.severity])).toEqual([
      ["door-01", "unverified", "error"],
      ["door-01", "commercial-forbidden", "error"],
      ["door-01", "attribution-missing", "error"],
    ]);
  });
});

// All issues per use, in the order of USES, as "code:severity" joined by commas.
function allOutcomes(c: Credits): string[] {
  return USES.map(
    (use) =>
      checkProjectLicenses(c, use)
        .map((i) => `${i.code}:${i.severity}`)
        .join(",") || "ok",
  );
}

describe("missing or unknown terms (P2-7)", () => {
  test("an approved entry with no terms and no attribution is not ok", () => {
    const e = entry({ terms: null, license: { approvedFor: "commercial" } });
    expect(allOutcomes(credits(e))).toEqual([
      "attribution-missing:warning",
      "commercial-conditional:warning,attribution-missing:error",
      "attribution-missing:error",
    ]);
  });

  test("an unknown attribution term needs attribution text", () => {
    const unknown = { ...CC0, attribution: "unknown" as const };
    expect(outcomes(entry({ terms: unknown }))).toEqual([
      "attribution-missing:warning",
      "attribution-missing:error",
      "attribution-missing:error",
    ]);
    expect(outcomes(entry({ terms: unknown, license: { attribution: "by Jane" } }))).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
  });
});

describe("blank attribution (P2-3)", () => {
  test("the schema rejects whitespace-only attribution", () => {
    const e = entry({ terms: CC_BY, license: { attribution: "   " } });
    expect(CreditEntrySchema.safeParse(e).success).toBe(false);
  });

  test("the checker treats whitespace-only attribution as missing", () => {
    const e = entry({ terms: CC_BY, license: { attribution: " \t " } });
    expect(outcomes(e)).toEqual([
      "attribution-missing:warning",
      "attribution-missing:error",
      "attribution-missing:error",
    ]);
    expect(buildCreditsText(credits(e))).toBe("");
  });
});

describe("credit file paths (P2-6)", () => {
  test.each([
    "../../x.wav",
    "/x.wav",
    "C:\\x.wav",
    "C:x.wav",
    "library\\x.wav",
    "./x.wav",
    "library/../x.wav",
    "",
  ])("rejects %j", (file) => {
    expect(CreditEntrySchema.safeParse({ ...entry(), file }).success).toBe(false);
  });

  test("accepts a path below assets/", () => {
    expect(CreditEntrySchema.safeParse(entry()).success).toBe(true);
  });
});

describe("inherited registry keys (P2-2)", () => {
  test.each(["constructor", "toString", "hasOwnProperty"])(
    "toCreditEntry does not find license %s in an empty registry",
    (id) => {
      const credit = toCreditEntry(
        {
          kind: "sfx",
          dir: "sfx/door-01",
          entry: { ...entry(), license: { id, verified: true }, tags: [], modified: false },
        },
        {},
        "library/x.wav",
      );
      expect(credit.terms).toBeUndefined();
    },
  );

  test("toCreditProvider does not find inherited keys", () => {
    expect(toCreditProvider("constructor", {}).license?.terms).toBeUndefined();
  });

  test("a __proto__ key in the registry is an own entry, not a prototype", () => {
    const parsed = LicenseRegistrySchema.safeParse(
      JSON.parse(`{"__proto__": ${JSON.stringify(CC0)}}`),
    );
    expect(parsed.success).toBe(false);
    expect(({} as Record<string, unknown>).name).toBeUndefined();
  });

  test("an unknown template placeholder such as {{constructor}} expands to nothing", () => {
    expect(buildCreditsText(credits(), "Thanks {{constructor}}\nEnd\n")).toBe("End\n");
  });
});

describe("provider licenses (P2-1)", () => {
  const elevenTerms: LicenseTerms = {
    name: "ElevenLabs generated output",
    url: "https://elevenlabs.io/terms-of-use",
    attribution: "none",
    commercialUse: "conditional",
    modification: "allowed",
    shareAlike: false,
  };

  function withProviders(...providers: CreditProvider[]): Credits {
    return { version: 1, entries: [], providers };
  }

  test("toCreditProvider copies generated-<providerId> from the registry", () => {
    const registry = {
      "generated-elevenlabs": { ...elevenTerms, approvedFor: "commercial" as const },
    };
    expect(toCreditProvider("elevenlabs", registry, { kinds: ["voice"] })).toEqual({
      id: "elevenlabs",
      kinds: ["voice"],
      license: {
        id: "generated-elevenlabs",
        terms: registry["generated-elevenlabs"],
        approvedFor: "commercial",
      },
    });
    expect(toCreditProvider("other", registry)).toEqual({
      id: "other",
      kinds: [],
      license: { id: "generated-other" },
    });
  });

  test("conditional provider terms follow the commercialUse row", () => {
    const p = toCreditProvider("elevenlabs", { "generated-elevenlabs": elevenTerms });
    expect(allOutcomes(withProviders(p))).toEqual([
      "ok",
      "commercial-conditional:warning",
      "commercial-conditional:error",
    ]);
    const issue = checkProjectLicenses(withProviders(p), "commercial")[0];
    expect(issue).toMatchObject({ target: "provider", id: "elevenlabs" });
  });

  test("approvedFor on the registry record lifts the commercial error", () => {
    const registry = {
      "generated-elevenlabs": { ...elevenTerms, approvedFor: "commercial" as const },
    };
    const p = toCreditProvider("elevenlabs", registry);
    expect(allOutcomes(withProviders(p))).toEqual(["ok", "commercial-conditional:warning", "ok"]);
  });

  test("forbidden commercial use is an error for commercial use", () => {
    const p = toCreditProvider("free", {
      "generated-free": { ...elevenTerms, commercialUse: "forbidden" },
    });
    expect(allOutcomes(withProviders(p))).toEqual(["ok", "ok", "commercial-forbidden:error"]);
  });

  test("a provider without a registry license is unknown on every term", () => {
    const expected = [
      "attribution-missing:warning",
      "commercial-conditional:warning,attribution-missing:error",
      "commercial-conditional:error,attribution-missing:error",
    ];
    expect(allOutcomes(withProviders(toCreditProvider("elevenlabs", {})))).toEqual(expected);
    // Also with no license field at all, and approvedFor cannot apply without terms.
    expect(allOutcomes(withProviders({ id: "elevenlabs", kinds: [] }))).toEqual(expected);
    const forged: CreditProvider = {
      id: "elevenlabs",
      kinds: [],
      license: { id: "generated-elevenlabs", approvedFor: "commercial", attribution: "x" },
    };
    expect(allOutcomes(withProviders(forged))).toEqual([
      "ok",
      "commercial-conditional:warning",
      "commercial-conditional:error",
    ]);
  });

  test("required provider attribution needs attributionText, and goes into credits", () => {
    const required = {
      ...elevenTerms,
      attribution: "required" as const,
      commercialUse: "allowed" as const,
    };
    const without = toCreditProvider("acme", { "generated-acme": required }, { name: "Acme" });
    expect(allOutcomes(withProviders(without))).toEqual([
      "attribution-missing:warning",
      "attribution-missing:error",
      "attribution-missing:error",
    ]);
    const withText = toCreditProvider(
      "acme",
      { "generated-acme": { ...required, attributionText: "Voices by Acme AI" } },
      { name: "Acme" },
    );
    expect(allOutcomes(withProviders(withText))).toEqual(["ok", "ok", "ok"]);
    expect(buildCreditsText(withProviders(withText))).toBe(
      "Sounds:\nVoices by Acme AI\n\nGenerated with: Acme\n",
    );
  });

  test("the mock provider is exempt", () => {
    expect(allOutcomes(withProviders({ id: "mock", kinds: ["voice"] }))).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
  });

  test("attributionText and approvedFor are allowed only on generated-* licenses", () => {
    expect(
      LicenseRegistrySchema.safeParse({ "CC0-1.0": { ...CC0, approvedFor: "commercial" } }).success,
    ).toBe(false);
    expect(
      LicenseRegistrySchema.safeParse({ "site-x": { ...CC0, attributionText: "x" } }).success,
    ).toBe(false);
    expect(
      LicenseRegistrySchema.safeParse({
        "generated-x": { ...CC0, attributionText: "x", approvedFor: "commercial" },
      }).success,
    ).toBe(true);
  });
});

describe("URLs (P3)", () => {
  test.each(["example.com/terms", "javascript:alert(1)", "ftp://example.com/x", "https://", "x"])(
    "rejects %j",
    (url) => {
      expect(LicenseRegistrySchema.safeParse({ a: { ...CC0, url } }).success).toBe(false);
      const e = { ...entry(), source: { type: "downloaded", url } };
      expect(CreditEntrySchema.safeParse(e).success).toBe(false);
    },
  );

  test("accepts http and https", () => {
    for (const url of ["http://example.com/a", "HTTPS://example.com/b?c=1"]) {
      expect(LicenseRegistrySchema.safeParse({ a: { ...CC0, url } }).success).toBe(true);
    }
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

import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { stringify } from "yaml";
import { type Issue, parseScenario, type ScenarioInput } from "./index.js";

const samplePath = new URL("../fixtures/sample.yaml", import.meta.url);

function minimal(): ScenarioInput & Record<string, unknown> {
  return {
    version: 1,
    title: "Test",
    speakers: [{ id: "mira", name: "Mira", voice: { provider: "mock", voiceId: "v1" } }],
    images: [{ id: "shore", file: "images/shore.png" }],
    scenes: [
      {
        id: "s1",
        items: [
          { image: "shore" },
          { line: "Hello", id: "l1", speaker: "mira" },
          { sfx: "waves", id: "x1" },
          { pause: 1 },
        ],
      },
    ],
  };
}

// Applies `mutate` to the minimal scenario and returns the error issues.
// biome-ignore lint/suspicious/noExplicitAny: tests reshape the data freely, including into invalid shapes.
function errorsAfter(mutate: (s: Record<string, any>) => void): Issue[] {
  const data = minimal();
  mutate(data);
  const result = parseScenario(stringify(data));
  const errors = result.issues.filter((i) => i.severity === "error");
  expect(result.scenario).toBeUndefined();
  return errors;
}

function expectError(issues: Issue[], path: (string | number)[], message: RegExp): void {
  expect(issues).toContainEqual({
    path,
    message: expect.stringMatching(message),
    severity: "error",
  });
}

describe("sample", () => {
  test("is valid and uses every item type and library reference", async () => {
    const { scenario, issues } = parseScenario(await readFile(samplePath, "utf8"));
    expect(issues).toEqual([]);
    expect(scenario).toBeDefined();
    const items = scenario?.scenes.flatMap((s) => s.items) ?? [];
    for (const kind of ["line", "sfx", "pause", "image"]) {
      expect(items.some((item) => kind in item)).toBe(true);
    }
    expect(items).toContainEqual(expect.objectContaining({ sfx: "waves on rocks" }));
    expect(items).toContainEqual(
      expect.objectContaining({ sfx: { library: "door-creak-wood-01" } }),
    );
    expect(scenario?.scenes.map((s) => s.bgm)).toEqual([
      { prompt: "quiet piano, rain", volume: 0.3 },
      { library: "ambient-hum-low", volume: 0.3 },
    ]);
  });
});

describe("minimal scenario", () => {
  test("is valid and gets defaults", () => {
    const { scenario, issues } = parseScenario(stringify(minimal()));
    expect(issues).toEqual([]);
    expect(scenario?.publish).toEqual({ use: "private" });
    const [image, line, sfx, pause] = scenario?.scenes[0]?.items ?? [];
    expect(line).toMatchObject({ take: 0, gapBeforeSec: 0.3 });
    expect(sfx).toMatchObject({ take: 0, gapBeforeSec: 0, overlap: false });
    expect(pause).toMatchObject({ gapBeforeSec: 0 });
    expect(image).toMatchObject({ gapBeforeSec: 0 });
  });

  test("speakers and images default to empty lists", () => {
    const data = minimal();
    delete data.speakers;
    delete data.images;
    data.scenes = [{ id: "s1", items: [{ pause: 1 }] }];
    const { scenario, issues } = parseScenario(stringify(data));
    expect(issues).toEqual([]);
    expect(scenario?.speakers).toEqual([]);
    expect(scenario?.images).toEqual([]);
  });

  test("accepts any provider settings", () => {
    const data = minimal();
    data.speakers = [
      {
        id: "mira",
        name: "Mira",
        voice: { provider: "x", voiceId: "y", settings: { anything: { nested: [1, 2] } } },
      },
    ];
    expect(parseScenario(stringify(data)).issues).toEqual([]);
  });
});

describe("rule: scenes, lines, and SFX have unique IDs", () => {
  test("missing scene id", () => {
    expectError(
      errorsAfter((s) => delete s.scenes[0].id),
      ["scenes", 0, "id"],
      /Missing/,
    );
  });

  test("missing line id", () => {
    expectError(
      errorsAfter((s) => delete s.scenes[0].items[1].id),
      ["scenes", 0, "items", 1, "id"],
      /Missing required field "id"/,
    );
  });

  test("missing sfx id", () => {
    expectError(
      errorsAfter((s) => delete s.scenes[0].items[2].id),
      ["scenes", 0, "items", 2, "id"],
      /Missing required field "id"/,
    );
  });

  test("duplicate line id", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[2].id = "l1";
      }),
      ["scenes", 0, "items", 2, "id"],
      /Duplicate .* id "l1", first used at scenes.0.items.1.id/,
    );
  });

  test("item id that duplicates a scene id in another scene", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes.push({ id: "s2", items: [{ line: "Hi", id: "s1", speaker: "mira" }] });
      }),
      ["scenes", 1, "items", 0, "id"],
      /Duplicate .* id "s1"/,
    );
  });

  test("duplicate speaker id", () => {
    expectError(
      errorsAfter((s) => {
        s.speakers.push({ ...s.speakers[0] });
      }),
      ["speakers", 1, "id"],
      /Duplicate speaker id "mira"/,
    );
  });

  test("duplicate image id", () => {
    expectError(
      errorsAfter((s) => {
        s.images.push({ ...s.images[0] });
      }),
      ["images", 1, "id"],
      /Duplicate image id "shore"/,
    );
  });

  test("id that is not a slug", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[1].id = "has space";
      }),
      ["scenes", 0, "items", 1, "id"],
      /ID must/,
    );
  });
});

describe("rule: an item is exactly one of line, sfx, pause, or image", () => {
  test("item with two kinds", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[1].sfx = "waves";
      }),
      ["scenes", 0, "items", 1],
      /exactly one .* but has line, sfx/,
    );
  });

  test("item with no kind", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items.push({ id: "x" });
      }),
      ["scenes", 0, "items", 4],
      /exactly one of line, sfx, pause, or image$/,
    );
  });

  test("errors inside an item point at the field", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[3].pause = -1;
      }),
      ["scenes", 0, "items", 3, "pause"],
      /.+/,
    );
  });
});

describe("rule: references resolve", () => {
  test("unknown speaker", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[1].speaker = "nobody";
      }),
      ["scenes", 0, "items", 1, "speaker"],
      /Unknown speaker "nobody"/,
    );
  });

  test("unknown image", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[0].image = "nowhere";
      }),
      ["scenes", 0, "items", 0, "image"],
      /Unknown image "nowhere"/,
    );
  });

  test("references are checked even when the schema fails elsewhere", () => {
    const issues = errorsAfter((s) => {
      s.title = 5;
      s.scenes[0].items[1].speaker = "nobody";
    });
    expectError(issues, ["title"], /.+/);
    expectError(issues, ["scenes", 0, "items", 1, "speaker"], /Unknown speaker/);
  });
});

describe("rule: SFX and BGM sources", () => {
  test("sfx library reference is accepted", () => {
    const data = minimal();
    (data.scenes[0]?.items[2] as Record<string, unknown>).sfx = { library: "door-01" };
    expect(parseScenario(stringify(data)).issues).toEqual([]);
  });

  test("sfx object without library", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[2].sfx = { prompt: "waves" };
      }),
      ["scenes", 0, "items", 2, "sfx", "prompt"],
      /Unknown key "prompt"/,
    );
  });

  test("sfx of the wrong type", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[2].sfx = 3;
      }),
      ["scenes", 0, "items", 2, "sfx"],
      /prompt string or \{ library/,
    );
  });

  test("bgm with both prompt and library", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].bgm = { prompt: "piano", library: "hum" };
      }),
      ["scenes", 0, "bgm"],
      /exactly one of prompt or library/,
    );
  });

  test("bgm with neither prompt nor library", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].bgm = { volume: 0.5 };
      }),
      ["scenes", 0, "bgm"],
      /exactly one of prompt or library/,
    );
  });

  test("bgm volume above 1", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].bgm = { prompt: "piano", volume: 1.5 };
      }),
      ["scenes", 0, "bgm", "volume"],
      /.+/,
    );
  });
});

describe("rule: image files are portable paths inside assets/", () => {
  test.each(["images/shore.png", "shore.png", "a/b/c d.png", ".hidden.png"])(
    "accepts %s",
    (file) => {
      const data = minimal();
      data.images = [{ id: "shore", file }];
      expect(parseScenario(stringify(data)).issues).toEqual([]);
    },
  );

  test.each([
    "/etc/passwd",
    "../outside.png",
    "images/../../x.png",
    "./x.png",
    "images/./x.png",
    "images//x.png",
    "images/",
    "C:\\x.png",
    "C:/x.png",
    "images\\x.png",
    "",
  ])("rejects %j", (file) => {
    const errors = errorsAfter((s) => {
      s.images = [{ id: "shore", file }];
    });
    expectError(errors, ["images", 0, "file"], /relative to assets/);
  });
});

describe("rule: take is a non-negative integer", () => {
  test("negative take", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[1].take = -1;
      }),
      ["scenes", 0, "items", 1, "take"],
      /.+/,
    );
  });

  test("fractional take", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[2].take = 1.5;
      }),
      ["scenes", 0, "items", 2, "take"],
      /.+/,
    );
  });
});

describe("rule: gapBeforeSec is at least -1.0", () => {
  test("negative gap down to -1 is allowed", () => {
    const data = minimal();
    (data.scenes[0]?.items[1] as Record<string, unknown>).gapBeforeSec = -1;
    expect(parseScenario(stringify(data)).issues).toEqual([]);
  });

  test("gap below -1", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[1].gapBeforeSec = -1.5;
      }),
      ["scenes", 0, "items", 1, "gapBeforeSec"],
      /.+/,
    );
  });
});

describe("rule: unknown keys are errors", () => {
  test("at the root", () => {
    expectError(
      errorsAfter((s) => {
        s.titel = "typo";
      }),
      ["titel"],
      /Unknown key "titel"/,
    );
  });

  test("in an item", () => {
    expectError(
      errorsAfter((s) => {
        s.scenes[0].items[1].speeker = "mira";
      }),
      ["scenes", 0, "items", 1, "speeker"],
      /Unknown key "speeker"/,
    );
  });

  test("in a voice", () => {
    expectError(
      errorsAfter((s) => {
        s.speakers[0].voice.stability = 0.4;
      }),
      ["speakers", 0, "voice", "stability"],
      /Unknown key/,
    );
  });

  test("in publish", () => {
    expectError(
      errorsAfter((s) => {
        s.publish = { use: "private", region: "jp" };
      }),
      ["publish", "region"],
      /Unknown key/,
    );
  });
});

describe("other checks", () => {
  test("unsupported version", () => {
    expectError(
      errorsAfter((s) => {
        s.version = 2;
      }),
      ["version"],
      /.+/,
    );
  });

  test("invalid publish.use", () => {
    expectError(
      errorsAfter((s) => {
        s.publish = { use: "public" };
      }),
      ["publish", "use"],
      /.+/,
    );
  });

  test("YAML syntax error", () => {
    const { scenario, issues } = parseScenario("version: 1\ntitle: [unclosed\n");
    expect(scenario).toBeUndefined();
    expect(issues[0]).toMatchObject({ path: [], severity: "error" });
  });

  test("YAML that is not a mapping", () => {
    const { scenario, issues } = parseScenario("- just a list\n");
    expect(scenario).toBeUndefined();
    expect(issues).toContainEqual(expect.objectContaining({ path: [], severity: "error" }));
  });
});

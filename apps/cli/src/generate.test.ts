import { rmSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CacheData, cacheKey } from "@vd-creator/core";
import {
  createMockProviders,
  MockMusicProvider,
  MockSfxProvider,
  MockTtsProvider,
} from "@vd-creator/providers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  gateProviders,
  PaidCallRefusedError,
  run,
} from "./index.js";

let tmp: string;
let dir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vd-cli-generate-"));
  dir = join(tmp, "drama");
  expect((await vd("init", dir)).code).toBe(EXIT_OK);
  // The template has one line. Add a BGM and an SFX so that every kind is generated.
  await editScenario((text) =>
    text
      .replace("    title: Opening\n", "    title: Opening\n    bgm:\n      prompt: Calm piano\n")
      .concat("      - sfx: Door creaks\n        id: s1-sfx1\n"),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

function vd(...args: string[]) {
  return vdWatching(() => {}, ...args);
}

/** Runs vd and calls `onStdout` with each stdout line as it is printed. */
async function vdWatching(onStdout: (line: string) => void, ...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    {
      stdout: (line) => {
        stdout.push(line);
        onStdout(line);
      },
      stderr: (line) => stderr.push(line),
    },
    {},
  );
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

async function editScenario(edit: (text: string) => string) {
  const file = join(dir, "scenario.yaml");
  await writeFile(file, edit(await readFile(file, "utf8")));
}

async function readCache(): Promise<CacheData> {
  return JSON.parse(await readFile(join(dir, "cache.json"), "utf8"));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Spies on every mock provider call. */
function spyOnMock() {
  return [
    vi.spyOn(MockTtsProvider.prototype, "synthesize"),
    vi.spyOn(MockSfxProvider.prototype, "generate"),
    vi.spyOn(MockMusicProvider.prototype, "generate"),
  ];
}

const callCount = (spies: ReturnType<typeof spyOnMock>) =>
  spies.reduce((n, spy) => n + spy.mock.calls.length, 0);

describe("vd generate", () => {
  test("generates every item with the mock and writes cache.json and the assets", async () => {
    const spies = spyOnMock();
    const result = await vd("generate", dir);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(EXIT_OK);
    expect(callCount(spies)).toBe(3);
    expect(result.stdout).toContain("Plan with provider mock:");
    expect(result.stdout).toContain('generate    line "s1-l1"');
    expect(result.stdout).toContain("3 to generate, 0 cached, 0 unresolved, 0 invalid");
    expect(result.stdout).toContain("Generated 3 items, 0 failed");

    const cache = await readCache();
    expect(cache.version).toBe(1);
    const entries = Object.values(cache.entries);
    expect(entries.map((e) => e.kind).sort()).toEqual(["music", "sfx", "tts"]);
    for (const entry of entries) {
      expect(entry.providerId).toBe("mock");
      expect(entry.file).toMatch(/^(voice|sfx|bgm)\/[0-9a-f]{16}\.wav$/);
      const data = await readFile(join(dir, "assets", entry.file));
      expect(data.subarray(0, 4).toString("latin1")).toBe("RIFF");
    }
    for (const sub of ["voice", "sfx", "bgm"]) {
      expect(await readdir(join(dir, "assets", sub))).toHaveLength(1);
    }
  });

  test("a second run makes no provider calls", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const before = await readFile(join(dir, "cache.json"), "utf8");
    const spies = spyOnMock();
    const result = await vd("generate", dir);
    expect(result.code).toBe(EXIT_OK);
    expect(callCount(spies)).toBe(0);
    expect(result.stdout).toContain("0 to generate, 3 cached");
    expect(result.stdout).toContain("Nothing to generate.");
    expect(await readFile(join(dir, "cache.json"), "utf8")).toBe(before);
  });

  test("uses the mock even if a speaker names another provider", async () => {
    await editScenario((text) => text.replace("provider: mock", "provider: elevenlabs"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await vd("generate", dir);
    expect(result.code).toBe(EXIT_OK);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Object.values((await readCache()).entries).every((e) => e.providerId === "mock")).toBe(
      true,
    );
  });

  test("--dry-run prints the plan and generates nothing", async () => {
    const spies = spyOnMock();
    const result = await vd("generate", dir, "--dry-run");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("3 to generate");
    expect(result.stdout).toContain("Estimated cost: ");
    expect(callCount(spies)).toBe(0);
    expect(await exists(join(dir, "cache.json"))).toBe(false);
    expect(await readdir(join(dir, "assets"))).toEqual([]);
  });

  test("--only generates only the named items", async () => {
    const result = await vd("generate", dir, "--only", "s1-l1,s1");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).not.toContain("s1-sfx1");
    const kinds = Object.values((await readCache()).entries).map((e) => e.kind);
    expect(kinds.sort()).toEqual(["music", "tts"]);
  });

  test("--only with an unknown ID fails before the plan", async () => {
    const result = await vd("generate", dir, "--only", "nope");
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe('vd generate: no item to generate has the ID "nope"');
    expect(result.stdout).toBe("");
  });

  test("--provider elevenlabs without --yes prints the plan and sends no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await vd("generate", dir, "--provider", "elevenlabs");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("Plan with provider elevenlabs:");
    // The line "Once upon a time..." has 19 characters; SFX and music count only requests.
    expect(result.stdout).toContain("Estimated cost: 19 characters, 3 requests");
    expect(result.stdout).toContain("--yes");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await exists(join(dir, "cache.json"))).toBe(false);
  });

  test("--provider elevenlabs with --dry-run and --yes still sends no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await vd("generate", dir, "--provider", "elevenlabs", "--dry-run", "--yes");
    expect(result.code).toBe(EXIT_OK);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("prints each failed item by kind and ID, without its text or the key, and exits 1", async () => {
    const key = "test-key-0123456789-abcdefghij";
    vi.stubEnv("ELEVENLABS_API_KEY", key);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: { status: "quota_exceeded", message: key } }), {
          status: 401,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await vd("generate", dir, "--provider", "elevenlabs", "--yes");
    expect(result.code).toBe(EXIT_FAILURE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.stderr.split("\n").sort()).toEqual([
      'vd generate: failed bgm "s1" (quota_exceeded, HTTP 401)',
      'vd generate: failed line "s1-l1" (quota_exceeded, HTTP 401)',
      'vd generate: failed sfx "s1-sfx1" (quota_exceeded, HTTP 401)',
    ]);
    const all = `${result.stdout}\n${result.stderr}`;
    for (const secret of [key, "Once upon", "Door creaks", "Calm piano"]) {
      expect(all).not.toContain(secret);
    }
  });

  test("fails like vd validate on an invalid scenario, before any plan", async () => {
    await editScenario((text) => text.replace("speaker: narrator", "speaker: nobody"));
    const spies = spyOnMock();
    const result = await vd("generate", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe('scenes.0.items.0.speaker: Unknown speaker "nobody"');
    expect(callCount(spies)).toBe(0);
  });

  test("reports a broken cache.json without its content", async () => {
    await writeFile(join(dir, "cache.json"), '{"version": 1, "entries": {"/secret/path": {}}}');
    const result = await vd("generate", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(`vd generate: cache.json in ${dir} is not a valid cache`);
  });

  test("rejects bad usage", async () => {
    expect((await vd("generate", dir, "--provider", "nope")).code).toBe(EXIT_USAGE);
    expect((await vd("generate", dir, "extra")).code).toBe(EXIT_USAGE);
    expect((await vd("generate", dir, "--only", "a,,b")).code).toBe(EXIT_USAGE);
    expect((await vd("generate", dir, "--bogus")).code).toBe(EXIT_USAGE);
    expect((await vd("validate", dir, "--yes")).code).toBe(EXIT_USAGE);
    expect((await vd("clean", dir, "--yes")).code).toBe(EXIT_USAGE);
  });
});

describe("vd clean", () => {
  test("removes orphaned assets and cache entries and keeps referenced ones", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const first = await readCache();
    const oldLine = Object.values(first.entries).find((e) => e.kind === "tts");
    // Changing the line orphans its old asset.
    await editScenario((text) => text.replace("Once upon a time...", "Long ago..."));
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    const second = await readCache();
    expect(Object.keys(second.entries)).toHaveLength(4);

    // An asset of the current line from another provider is still used for playback.
    const current = Object.values(second.entries).find(
      (e) => e.kind === "tts" && e.file !== oldLine?.file,
    );
    if (!current || !oldLine) throw new Error("missing entries");
    const otherKey = cacheKey("tts", "elevenlabs", current.request);
    const otherFile = `voice/${otherKey.slice(0, 16)}.mp3`;
    second.entries[otherKey] = { ...current, providerId: "elevenlabs", file: otherFile };
    await writeFile(join(dir, "cache.json"), JSON.stringify(second));
    await writeFile(join(dir, "assets", otherFile), "mp3");
    // Files outside the cache, and other folders under assets/.
    await writeFile(join(dir, "assets", "sfx", "stray.wav"), "stray");
    await mkdir(join(dir, "assets", "images"));
    await writeFile(join(dir, "assets", "images", "cover.png"), "png");
    await mkdir(join(dir, "assets", "library"));
    await writeFile(join(dir, "assets", "library", "rain.wav"), "rain");

    const dry = await vd("clean", dir, "--dry-run");
    expect(dry.code).toBe(EXIT_OK);
    expect(dry.stdout.split("\n")).toEqual([
      `Would remove assets/sfx/stray.wav`,
      `Would remove assets/${oldLine.file}`,
      "Would remove 2 files and 1 cache entry",
    ]);
    expect(await exists(join(dir, "assets", oldLine.file))).toBe(true);
    expect(Object.keys((await readCache()).entries)).toHaveLength(5);

    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("Removed 2 files and 1 cache entry");
    expect(await exists(join(dir, "assets", oldLine.file))).toBe(false);
    expect(await exists(join(dir, "assets", "sfx", "stray.wav"))).toBe(false);
    expect(await exists(join(dir, "assets", otherFile))).toBe(true);
    expect(await exists(join(dir, "assets", "images", "cover.png"))).toBe(true);
    expect(await exists(join(dir, "assets", "library", "rain.wav"))).toBe(true);
    const after = await readCache();
    expect(Object.keys(after.entries)).toHaveLength(4);
    for (const entry of Object.values(after.entries)) {
      expect(await exists(join(dir, "assets", entry.file))).toBe(true);
    }

    // Everything the scenario uses is still cached.
    const spies = spyOnMock();
    expect((await vd("generate", dir)).stdout).toContain("Nothing to generate.");
    expect(callCount(spies)).toBe(0);
    expect((await vd("clean", dir)).stdout).toBe("Removed 0 files and 0 cache entries");
  });

  test("fails like vd validate on an invalid scenario and removes nothing", async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    await editScenario((text) => text.replace("version: 1", "version: 9"));
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toMatch(/^version: /);
    expect(Object.keys((await readCache()).entries)).toHaveLength(3);
  });
});

describe("vd generate with a paid provider", () => {
  const API_KEY = "test-key-0123456789-abcdefghij";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("ELEVENLABS_API_KEY", API_KEY);
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: { status: "quota_exceeded" } }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  /** Adds a line whose speaker settings hold a non-finite number, so its request is invalid. */
  async function addInvalidLine() {
    await editScenario((text) =>
      text
        .replace(
          "scenes:\n",
          "  - id: odd\n    name: Odd\n    voice:\n      provider: mock\n      voiceId: odd\n      settings:\n        speed: .inf\nscenes:\n",
        )
        .concat('      - line: "Strange."\n        id: s1-l2\n        speaker: odd\n'),
    );
  }

  /**
   * Generates with the mock, then copies the assets of the given kinds as if ElevenLabs had made
   * them. Returns the copied asset paths by kind.
   */
  async function cacheAsElevenLabs(kinds: string[]): Promise<Record<string, string>> {
    await vd("generate", dir);
    const cache = await readCache();
    const paths: Record<string, string> = {};
    for (const entry of Object.values(cache.entries)) {
      if (!kinds.includes(entry.kind)) continue;
      const key = cacheKey(entry.kind, "elevenlabs", entry.request);
      const file = `${entry.file.split("/")[0]}/${key.slice(0, 16)}.mp3`;
      cache.entries[key] = { ...entry, providerId: "elevenlabs", file };
      paths[entry.kind] = join(dir, "assets", file);
      await writeFile(paths[entry.kind] as string, "mp3");
    }
    await writeFile(join(dir, "cache.json"), JSON.stringify(cache));
    return paths;
  }

  /** Removes `path` right after the plan is printed, before any generation. */
  const removeAfterPlan = (path: string) => (line: string) => {
    if (line.startsWith("Estimated cost")) rmSync(path);
  };

  test("never requests without --yes when the plan has only cached and invalid items", async () => {
    await addInvalidLine();
    const paths = await cacheAsElevenLabs(["tts", "sfx", "music"]);
    const result = await vdWatching(
      removeAfterPlan(paths.tts as string),
      "generate",
      dir,
      "--provider",
      "elevenlabs",
    );
    expect(result.stdout).toContain("0 to generate, 3 cached, 0 unresolved, 1 invalid");
    expect(result.code).toBe(EXIT_OK);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    [["generate", "DIR", "--provider", "elevenlabs"]],
    [["generate", "--provider", "elevenlabs", "DIR"]],
    [["generate", "--provider=elevenlabs", "DIR"]],
    [["generate", "DIR", "--provider", "elevenlabs", "--only", "s1-l1,s1-l2"]],
    [["generate", "--dry-run", "--provider", "elevenlabs", "DIR"]],
    [["generate", "--yes", "--dry-run", "DIR", "--provider", "elevenlabs"]],
    [["generate", "DIR", "--provider", "elevenlabs", "--dry-run", "--yes"]],
  ])("never calls fetch without --yes or with --dry-run: %j", async (args) => {
    await addInvalidLine();
    const paths = await cacheAsElevenLabs(["tts", "sfx", "music"]);
    const result = await vdWatching(
      removeAfterPlan(paths.tts as string),
      ...args.map((arg) => (arg === "DIR" ? dir : arg)),
    );
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("Plan with provider elevenlabs:");
    expect(result.stdout).not.toContain("Generated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("with --yes generates only the items the plan showed as to-generate", async () => {
    const paths = await cacheAsElevenLabs(["tts", "music"]);
    const result = await vdWatching(
      removeAfterPlan(paths.tts as string),
      "generate",
      dir,
      "--provider",
      "elevenlabs",
      "--yes",
    );
    expect(result.stdout).toContain("1 to generate, 2 cached");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/sound-generation");
    expect(result.stderr).toBe('vd generate: failed sfx "s1-sfx1" (quota_exceeded, HTTP 401)');
    expect(result.code).toBe(EXIT_FAILURE);
  });

  test("gateProviders refuses a paid call before the provider runs", async () => {
    const mock = createMockProviders();
    const synthesize = vi.fn(() => mock.tts.synthesize({ text: "x", voiceId: "v", take: 0 }));
    const paidTts = {
      ...mock.tts,
      id: "paid",
      paid: true,
      estimate: mock.tts.estimate,
      synthesize,
    };
    const gated = gateProviders({ ...mock, tts: paidTts }, false);
    await expect(gated.tts.synthesize({ text: "x", voiceId: "v", take: 0 })).rejects.toBeInstanceOf(
      PaidCallRefusedError,
    );
    expect(synthesize).not.toHaveBeenCalled();
    // An unpaid provider and estimates still work.
    expect((await gated.sfx.generate({ prompt: "x", take: 0 })).format).toBe("wav");
    expect(gated.tts.estimate({ text: "abc", voiceId: "v", take: 0 }).requests).toBe(1);
    expect(gateProviders({ ...mock, tts: paidTts }, true).tts).toBe(paidTts);
  });
});

describe("vd clean with symbolic links", () => {
  let outside: string;

  beforeEach(async () => {
    expect((await vd("generate", dir)).code).toBe(EXIT_OK);
    outside = join(tmp, "outside");
  });

  test("refuses a symlinked assets/voice and deletes nothing outside", async () => {
    await rename(join(dir, "assets", "voice"), outside);
    await symlink(outside, join(dir, "assets", "voice"));
    await writeFile(join(outside, "stray.wav"), "keep me");
    const before = await readdir(outside);
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd clean: refusing to clean ${dir}: assets/voice is a symbolic link or not a folder`,
    );
    expect(await readdir(outside)).toEqual(before);
    expect(Object.keys((await readCache()).entries)).toHaveLength(3);
  });

  test("refuses a symlinked assets/ and deletes nothing outside", async () => {
    await rename(join(dir, "assets"), outside);
    await symlink(outside, join(dir, "assets"));
    await writeFile(join(outside, "sfx", "stray.wav"), "keep me");
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd clean: refusing to clean ${dir}: assets is a symbolic link or not a folder`,
    );
    expect(await exists(join(outside, "sfx", "stray.wav"))).toBe(true);
  });

  test("skips a symlink inside assets/voice that points outside", async () => {
    await writeFile(outside, "keep me");
    const link = join(dir, "assets", "voice", "link.wav");
    await symlink(outside, link);
    await writeFile(join(dir, "assets", "voice", "stray.wav"), "stray");
    const result = await vd("clean", dir);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(
      "Removed assets/voice/stray.wav\nRemoved 1 file and 0 cache entries",
    );
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("keep me");
  });
});

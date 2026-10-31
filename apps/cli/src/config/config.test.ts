// The user directory and config.yaml. Every test uses temporary folders for VD_USER_DIR,
// XDG_CONFIG_HOME, HOME, and the repository, so the real home folder is never read.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScenario } from "@vd-creator/scenario";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from "../cli.js";
import {
  AGENTS_TEMPLATE,
  CONFIG_TEMPLATE,
  ConfigError,
  ConfigInitError,
  type Env,
  expandPath,
  findUserDir,
  initUserDir,
  loadConfig,
  parseUserConfig,
  REPO_ROOT,
  resolveSettings,
} from "./index.js";

let tmp: string;
/** Stands in for the repository; its local/ is a candidate. */
let repo: string;
let home: string;
let xdg: string;
let userDir: string;
let local: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vd-cli-config-"));
  repo = join(tmp, "repo");
  home = join(tmp, "home");
  xdg = join(tmp, "xdg");
  userDir = join(tmp, "user");
  local = join(repo, "local");
  await mkdir(repo);
  await mkdir(home);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function vd(env: Env, ...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    args,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    env,
    { repoRoot: repo },
  );
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** The environment of a test: HOME is always a temporary folder. */
function envWith(extra: Env = {}): Env {
  return { HOME: home, ...extra };
}

async function writeConfig(dir: string, text: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yaml"), text);
}

describe("location rules", () => {
  test("VD_USER_DIR comes first, even when local/ and XDG_CONFIG_HOME exist", async () => {
    for (const dir of [userDir, local, join(xdg, "vd-creator")])
      await mkdir(dir, { recursive: true });
    const search = await findUserDir({
      env: envWith({ VD_USER_DIR: userDir, XDG_CONFIG_HOME: xdg }),
      repoRoot: repo,
    });
    expect(search.found).toEqual({ dir: userDir, rule: "VD_USER_DIR" });
    expect(search.candidates.map((c) => c.rule)).toEqual([
      "VD_USER_DIR",
      "local",
      "XDG_CONFIG_HOME",
    ]);
  });

  test("local/ comes second, before XDG_CONFIG_HOME", async () => {
    for (const dir of [local, join(xdg, "vd-creator")]) await mkdir(dir, { recursive: true });
    const search = await findUserDir({ env: envWith({ XDG_CONFIG_HOME: xdg }), repoRoot: repo });
    expect(search.found).toEqual({ dir: local, rule: "local" });
  });

  test("local/ may be a symbolic link to a folder elsewhere", async () => {
    await mkdir(userDir);
    await symlink(userDir, local);
    const search = await findUserDir({ env: envWith(), repoRoot: repo });
    expect(search.found).toEqual({ dir: local, rule: "local" });
  });

  test("a file named local is not a user directory", async () => {
    await writeFile(local, "");
    const search = await findUserDir({ env: envWith(), repoRoot: repo });
    expect(search.found).toBeUndefined();
  });

  test("a VD_USER_DIR that is not a folder is skipped with a note", async () => {
    await mkdir(local);
    const env = envWith({ VD_USER_DIR: join(tmp, "missing") });
    const search = await findUserDir({ env, repoRoot: repo });
    expect(search.found).toEqual({ dir: local, rule: "local" });
    expect(search.userDirEnvSkipped).toBe(true);
    const result = await vd(env, "config", "path");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(`${local}\nSelected by local/ at the repository root`);
    expect(result.stderr).toContain("VD_USER_DIR is set, but it is not a folder");
  });

  test("XDG_CONFIG_HOME comes third, and ~/.config is then not checked", async () => {
    await mkdir(join(xdg, "vd-creator"), { recursive: true });
    await mkdir(join(home, ".config", "vd-creator"), { recursive: true });
    const search = await findUserDir({ env: envWith({ XDG_CONFIG_HOME: xdg }), repoRoot: repo });
    expect(search.found).toEqual({ dir: join(xdg, "vd-creator"), rule: "XDG_CONFIG_HOME" });
    expect(search.candidates.map((c) => c.rule)).toEqual(["local", "XDG_CONFIG_HOME"]);
  });

  test("~/.config/vd-creator is used when XDG_CONFIG_HOME is not set", async () => {
    await mkdir(join(home, ".config", "vd-creator"), { recursive: true });
    const search = await findUserDir({ env: envWith(), repoRoot: repo });
    expect(search.found).toEqual({ dir: join(home, ".config", "vd-creator"), rule: "HOME" });
  });

  test("without HOME or XDG_CONFIG_HOME, only VD_USER_DIR and local/ are checked", async () => {
    const search = await findUserDir({ env: {}, repoRoot: repo });
    expect(search.candidates.map((c) => c.rule)).toEqual(["local"]);
  });

  test("vd config path prints the folder and its rule, or that there is none", async () => {
    let result = await vd(envWith(), "config", "path");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(
      `No user directory; vd uses its built-in defaults. Checked, in order:\n  ${local}\n  ${join(home, ".config", "vd-creator")}`,
    );
    await mkdir(userDir);
    result = await vd(envWith({ VD_USER_DIR: userDir }), "config", "path");
    expect(result.stdout).toBe(`${userDir}\nSelected by the VD_USER_DIR environment variable`);
  });

  test("REPO_ROOT is the root of this repository", () => {
    expect(existsSync(join(REPO_ROOT, "apps", "cli", "package.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "AGENTS.md"))).toBe(true);
  });
});

describe("precedence", () => {
  test("a flag wins over the environment, which wins over config.yaml, then the default", async () => {
    await writeConfig(userDir, "version: 1\nlibrary: from-file\n");
    const base = { VD_USER_DIR: userDir };
    const cwd = join(tmp, "cwd");
    const library = async (env: Env, flags = {}) =>
      (await loadConfig({ env: envWith(env), repoRoot: repo, flags, cwd })).settings.library;

    expect(await library({ ...base, VD_LIBRARY: "from-env" }, { library: "from-flag" })).toEqual({
      value: join(cwd, "from-flag"),
      source: "flag",
    });
    expect(await library({ ...base, VD_LIBRARY: "from-env" })).toEqual({
      value: join(cwd, "from-env"),
      source: "env",
    });
    // A relative path in config.yaml is relative to the user directory.
    expect(await library(base)).toEqual({ value: join(userDir, "from-file"), source: "file" });
    expect(await library({})).toEqual({ value: undefined, source: "default" });
  });

  test("an empty environment variable counts as not set", () => {
    const settings = resolveSettings({ env: { VD_LIBRARY: "" } });
    expect(settings.library.source).toBe("default");
  });

  test("every setting has a default", async () => {
    const { settings } = await loadConfig({ env: envWith(), repoRoot: repo });
    expect(settings).toEqual({
      library: { value: undefined, source: "default" },
      "serve.port": { value: 5310, source: "default" },
      "serve.host": { value: "127.0.0.1", source: "default" },
      "init.publishUse": { value: "private", source: "default" },
      "agent.command": { value: undefined, source: "default" },
      "agent.timeoutSec": { value: 120, source: "default" },
      "render.creditsTemplate": { value: undefined, source: "default" },
    });
  });

  test("vd config show prints each value and where it came from", async () => {
    await writeConfig(
      userDir,
      "version: 1\nserve:\n  port: 8080\ninit:\n  publishUse: commercial\nagent:\n  command: claude\n  timeoutSec: 60\nrender:\n  creditsTemplate: credits.txt\n",
    );
    const env = envWith({ VD_USER_DIR: userDir, VD_LIBRARY: "~/sounds" });
    const result = await vd(env, "config", "show");
    expect(result).toEqual({
      code: EXIT_OK,
      stderr: "",
      stdout: [
        `User directory: ${userDir} (the VD_USER_DIR environment variable)`,
        `Config file: ${join(userDir, "config.yaml")}`,
        `library: ${join(home, "sounds")} (environment variable VD_LIBRARY)`,
        "serve.port: 8080 (config.yaml)",
        "serve.host: 127.0.0.1 (default)",
        "init.publishUse: commercial (config.yaml)",
        "agent.command: claude (config.yaml)",
        "agent.timeoutSec: 60 (config.yaml)",
        `render.creditsTemplate: ${join(userDir, "credits.txt")} (config.yaml)`,
      ].join("\n"),
    });

    const json = JSON.parse((await vd(env, "config", "show", "--json")).stdout);
    expect(json).toEqual({
      userDir: { dir: userDir, rule: "VD_USER_DIR" },
      configFile: join(userDir, "config.yaml"),
      settings: {
        library: { value: join(home, "sounds"), source: "env", env: "VD_LIBRARY" },
        "serve.port": { value: 8080, source: "file" },
        "serve.host": { value: "127.0.0.1", source: "default" },
        "init.publishUse": { value: "commercial", source: "file" },
        "agent.command": { value: "claude", source: "file" },
        "agent.timeoutSec": { value: 60, source: "file" },
        "render.creditsTemplate": { value: join(userDir, "credits.txt"), source: "file" },
      },
    });
  });

  test("a user directory without config.yaml uses the defaults", async () => {
    await mkdir(userDir);
    const config = await loadConfig({ env: envWith({ VD_USER_DIR: userDir }), repoRoot: repo });
    expect(config.userDir).toEqual({ dir: userDir, rule: "VD_USER_DIR" });
    expect(config.file).toBeUndefined();
    expect(config.settings["serve.port"]).toEqual({ value: 5310, source: "default" });
  });
});

describe("~ expansion", () => {
  test("~ and ~/ expand to HOME from the environment", () => {
    expect(expandPath("~", "/base", { HOME: home })).toBe(home);
    expect(expandPath("~/sounds/lib", "/base", { HOME: home })).toBe(join(home, "sounds", "lib"));
  });

  test("other paths are not expanded", () => {
    expect(expandPath("~other", userDir, { HOME: home })).toBe(join(userDir, "~other"));
    expect(expandPath("sub/~", userDir, { HOME: home })).toBe(join(userDir, "sub", "~"));
    expect(expandPath(join(tmp, "abs"), userDir, { HOME: home })).toBe(join(tmp, "abs"));
  });

  test("~ in config.yaml expands, and fails clearly without HOME", async () => {
    await writeConfig(userDir, "version: 1\nlibrary: ~/sounds\n");
    const ok = await loadConfig({ env: envWith({ VD_USER_DIR: userDir }), repoRoot: repo });
    expect(ok.settings.library).toEqual({ value: join(home, "sounds"), source: "file" });
    await expect(loadConfig({ env: { VD_USER_DIR: userDir }, repoRoot: repo })).rejects.toThrow(
      "library: cannot expand ~ because HOME is not set",
    );
  });
});

describe("config.yaml schema", () => {
  const file = "config.yaml";
  const problems = (text: string) => {
    try {
      parseUserConfig(text, file);
    } catch (e) {
      if (e instanceof ConfigError) return e.problems;
      throw e;
    }
    return [];
  };

  test("an unknown key such as apiKey is rejected without printing its name or value", async () => {
    const text = "version: 1\napiKey: sk-secret-value\n";
    expect(problems(text)).toEqual(["unknown key at line 2"]);
    await writeConfig(userDir, text);
    const result = await vd(envWith({ VD_USER_DIR: userDir }), "config", "show");
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd config show: ${join(userDir, "config.yaml")}: unknown key at line 2`,
    );
    expect(result.stderr).not.toContain("sk-secret-value");
  });

  test("an unknown nested key, such as a typo or a provider, is rejected", () => {
    expect(problems("version: 1\nserve:\n  prot: 80\n")).toEqual([
      "unknown key in serve at line 3",
    ]);
    expect(problems("version: 1\nprovider: elevenlabs\n")).toEqual(["unknown key at line 2"]);
    // A key that is itself a secret is not printed either.
    expect(problems("version: 1\nsk-secret-value: 1\n")).toEqual(["unknown key at line 2"]);
  });

  test("wrong values are rejected by key, with fixed text", () => {
    expect(problems("version: 2\n")).toEqual(["version: must be 1"]);
    expect(problems("library: x\n")).toEqual(["version: must be 1"]);
    expect(problems("version: 1\nserve:\n  port: 70000\n")).toEqual([
      "serve.port: must be a whole number from 1 to 65535",
    ]);
    expect(problems("version: 1\ninit:\n  publishUse: sk-secret-value\n")).toEqual([
      "init.publishUse: must be one of private, non-commercial, commercial",
    ]);
    expect(problems("version: 1\nlibrary: ''\n")[0]).toMatch(/^library: /);
    expect(problems("- a list\n")[0]).toMatch(/^the top level: /);
    expect(problems("version: 1\nserve:\n  host: [sk-secret-value]\n")).toEqual([
      "serve.host: must be a host name or an IPv4 or IPv6 address",
    ]);
  });

  const PATH_RULE = "must be a path on one line of printable characters, at most 4096 long";
  const HOST_RULE = "must be a host name or an IPv4 or IPv6 address";
  const AGENT_RULE =
    "must be one of claude (codex is not supported: it cannot run without command execution)";
  const PUBLISH_RULE = "must be one of private, non-commercial, commercial";
  // Each string field, how to place a value in it, and the problem it gives.
  const STRING_FIELDS: [string, (value: string) => string, string][] = [
    ["library", (v) => `version: 1\nlibrary: ${v}\n`, `library: ${PATH_RULE}`],
    ["serve.host", (v) => `version: 1\nserve:\n  host: ${v}\n`, `serve.host: ${HOST_RULE}`],
    [
      "init.publishUse",
      (v) => `version: 1\ninit:\n  publishUse: ${v}\n`,
      `init.publishUse: ${PUBLISH_RULE}`,
    ],
    [
      "agent.command",
      (v) => `version: 1\nagent:\n  command: ${v}\n`,
      `agent.command: ${AGENT_RULE}`,
    ],
    [
      "render.creditsTemplate",
      (v) => `version: 1\nrender:\n  creditsTemplate: ${v}\n`,
      `render.creditsTemplate: ${PATH_RULE}`,
    ],
  ];
  // Values in YAML double quotes, so that the YAML escapes reach the value as the characters.
  const BAD_VALUES: [string, string][] = [
    ["a newline", '"sk-secret\\nvalue"'],
    ["a carriage return", '"sk-secret\\rvalue"'],
    ["a bell", '"sk-secret\\avalue"'],
    ["an escape", '"sk-secret\\evalue"'],
    ["a tab", '"sk-secret\\tvalue"'],
    ["a NUL", '"sk-secret\\0value"'],
    ["a line separator", '"sk-secret\\Lvalue"'],
    ["a paragraph separator", '"sk-secret\\Pvalue"'],
    ["a zero-width joiner", '"sk-secret\\u200dvalue"'],
    ["a right-to-left override", '"sk-secret\\u202evalue"'],
  ];
  const BAD_CASES = STRING_FIELDS.flatMap(([field, place, problem]) =>
    BAD_VALUES.map(([what, value]) => [field, what, place(value), problem] as const),
  );

  test.each(BAD_CASES)(
    "%s with %s is rejected, and vd config show does not print it",
    async (_field, _what, text, problem) => {
      expect(problems(text)).toEqual([problem]);
      await writeConfig(userDir, text);
      const env = envWith({ VD_USER_DIR: userDir });
      for (const args of [
        ["config", "show"],
        ["config", "show", "--json"],
      ]) {
        const result = await vd(env, ...args);
        expect(result.code).toBe(EXIT_FAILURE);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(`vd config show: ${join(userDir, "config.yaml")}: ${problem}`);
        expect(result.stderr).not.toContain("sk-secret");
      }
    },
  );

  test("a value that is too long, or not the narrowest shape, is rejected", () => {
    expect(problems(`version: 1\nlibrary: ${"a".repeat(4097)}\n`)).toEqual([
      `library: ${PATH_RULE}`,
    ]);
    expect(problems(`version: 1\nlibrary: ${"a".repeat(4096)}\n`)).toEqual([]);
    for (const host of ["sk-secret value", "http://example.com", "-bad", "a..b", "[::1]", "a:80"]) {
      expect(problems(`version: 1\nserve:\n  host: "${host}"\n`)).toEqual([
        `serve.host: ${HOST_RULE}`,
      ]);
    }
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "::1", "my-host.example.com"]) {
      expect(problems(`version: 1\nserve:\n  host: "${host}"\n`)).toEqual([]);
    }
    for (const port of ["0", "1.5", '"80"', "65536"]) {
      expect(problems(`version: 1\nserve:\n  port: ${port}\n`)).toEqual([
        "serve.port: must be a whole number from 1 to 65535",
      ]);
    }
  });

  test.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "a key named %s is unknown at the top level and in serve, and is not named",
    (key) => {
      expect(problems(`version: 1\n${key}: 1\n`)).toEqual(["unknown key at line 2"]);
      expect(problems(`version: 1\nserve:\n  ${key}: 1\n`)).toEqual([
        "unknown key in serve at line 3",
      ]);
      expect(problems(`version: 1\nserve:\n  ${key}:\n    port: 1\n`)).toEqual([
        "unknown key in serve at line 3",
      ]);
    },
  );

  test("a value from the environment must pass the schema too, and is not printed", async () => {
    await mkdir(userDir);
    for (const bad of ["sk-secret\nvalue", "sk-secret\u0007value", "sk-secret\u2028value"]) {
      const env = envWith({ VD_USER_DIR: userDir, VD_LIBRARY: bad });
      await expect(loadConfig({ env, repoRoot: repo })).rejects.toThrow(
        `library from VD_LIBRARY: ${PATH_RULE}`,
      );
      for (const args of [
        ["config", "show"],
        ["config", "show", "--json"],
      ]) {
        const result = await vd(env, ...args);
        expect(result.code).toBe(EXIT_FAILURE);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("sk-secret");
      }
    }
  });

  test("vd config show and path escape a control character in a folder from the environment", async () => {
    const odd = join(tmp, "odd\u001b[31mdir\u2028x");
    await mkdir(odd);
    for (const args of [
      ["config", "show"],
      ["config", "show", "--json"],
      ["config", "path"],
    ]) {
      const result = await vd(envWith({ VD_USER_DIR: odd }), ...args);
      expect(result.code).toBe(EXIT_OK);
      expect(result.stdout).not.toContain("\u001b");
      expect(result.stdout).not.toContain("\u2028");
      if (args.includes("--json")) {
        expect(JSON.parse(result.stdout).userDir.dir).toBe(odd);
      } else {
        expect(result.stdout).toContain("odd\\u{1b}[31mdir\\u{2028}x");
      }
    }
  });

  test("invalid YAML names the line but not the text", () => {
    expect(problems('version: 1\nlibrary: "sk-unclosed\n')).toEqual([
      expect.stringMatching(/^not valid YAML at line \d+$/),
    ]);
    expect(problems("version: 1\nlibrary: a\nlibrary: sk-secret-value\n")).toEqual([
      "not valid YAML at line 3",
    ]);
  });

  test.each([
    [
      "a collection key under an unknown key",
      "version: 1\napiKey: { [sk-secret-value]: ignored }\n",
      "unknown key at line 2",
    ],
    [
      "a collection key",
      "version: 1\nserve: { [sk-secret-value]: ignored }\n",
      "keys must be plain text at line 2",
    ],
    [
      "a complex key",
      "version: 1\n? [sk-secret-value]\n: x\n",
      "keys must be plain text at line 2",
    ],
    [
      "an anchor",
      "version: 1\nlibrary: &a sk-secret-value\n",
      "anchors and tags are not allowed at line 2",
    ],
    [
      "an alias",
      "version: 1\nserve: &s { host: sk-secret-value }\nrender: *s\n",
      "anchors and tags are not allowed at line 2",
    ],
    [
      "an unresolved alias",
      "version: 1\nlibrary: *sk-secret-value\n",
      "aliases are not allowed at line 2",
    ],
    [
      "a tag",
      "version: 1\nlibrary: !!str sk-secret-value\n",
      "anchors and tags are not allowed at line 2",
    ],
    [
      "a custom tag",
      "version: 1\nlibrary: !secret sk-secret-value\n",
      "unsupported YAML at line 2",
    ],
  ])("rejects %s without printing or warning its content", async (_, text, problem) => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(`${warning.name}: ${warning.message}`);
    process.on("warning", onWarning);
    try {
      expect(problems(text)).toContain(problem);
      await writeConfig(userDir, text);
      for (const debug of [{}, { VD_DEBUG: "1" }]) {
        const result = await vd(envWith({ VD_USER_DIR: userDir, ...debug }), "config", "show");
        expect(result.code).toBe(EXIT_FAILURE);
        expect(result.stderr).not.toContain("sk-secret-value");
        expect(result.stdout).not.toContain("sk-secret-value");
      }
      // process.emitWarning is asynchronous.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings.join("\n")).not.toContain("sk-secret-value");
  });

  test("an empty file has no settings", () => {
    expect(parseUserConfig("", file)).toEqual({ version: 1 });
    expect(parseUserConfig("# only comments\n", file)).toEqual({ version: 1 });
  });

  test("the template is valid, and so is every setting in it once uncommented", () => {
    expect(parseUserConfig(CONFIG_TEMPLATE, file)).toEqual({ version: 1 });
    const uncommented = CONFIG_TEMPLATE.replace(/^# (\w+:.*| {2}.*)$/gm, "$1");
    expect(parseUserConfig(uncommented, file)).toEqual({
      version: 1,
      library: "~/sounds/vd-library",
      serve: { port: 5310, host: "127.0.0.1" },
      init: { publishUse: "private" },
      agent: { command: "claude", timeoutSec: 120 },
      render: { creditsTemplate: "credits.template.txt" },
    });
  });
});

describe("the agent settings", () => {
  const read = (yaml: string) => parseUserConfig(`version: 1\n${yaml}`, "config.yaml");
  const problemsOf = (yaml: string): string[] => {
    try {
      read(yaml);
    } catch (e) {
      return (e as ConfigError).problems;
    }
    return [];
  };
  const AGENT_RULE =
    "must be one of claude (codex is not supported: it cannot run without command execution)";

  test("accept claude and a timeout from 10 to 600 seconds", () => {
    expect(read("agent:\n  command: claude\n").agent).toEqual({ command: "claude" });
    for (const timeoutSec of [10, 120, 600]) {
      expect(read(`agent:\n  command: claude\n  timeoutSec: ${timeoutSec}\n`).agent).toEqual({
        command: "claude",
        timeoutSec,
      });
    }
  });

  test("refuse codex with a clear message, and a timeout out of range", () => {
    expect(problemsOf("agent:\n  command: codex\n")).toEqual([`agent.command: ${AGENT_RULE}`]);
    for (const bad of ["9", "601", "1.5", "abc"]) {
      expect(problemsOf(`agent:\n  command: claude\n  timeoutSec: ${bad}\n`)).toEqual([
        "agent.timeoutSec: must be a whole number from 10 to 600",
      ]);
    }
    // The timeout means nothing without a command.
    expect(problemsOf("agent:\n  timeoutSec: 60\n")).toEqual([`agent.command: ${AGENT_RULE}`]);
  });
});

describe("vd init with a user config", () => {
  test("init.publishUse sets publish.use of the new scenario", async () => {
    await writeConfig(local, "version: 1\ninit:\n  publishUse: non-commercial\n");
    const project = join(tmp, "drama");
    expect((await vd(envWith(), "init", project)).code).toBe(EXIT_OK);
    const text = await readFile(join(project, "scenario.yaml"), "utf8");
    expect(parseScenario(text).scenario?.publish.use).toBe("non-commercial");
  });

  test("an invalid config.yaml stops vd init before it creates anything", async () => {
    await writeConfig(local, "version: 1\napiKey: secret\n");
    const project = join(tmp, "drama");
    const result = await vd(envWith(), "init", project);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(`vd init: ${join(local, "config.yaml")}: unknown key at line 2`);
    expect(existsSync(project)).toBe(false);
  });
});

describe("vd config init", () => {
  test("creates local/ at the repository root by default", async () => {
    const result = await vd(envWith(), "config", "init");
    expect(result).toEqual({
      code: EXIT_OK,
      stdout: `Created config.yaml, AGENTS.md, docs/ in ${local}`,
      stderr: "",
    });
    expect((await readdir(local)).sort()).toEqual(["AGENTS.md", "config.yaml", "docs"]);
    expect(await readFile(join(local, "config.yaml"), "utf8")).toBe(CONFIG_TEMPLATE);
    expect(await readFile(join(local, "AGENTS.md"), "utf8")).toBe(AGENTS_TEMPLATE);
    expect((await vd(envWith(), "config", "path")).stdout).toBe(
      `${local}\nSelected by local/ at the repository root`,
    );
  });

  test("keeps files that exist", async () => {
    await writeConfig(local, "version: 1\nlibrary: mine\n");
    expect((await vd(envWith(), "config", "init")).stdout).toBe(
      `Created AGENTS.md, docs/ in ${local}`,
    );
    expect(await readFile(join(local, "config.yaml"), "utf8")).toBe("version: 1\nlibrary: mine\n");
    expect((await vd(envWith(), "config", "init")).stdout).toBe(
      `Nothing to create: ${local} already has config.yaml, AGENTS.md, and docs/`,
    );
  });

  test("creates a folder outside the repository with --dir, and notes when another is used", async () => {
    await mkdir(local);
    const result = await vd(envWith(), "config", "init", "--dir", userDir);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(`Created config.yaml, AGENTS.md, docs/ in ${userDir}`);
    expect(result.stderr).toBe(
      `vd config init: note: vd uses ${local}, selected by local/ at the repository root, not this folder`,
    );
    expect(existsSync(join(userDir, "config.yaml"))).toBe(true);
  });

  test.each([
    ["the repository itself", () => repo],
    ["a folder in the repository", () => join(repo, "apps", "mine")],
    ["a folder inside local/", () => join(repo, "local", "sub")],
    ["a sibling named like local", () => join(repo, "local2")],
  ])("refuses %s and creates nothing", async (_, dir) => {
    const before = await readdir(repo);
    const result = await vd(envWith(), "config", "init", "--dir", dir());
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      `vd config init: ${dir()} is inside the vd-creator repository; use local/, which git ignores, or a folder outside it`,
    );
    expect(await readdir(repo)).toEqual(before);
  });

  test("refuses a path that reaches into the repository through a symbolic link", async () => {
    const link = join(tmp, "link-to-repo");
    await symlink(repo, link);
    await expect(initUserDir(join(link, "notes"), { repoRoot: repo })).rejects.toThrow(
      ConfigInitError,
    );
    expect(existsSync(join(repo, "notes"))).toBe(false);
    // local/ through the link is still local/.
    await initUserDir(join(link, "local"), { repoRoot: repo });
    expect(existsSync(join(local, "config.yaml"))).toBe(true);
  });

  test.each([
    ["a folder in the repository", true, () => join(repo, "apps")],
    ["a folder in the repository that does not exist yet", false, () => join(repo, "apps")],
    ["the repository itself", false, () => repo],
  ])("refuses local/ as a symbolic link to %s and creates nothing", async (_, make, to) => {
    if (make) await mkdir(to());
    await symlink(to(), local);
    const before = await readdir(repo);
    const result = await vd(envWith(), "config", "init");
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toBe(
      "vd config init: local/ is inside the vd-creator repository; use local/, which git ignores, or a folder outside it",
    );
    expect(await readdir(repo)).toEqual(before);
    if (existsSync(join(repo, "apps"))) expect(await readdir(join(repo, "apps"))).toEqual([]);
    // Through --dir too.
    expect((await vd(envWith(), "config", "init", "--dir", local)).code).toBe(EXIT_FAILURE);
  });

  test("accepts local/ as a symbolic link to a folder outside the repository", async () => {
    await mkdir(userDir);
    await symlink(userDir, local);
    expect((await vd(envWith(), "config", "init")).code).toBe(EXIT_OK);
    expect(existsSync(join(userDir, "config.yaml"))).toBe(true);
  });

  test("refuses a path inside the real repository other than local/", async () => {
    const inside = join(REPO_ROOT, "apps", "cli", "vd-config-init-test");
    await expect(initUserDir(inside)).rejects.toThrow(ConfigInitError);
    await expect(initUserDir(REPO_ROOT)).rejects.toThrow(ConfigInitError);
    expect(existsSync(inside)).toBe(false);
  });

  test("checks its options", async () => {
    expect((await vd(envWith(), "config")).code).toBe(EXIT_USAGE);
    expect((await vd(envWith(), "config", "list")).code).toBe(EXIT_USAGE);
    expect((await vd(envWith(), "config", "path", "--json")).code).toBe(EXIT_USAGE);
    expect((await vd(envWith(), "config", "show", "--dir", "x")).code).toBe(EXIT_USAGE);
    expect((await vd(envWith(), "config", "init", "--dir", "")).code).toBe(EXIT_USAGE);
    expect((await vd(envWith(), "config", "show", "extra")).code).toBe(EXIT_USAGE);
    expect((await vd(envWith(), "config", "show", "--yes")).code).toBe(EXIT_USAGE);
  });
});

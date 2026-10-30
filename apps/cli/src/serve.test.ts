import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from "./index.js";
import {
  allowHostValid,
  listenAddresses,
  listenHost,
  loopbackHost,
  parsePort,
  stopSignal,
  tokenUrls,
} from "./serve.js";

const cliRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = join(cliRoot, "bin", "vd.js");
const built = existsSync(join(cliRoot, "dist", "bin.js"));

let tmp: string;
let dir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vd-cli-serve-"));
  dir = join(tmp, "drama");
  expect((await vd("init", dir)).code).toBe(EXIT_OK);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmp, { recursive: true, force: true });
});

/** Runs a vd command that ends by itself. */
async function vd(...args: string[]) {
  const server = serveCommand(args);
  server.stop();
  return server.done;
}

/**
 * Starts vd with `args` and returns once it prints a line matching `ready`, or ends. `stop`
 * ends a running vd serve; `done` resolves with its exit code and output.
 */
function serveCommand(args: string[], options: { webDir?: string } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stopping = new AbortController();
  let onLine: () => void = () => {};
  const done = run(
    args,
    {
      stdout: (line) => {
        stdout.push(line);
        onLine();
      },
      stderr: (line) => stderr.push(line),
    },
    {},
    // The temporary folder stands in for the repository, so no real local/ is read.
    { repoRoot: tmp, signal: stopping.signal, webDir: options.webDir ?? join(tmp, "web") },
  ).then((code) => ({ code, stdout: stdout.join("\n"), stderr: stderr.join("\n") }));
  const ready = new Promise<void>((resolve) => {
    onLine = () => {
      if (stdout.some((line) => line.startsWith("Press Ctrl+C"))) resolve();
    };
    void done.then(() => resolve());
  });
  return {
    done,
    ready: ready.then(() => ({ stdout: stdout.join("\n"), stderr: stderr.join("\n") })),
    stop: () => stopping.abort(),
  };
}

/**
 * The port and token of the first token URL in `stdout`. Requests go to 127.0.0.1 on that
 * port, whichever address the URL names.
 */
function tokenUrl(stdout: string): { port: string; token: string } | undefined {
  const match = /^ {2}http:\/\/\S+:(\d+)\/\?token=([\w-]{20,})$/m.exec(stdout);
  return match ? { port: match[1] as string, token: match[2] as string } : undefined;
}

/** `text` without `token`, so that a failed assertion does not print the token. */
function redact(text: string, token: string): string {
  return token === "" ? text : text.replaceAll(token, "<token>");
}

/** A GET to 127.0.0.1:`port` with node:http, which, unlike fetch, can set the Host header. */
function get(port: string, path: string, host = `127.0.0.1:${port}`) {
  return send(port, path, { host });
}

/** A JSON POST to 127.0.0.1:`port` with node:http. */
function post(port: string, path: string, json: unknown) {
  return send(port, path, { method: "POST", body: JSON.stringify(json) });
}

function send(
  port: string,
  path: string,
  options: { host?: string; method?: string; body?: string },
) {
  const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${port}` };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    })
      .on("error", reject)
      .end(options.body);
  });
}

describe("vd serve", () => {
  test("serves the API of an init project on a free port, without a token", async () => {
    const server = serveCommand(["serve", dir, "--port", "0"]);
    try {
      const { stdout } = await server.ready;
      const url = /at (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(stdout)?.[1] as string;
      expect(url).toBeDefined();
      expect(url).not.toContain("token");
      const response = await fetch(new URL("api/project", url));
      expect(response.status).toBe(200);
      const project = (await response.json()) as {
        provider: { id: string; paid: boolean };
        library: boolean;
        scenario?: { title: string };
      };
      expect(project.provider).toEqual({ id: "mock", paid: false });
      expect(project.library).toBe(false);
      expect(project.scenario).toBeDefined();
    } finally {
      server.stop();
    }
    const result = await server.done;
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("Stopped.");
    // Without a built UI, it says so and serves the API only.
    expect(result.stderr).toContain("the web UI is not built");
  });

  test("serves the built UI", async () => {
    const web = join(tmp, "web");
    await mkdir(web);
    await writeFile(join(web, "index.html"), "<!doctype html><title>vd</title>");
    const server = serveCommand(["serve", dir, "--port", "0"], { webDir: web });
    try {
      const { stdout, stderr } = await server.ready;
      expect(stderr).not.toContain("not built");
      const url = /at (http:\S+)$/m.exec(stdout)?.[1] as string;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>vd</title>");
    } finally {
      server.stop();
    }
    expect((await server.done).code).toBe(EXIT_OK);
  });

  test("with a loopback --host, prints the URL with the token and no network warning", async () => {
    const server = serveCommand(["serve", dir, "--port", "0", "--host", "127.0.0.1"]);
    let token = "";
    try {
      const { stdout, stderr } = await server.ready;
      const url = /^ {2}(http:\/\/127\.0\.0\.1:\d+\/\?token=([\w-]{20,}))$/m.exec(stdout);
      expect(url).not.toBeNull();
      token = url?.[2] as string;
      expect(redact(stderr, token)).not.toContain("Anyone on the network");
      // The token is printed only inside the URL.
      expect(stdout.split(token).length - 1).toBe(1);
      expect(stderr.includes(token)).toBe(false);

      const base = new URL(url?.[1] as string);
      const without = await fetch(new URL("/api/project", base));
      expect(without.status).toBe(401);
      const withToken = await fetch(base, { redirect: "manual" });
      expect(withToken.status).toBe(303);
    } finally {
      server.stop();
    }
    const result = await server.done;
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.split(token).length - 1).toBe(1);
  });

  test("with --host 0.0.0.0, needs the token and prints the network warning", async () => {
    const server = serveCommand(["serve", dir, "--port", "0", "--host", "0.0.0.0"]);
    let token = "";
    try {
      const { stdout, stderr } = await server.ready;
      const found = tokenUrl(stdout);
      expect(found).toBeDefined();
      token = found?.token as string;
      const port = found?.port as string;
      expect(redact(stderr, token)).toContain("Anyone on the network");
      expect(redact(stderr, token)).toContain("Tailscale");
      expect(stderr.includes(token)).toBe(false);

      expect((await get(port, "/api/project")).status).toBe(401);
      expect((await get(port, `/api/project?token=${token}`)).status).toBe(303);
      expect((await get(port, "/api/project?token=wrong")).status).toBe(401);
    } finally {
      server.stop();
    }
    const result = await server.done;
    expect(result.code).toBe(EXIT_OK);
    expect(redact(result.stdout, token)).toContain("Stopped.");
  });

  // Starts the built bin in its own process, so that SIGTERM goes to vd serve's own handler.
  test.skipIf(!built)("stops on SIGTERM", { timeout: 30_000 }, async () => {
    const userDir = join(tmp, "user");
    await mkdir(userDir);
    // An empty user directory comes first, so no real config is read.
    const child = spawn(bin, ["serve", dir, "--port", "0", "--host", "0.0.0.0"], {
      env: { PATH: process.env.PATH, VD_USER_DIR: userDir },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    let token = "";
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("Press Ctrl+C")) resolve();
        });
        void exited.then(() => reject(new Error("vd serve ended before it was ready")));
      });
      const found = tokenUrl(stdout);
      expect(found).toBeDefined();
      token = found?.token as string;
      const port = found?.port as string;
      expect((await get(port, `/api/project?token=${token}`)).status).toBe(303);

      child.kill("SIGTERM");
      expect(await exited).toEqual({ code: EXIT_OK, signal: null });
      expect(redact(stdout, token)).toMatch(/Stopped\.\n$/);
      await expect(get(port, "/api/project")).rejects.toMatchObject({ code: "ECONNREFUSED" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  test("rejects --allow-host with a port, and warns that it has no effect with --host", async () => {
    for (const name of ["vd.example:5310", "[fd00::20]:80", "fd00::20", "vd.example/"]) {
      const result = await vd("serve", dir, "--port", "0", "--allow-host", name);
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.stderr).toContain("--allow-host takes a host name without a port");
    }

    const server = serveCommand([
      "serve",
      dir,
      "--port",
      "0",
      "--host",
      "127.0.0.1",
      "--allow-host",
      "vd.example",
    ]);
    let token = "";
    try {
      const { stdout, stderr } = await server.ready;
      token = tokenUrl(stdout)?.token ?? "";
      expect(redact(stderr, token)).toContain("--allow-host has no effect with --host");
    } finally {
      server.stop();
    }
    expect((await server.done).code).toBe(EXIT_OK);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a folder it cannot watch as a watch error, not a listen error",
    async () => {
      // Without read access, scenario.yaml is still found, but the folder cannot be watched.
      await chmod(dir, 0o300);
      try {
        const result = await vd("serve", dir, "--port", "0");
        expect(result.code).toBe(EXIT_FAILURE);
        expect(result.stderr).toContain(`vd serve: cannot watch ${dir} for changes: EACCES`);
        expect(result.stderr).not.toContain("cannot listen");
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  test("accepts the names given with --allow-host", async () => {
    const server = serveCommand([
      "serve",
      dir,
      "--port",
      "0",
      "--allow-host",
      "vd.example",
      "--allow-host",
      "other.example",
    ]);
    try {
      const { stdout } = await server.ready;
      const url = /at (http:\S+)$/m.exec(stdout)?.[1] as string;
      const port = new URL(url).port;
      const status = async (host: string) => (await get(port, "/api/project", host)).status;
      expect(await status("vd.example")).toBe(200);
      expect(await status(`other.example:${port}`)).toBe(200);
      expect(await status("evil.example")).toBe(403);
    } finally {
      server.stop();
    }
    expect((await server.done).code).toBe(EXIT_OK);
  });

  test("passes --library on to the server", async () => {
    const library = join(tmp, "library");
    expect((await vd("library", "init", library)).code).toBe(EXIT_OK);
    const server = serveCommand(["serve", dir, "--port", "0", "--library", library]);
    try {
      const { stdout } = await server.ready;
      const url = /at (http:\S+)$/m.exec(stdout)?.[1] as string;
      const project = (await (await fetch(new URL("api/project", url))).json()) as {
        library: boolean;
      };
      expect(project.library).toBe(true);
      expect((await fetch(new URL("api/library", url))).status).toBe(200);
    } finally {
      server.stop();
    }
    expect((await server.done).code).toBe(EXIT_OK);
  });

  test("marks a paid provider without calling it", async () => {
    // Any provider call would hit the spy; the test's own requests use node:http.
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network in tests")));
    vi.stubGlobal("fetch", fetchSpy);
    const server = serveCommand(["serve", dir, "--port", "0", "--provider", "elevenlabs"]);
    try {
      const { stdout } = await server.ready;
      expect(stdout).toContain("Provider elevenlabs is paid");
      const port = new URL(/at (http:\S+)$/m.exec(stdout)?.[1] as string).port;
      const response = await get(port, "/api/project");
      expect(response.status).toBe(200);
      const project = JSON.parse(response.body) as { provider: { paid: boolean } };
      expect(project.provider.paid).toBe(true);
      // The server's confirm gate is what keeps the paid provider from running.
      const refused = await post(port, "/api/generate", {});
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({ error: "confirm-required" });
    } finally {
      server.stop();
    }
    expect((await server.done).code).toBe(EXIT_OK);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects bad usage", async () => {
    expect((await vd("serve", dir, "extra")).code).toBe(EXIT_USAGE);
    expect((await vd("serve", dir, "--port", "65536")).code).toBe(EXIT_USAGE);
    expect((await vd("serve", dir, "--port", "abc")).code).toBe(EXIT_USAGE);
    expect((await vd("serve", dir, "--host", "")).code).toBe(EXIT_USAGE);
    expect((await vd("serve", dir, "--provider", "nope")).code).toBe(EXIT_USAGE);
    expect((await vd("serve", dir, "--yes")).code).toBe(EXIT_USAGE);
  });

  test("fails without a scenario.yaml", async () => {
    const result = await vd("serve", join(tmp, "missing"), "--port", "0");
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toContain("no scenario.yaml");
  });

  test("fails when the port is taken", async () => {
    const first = serveCommand(["serve", dir, "--port", "0"]);
    try {
      const { stdout } = await first.ready;
      const port = new URL(/at (http:\S+)$/m.exec(stdout)?.[1] as string).port;
      const result = await vd("serve", dir, "--port", port);
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.stderr).toContain("EADDRINUSE");
    } finally {
      first.stop();
    }
    expect((await first.done).code).toBe(EXIT_OK);
  });
});

describe("serve helpers", () => {
  test("parsePort", () => {
    expect(parsePort("0")).toBe(0);
    expect(parsePort("5310")).toBe(5310);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("65536")).toBeUndefined();
    expect(parsePort("-1")).toBeUndefined();
    expect(parsePort("1.5")).toBeUndefined();
    expect(parsePort("")).toBeUndefined();
  });

  test("listenAddresses lists the machine's addresses for a wildcard host", () => {
    const interfaces = {
      lo: [
        { address: "127.0.0.1", family: "IPv4" },
        { address: "::1", family: "IPv6", scopeid: 0 },
      ],
      eth0: [
        { address: "192.168.1.20", family: "IPv4" },
        { address: "fe80::1", family: "IPv6", scopeid: 2 },
        { address: "febf::1", family: "IPv6", scopeid: 2 },
        { address: "fd00::20", family: "IPv6", scopeid: 0 },
      ],
    } as unknown as Parameters<typeof listenAddresses>[1];
    expect(listenAddresses("0.0.0.0", interfaces)).toEqual(["127.0.0.1", "192.168.1.20"]);
    const all = ["127.0.0.1", "::1", "192.168.1.20", "fd00::20"];
    expect(listenAddresses("::", interfaces)).toEqual(all);
    expect(listenAddresses("::0", interfaces)).toEqual(all);
    expect(listenAddresses("0:0:0:0:0:0:0:0", interfaces)).toEqual(all);
    expect(listenAddresses("100.64.0.5", interfaces)).toEqual(["100.64.0.5"]);
    expect(listenAddresses("fd00::20", interfaces)).toEqual(["fd00::20"]);
    expect(listenAddresses("fe80::1%eth0", interfaces)).toEqual(["fe80::1%eth0"]);
  });

  test("loopbackHost", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LocalHost", "::1", "0:0::1"]) {
      expect(loopbackHost(host)).toBe(true);
    }
    expect(loopbackHost("::ffff:127.0.0.1")).toBe(true);
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "fd00::20", "fe80::1%lo", "vd.example"]) {
      expect(loopbackHost(host)).toBe(false);
    }
    expect(loopbackHost("::ffff:10.0.0.1")).toBe(false);
  });

  test("allowHostValid takes names and addresses without a port", () => {
    for (const name of ["vd.example", "VD.Example", "10.0.0.2", "[fd00::20]", "localhost"]) {
      expect(allowHostValid(name)).toBe(true);
    }
    for (const name of ["vd.example:5310", "[fd00::20]:80", "10.0.0.2:80", "fd00::20", ""]) {
      expect(allowHostValid(name)).toBe(false);
    }
  });

  test("listenHost drops the brackets of an IPv6 address", () => {
    expect(listenHost("[::]")).toBe("::");
    expect(listenHost("[fd00::20]")).toBe("fd00::20");
    expect(listenHost("0.0.0.0")).toBe("0.0.0.0");
  });

  test("stopSignal aborts on SIGINT and removes its listeners", () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const stop = stopSignal();
    expect(process.listenerCount("SIGINT")).toBe((before[0] as number) + 1);
    expect(process.listenerCount("SIGTERM")).toBe((before[1] as number) + 1);
    process.emit("SIGINT");
    expect(stop.signal.aborted).toBe(true);
    stop.dispose();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);

    const given = new AbortController().signal;
    expect(stopSignal(given).signal).toBe(given);
  });

  test("tokenUrls brackets IPv6 addresses and encodes a zone", () => {
    expect(tokenUrls(["10.0.0.2", "fd00::20", "fe80::1%eth0"], 5310, "abc")).toEqual([
      "http://10.0.0.2:5310/?token=abc",
      "http://[fd00::20]:5310/?token=abc",
      "http://[fe80::1%25eth0]:5310/?token=abc",
    ]);
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, run } from "./index.js";
import { listenAddresses, listenHost, parsePort, stopSignal, tokenUrls } from "./serve.js";

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

  test("with --host, prints URLs with the token and the network warning", async () => {
    const server = serveCommand(["serve", dir, "--port", "0", "--host", "127.0.0.1"]);
    let token = "";
    try {
      const { stdout, stderr } = await server.ready;
      const url = /^ {2}(http:\/\/127\.0\.0\.1:\d+\/\?token=([\w-]{20,}))$/m.exec(stdout);
      expect(url).not.toBeNull();
      token = url?.[2] as string;
      expect(stderr).toContain("Anyone on the network");
      expect(stderr).toContain("Tailscale");
      // The token is printed only inside the URLs.
      expect(stdout.split(token).length - 1).toBe(1);
      expect(stderr).not.toContain(token);

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

  test("tokenUrls brackets IPv6 addresses", () => {
    expect(tokenUrls(["10.0.0.2", "fd00::20"], 5310, "abc")).toEqual([
      "http://10.0.0.2:5310/?token=abc",
      "http://[fd00::20]:5310/?token=abc",
    ]);
  });
});

import { describe, expect, test } from "vitest";
import {
  ApiClient,
  ApiRequestError,
  NETWORK_ERROR_MESSAGE,
  UNKNOWN_ERROR_MESSAGE,
} from "./client.js";

const PREFIX = "http://host.example/app/vd/";

function recorder(respond: () => Response | Promise<Response> = () => json({ ok: true })) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("URLs stay relative to the page under a path prefix", () => {
  test("every request goes below the prefix", async () => {
    const { calls, fetchImpl } = recorder();
    // The first visit with a token: the query must not leak into API URLs.
    const client = new ApiClient(`${PREFIX}?token=secret`, fetchImpl);
    await client.getProject();
    await client.getServer();
    await client.patchItem("l1", { text: "Hi" });
    await client.patchScene("s1", { volume: 0.5 });
    await client.generate({ ids: ["l1"], dryRun: true });
    await client.getLibrary({ q: "rain door", kind: "sfx" });
    await client.verifyLibraryEntry("sfx", "rain", { confirm: true });

    expect(calls.map((c) => c.url)).toEqual([
      `${PREFIX}api/project`,
      `${PREFIX}api/server`,
      `${PREFIX}api/items/l1`,
      `${PREFIX}api/scenes/s1`,
      `${PREFIX}api/generate`,
      `${PREFIX}api/library?q=rain+door&kind=sfx`,
      `${PREFIX}api/library/sfx/rain/verify`,
    ]);
    for (const { init } of calls) expect(init?.credentials).toBe("same-origin");
  });

  test("asset, library file, and event URLs stay below the prefix", () => {
    const client = new ApiClient(PREFIX);
    expect(client.assetUrl("audio/line 1.mp3")).toBe(`${PREFIX}assets/audio/line%201.mp3`);
    expect(client.libraryFileUrl("bgm", "calm")).toBe(`${PREFIX}library-files/bgm/calm`);
    expect(client.eventsUrl()).toBe(`${PREFIX}api/events`);
  });

  test("dot segments are refused, so no URL climbs out of the prefix", async () => {
    const { calls, fetchImpl } = recorder();
    const client = new ApiClient(PREFIX, fetchImpl);
    expect(() => client.assetUrl("../../x")).toThrow(ApiRequestError);
    expect(() => client.assetUrl("a/./b")).toThrow(ApiRequestError);
    expect(() => client.libraryFileUrl("..", "..")).toThrow(ApiRequestError);
    await expect(client.patchItem("..", {})).rejects.toThrow(ApiRequestError);
    expect(calls).toEqual([]);
    // Other characters are encoded and stay inside the segment.
    expect(client.assetUrl("a/%2e%2e/b?c#d")).toBe(`${PREFIX}assets/a/%252e%252e/b%3Fc%23d`);
  });

  test("at the root, URLs are below the root", async () => {
    const { calls, fetchImpl } = recorder();
    await new ApiClient("http://127.0.0.1:5310/", fetchImpl).getProject();
    expect(calls[0]?.url).toBe("http://127.0.0.1:5310/api/project");
  });
});

describe("errors", () => {
  test("a network failure shows only the fixed message", async () => {
    const client = new ApiClient(PREFIX, async () => {
      throw new TypeError("Failed to fetch: secret details at 10.0.0.1");
    });
    const error = await client.getProject().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).message).toBe(NETWORK_ERROR_MESSAGE);
    expect((error as ApiRequestError).status).toBe(0);
  });

  test("an error body gives its fixed message", async () => {
    const client = new ApiClient(PREFIX, async () =>
      json({ error: "not-found", message: "Item not found." }, 404),
    );
    const error = (await client.patchItem("x", {}).catch((e: unknown) => e)) as ApiRequestError;
    expect(error.message).toBe("Item not found.");
    expect(error.status).toBe(404);
  });

  test("a body that is not an API error gives a generic message", async () => {
    const client = new ApiClient(
      PREFIX,
      async () => new Response("<html>Bad Gateway: upstream 127.0.0.1</html>", { status: 502 }),
    );
    const error = (await client.getProject().catch((e: unknown) => e)) as ApiRequestError;
    expect(error.message).toBe(UNKNOWN_ERROR_MESSAGE);
    expect(error.body).toBeUndefined();
  });
});

// The Hono app with the HTTP API of docs/plans/0005-review-ui.md, section "HTTP API".

import { join, resolve as resolvePath } from "node:path";
import {
  ASSETS_DIR,
  AssetCache,
  type AssetResolver,
  type AudioKind,
  BudgetExceededError,
  checkLibraryLicenses,
  computeTimeline,
  defaultResolvers,
  entriesSince,
  type GeneratedItemResolver,
  type ProjectLicenseIssue,
  planGeneration,
  type RunGenerationOptions,
  readEntries,
  reconcileLocked,
  recordReview,
  recordUiChanges,
  runGeneration,
  scenarioAudioKinds,
  scenarioItems,
  withProjectLock,
} from "@vd-creator/core";
import {
  type Entry,
  LIBRARY_KINDS,
  LibraryError,
  type LibraryKind,
  type LicenseRegistry,
  lookupLicense,
  readLibrary,
  searchLibrary,
  verifyEntry,
} from "@vd-creator/library";
import {
  IdSchema,
  type ItemPatch,
  loadScenario,
  type Scenario,
  ScenarioEditError,
  ScenarioValidationError,
  saveScenario,
  scenarioErrorResponse,
  updateItem,
} from "@vd-creator/scenario";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  ApiError,
  ApiErrorCode,
  ApprovedCost,
  ChangesResponse,
  ConfirmRequiredError,
  GenerateItemResult,
  GeneratePlanResponse,
  GenerateRequest,
  GenerateRunResponse,
  ItemPatchRequest,
  LibraryEntryInfo,
  LibraryResponse,
  ProjectResponse,
  ProviderInfo,
  ScenePatchRequest,
  ServerEventName,
  SoundSource,
  VerifyLibraryEntryResponse,
} from "./api.js";
import { changedSinceReview } from "./changes.js";
import { relativeUrlPath, serveFile } from "./files.js";
import { hostCheck } from "./hosts.js";
import { type MessageRoot, sanitizeMessage, sanitizeTarget } from "./sanitize.js";
import { documentData, sceneIndex, updateSceneBgm } from "./scene-edit.js";
import { tokenCheck } from "./token.js";
import type { ProjectEvents } from "./watcher.js";

/** The providers the server generates with: one provider set, as `vd generate` uses. */
export type ServerProviders = ConstructorParameters<typeof GeneratedItemResolver>[0];

export type AppOptions = {
  /** The project folder, holding scenario.yaml. */
  projectDir: string;
  provider: ServerProviders;
  /** Root of the sound library. Without it, the library routes return 404. */
  library?: string;
  /** Folder of the built web UI, served at `/`. Without it, only the API and files are served. */
  webDir?: string;
  /** When set, every request needs this token (see `tokenCheck`). */
  token?: string;
  /**
   * Without a token, host names accepted in the `Host` header besides the loopback names and
   * `.ts.net` names (see `hostCheck`), as `vd serve --allow-host` gives them.
   */
  allowedHosts?: readonly string[];
  /** Resolvers tried before the generated-item resolver, such as one for library items. */
  resolvers?: readonly AssetResolver[];
  /** Source of `GET /api/events`. Without it, the stream only sends keep-alives. */
  events?: ProjectEvents;
  /** Aborting it ends every open event stream, so that the server can close. */
  signal?: AbortSignal;
};

/** A keep-alive comment is sent this often on the event stream. */
export const KEEP_ALIVE_MS = 15_000;

const MESSAGES: Record<ApiErrorCode, string> = {
  "bad-request": "The request is not valid",
  unauthorized: "This server needs the access token printed by vd serve",
  "not-found": "Not found",
  "confirm-required": "A paid provider needs confirm: true and the approved cost to generate",
  "server-error": "The server could not complete the request",
};

/** Path prefixes that the built UI never serves. */
const NOT_WEB = ["/api/", "/assets/", "/library-files/"];

const PROJECT_UNREADABLE = "scenario.yaml cannot be read";
const LIBRARY_UNREADABLE = "The library cannot be read; run vd library check";
const LICENSES_UNCHECKED = "The licenses cannot be checked; run vd validate";
const NOT_VERIFIED = "The entry was not verified; run vd library check";

type Status = 400 | 401 | 404 | 409 | 500;

/** A failure whose response is fixed: thrown by handlers and answered by `onError`. */
class HttpError extends Error {
  constructor(
    readonly status: Status,
    readonly code: ApiErrorCode,
    readonly detail = MESSAGES[code],
  ) {
    super(detail);
  }
}

const badRequest = (detail?: string) => new HttpError(400, "bad-request", detail);
const notFound = () => new HttpError(404, "not-found");

/** Creates the app. It reads and writes only the project folder and the library. */
export function createApp(options: AppOptions): Hono {
  const { projectDir, provider, library } = options;
  const resolvers = [...(options.resolvers ?? []), ...defaultResolvers(provider)];
  const providerInfo: ProviderInfo = {
    id: provider.tts.id,
    paid: provider.tts.paid || provider.sfx.paid || provider.music.paid,
  };
  // Edits and generation runs each read, change, and write the project's files, so they run
  // one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  const app = new Hono();

  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json(apiError(e.code, e.detail), e.status);
    const scenarioError = scenarioErrorResponse(e);
    if (scenarioError) return c.json(scenarioError.body, 422);
    return c.json(apiError("server-error"), 500);
  });
  app.notFound((c) => c.json(apiError("not-found"), 404));

  // Pages and files must not leak their URL, which may hold the token, to other sites.
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("Referrer-Policy", "no-referrer");
  });
  // With a token, the token protects every route. Without one, the Host check does, against
  // DNS rebinding.
  app.use(
    "*",
    options.token !== undefined ? tokenCheck(options.token) : hostCheck(options.allowedHosts),
  );

  // Requests that change something must be JSON and must not come from another site, so a
  // page on another site cannot post a form or a simple request to this server.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (c.req.header("Sec-Fetch-Site") === "cross-site") {
        throw badRequest("Requests from another site are refused");
      }
      const type = c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") throw badRequest("The body must be application/json");
    }
    await next();
  });

  // `session` leaves the `ui` changes of that session unmarked.
  async function project(session?: string): Promise<ProjectResponse> {
    const base = { provider: providerInfo, library: library !== undefined };
    let loaded: Awaited<ReturnType<typeof loadScenario>>;
    try {
      loaded = await loadScenario(projectDir);
    } catch {
      const issues = [{ path: [], message: PROJECT_UNREADABLE, severity: "error" as const }];
      return { ...base, issues, licenseIssues: [], changedSinceReview: [] };
    }
    const { scenario, issues } = loaded;
    if (!scenario) return { ...base, issues, licenseIssues: [], changedSinceReview: [] };
    const cache = await AssetCache.load(projectDir);
    const timeline = await computeTimeline(scenario, cache, resolvers);
    const kinds = new Map<string, AudioKind | null>();
    for (const k of await scenarioAudioKinds(scenario, cache))
      kinds.set(`${k.kind}:${k.id}`, k.audio);
    const audioOf = (kind: string, id: string | undefined) =>
      (id !== undefined && kinds.get(`${kind}:${id}`)) || null;
    return {
      ...base,
      scenario,
      issues,
      licenseIssues: await licenseIssues(scenario),
      timeline: {
        ...timeline,
        items: timeline.items.map((item) => ({ ...item, audio: audioOf(item.kind, item.id) })),
        bgm: timeline.bgm.map((span) => ({ ...span, audio: audioOf("bgm", span.sceneId) })),
      },
      changedSinceReview: changedSinceReview(await readEntries(projectDir), session),
    };
  }

  // Runs `edit` holding the project lock, after recording what the file changed since the
  // snapshot, then records the edit's own changes as `ui` entries, so the edit is never found
  // again as a `file` change and an outside edit is never recorded as the UI's.
  async function uiChange(session: string | undefined, edit: () => Promise<void>): Promise<void> {
    await withProjectLock(projectDir, async () => {
      await reconcileLocked(projectDir);
      await edit();
      const { scenario } = await loadScenario(projectDir);
      if (scenario) await recordUiChanges(projectDir, scenario, session ? { session } : {});
    });
  }

  // Paths in license messages are shown relative to these.
  const messageRoots: MessageRoot[] = [
    { dir: resolvePath(projectDir), name: "the project folder" },
    ...(library !== undefined ? [{ dir: resolvePath(library), name: "the library" }] : []),
  ];

  // The check of `vd validate`, so the UI shows the same license issues as the CLI. Its
  // messages may quote the files it reads, such as a YAML excerpt or a key of credits.json,
  // so they are sanitized before they leave the server.
  async function licenseIssues(scenario: Scenario): Promise<ProjectLicenseIssue[]> {
    try {
      const issues = await checkLibraryLicenses(projectDir, scenario, { library });
      return issues.map(({ target, message, ...rest }) => ({
        ...rest,
        ...(target !== undefined && { target: sanitizeTarget(target, messageRoots) }),
        message: sanitizeMessage(message, messageRoots),
      }));
    } catch {
      return [{ message: LICENSES_UNCHECKED, severity: "error" }];
    }
  }

  app.get("/api/project", async (c) => c.json(await project(sessionOf(c))));

  app.get("/api/changes", async (c) => {
    const since = c.req.query("since") ?? "review";
    let point: Parameters<typeof entriesSince>[1];
    if (since === "review") point = "review";
    else if (/^[1-9]\d{0,15}$/.test(since)) point = { id: Number(since) };
    else throw badRequest("since must be review or an entry ID");
    const response: ChangesResponse = {
      entries: entriesSince(await readEntries(projectDir), point),
    };
    return c.json(response);
  });

  app.post("/api/changes/review", async (c) => {
    const session = sessionOf(c);
    checkFields(await jsonBody(c), []);
    return c.json(
      await exclusive(async () => {
        await recordReview(projectDir);
        return project(session);
      }),
    );
  });

  app.get("/api/events", (c) => {
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const event: ServerEventName = "project-changed";
      const unsubscribe = options.events?.subscribe((data) => {
        void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      });
      const ended = new Promise<void>((resolve) => {
        stream.onAbort(resolve);
        if (options.signal?.aborted) resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      try {
        await stream.write(": connected\n\n");
        let open = true;
        void ended.then(() => {
          open = false;
        });
        while (open) {
          await Promise.race([ended, delay(KEEP_ALIVE_MS)]);
          if (open) await stream.write(": keep-alive\n\n");
        }
      } finally {
        unsubscribe?.();
      }
    });
  });

  app.patch("/api/items/:id", async (c) => {
    const id = c.req.param("id");
    const session = sessionOf(c);
    const body = itemPatch(await jsonBody(c));
    return c.json(
      await exclusive(async () => {
        await uiChange(session, async () => {
          const { doc } = await loadScenario(projectDir).catch(() => {
            throw new HttpError(500, "server-error", PROJECT_UNREADABLE);
          });
          const item = findItem(documentData(doc), id);
          if (!item) throw notFound();
          const isLine = "line" in item;
          const isSfx = "sfx" in item;
          if ((body.text !== undefined || body.speaker !== undefined) && !isLine) {
            throw badRequest("text and speaker apply only to lines");
          }
          if (body.source !== undefined && !isSfx) throw badRequest("source applies only to SFX");
          if (body.take !== undefined && !isLine && !isSfx) {
            throw badRequest("take applies only to lines and SFX");
          }
          const patch: ItemPatch = {};
          if (body.text !== undefined) patch.line = body.text;
          if (body.speaker !== undefined) patch.speaker = body.speaker;
          if (body.gapBeforeSec !== undefined) patch.gapBeforeSec = body.gapBeforeSec;
          if (body.take !== undefined) patch.take = body.take;
          if (body.source !== undefined) {
            patch.sfx =
              "prompt" in body.source ? body.source.prompt : { library: body.source.library };
          }
          updateItem(doc, id, patch);
          await saveScenario(projectDir, doc);
        });
        return project(session);
      }),
    );
  });

  app.patch("/api/scenes/:id", async (c) => {
    const id = c.req.param("id");
    const session = sessionOf(c);
    const body = scenePatch(await jsonBody(c));
    return c.json(
      await exclusive(async () => {
        await uiChange(session, async () => {
          const { doc } = await loadScenario(projectDir).catch(() => {
            throw new HttpError(500, "server-error", PROJECT_UNREADABLE);
          });
          const data = documentData(doc);
          if (data === undefined) throw new ScenarioEditError("Cannot edit a document with errors");
          const index = sceneIndex(data, id);
          if (index === -1) throw notFound();
          updateSceneBgm(doc, index, body);
          await saveScenario(projectDir, doc);
        });
        return project(session);
      }),
    );
  });

  app.post("/api/generate", async (c) => {
    const body = generateRequest(await jsonBody(c));
    const only = body.ids ? { only: body.ids } : {};
    // The valid scenario, with every requested ID in it.
    const scenarioFor = async (): Promise<Scenario> => {
      const { scenario, issues } = await loadScenario(projectDir).catch(() => {
        throw new HttpError(500, "server-error", PROJECT_UNREADABLE);
      });
      if (!scenario) throw new ScenarioValidationError(issues);
      if (body.ids) {
        const known = new Set(scenarioItems(scenario).map((item) => item.id));
        if (body.ids.some((id) => !known.has(id))) throw badRequest("An item ID is unknown");
      }
      return scenario;
    };
    const planFor = async (
      scenario: Scenario,
      cache: AssetCache,
    ): Promise<GeneratePlanResponse> => ({
      kind: "plan",
      provider: providerInfo,
      plan: await planGeneration(scenario, cache, resolvers, only),
    });
    const refused = (plan: GeneratePlanResponse) => {
      const error: ConfirmRequiredError = {
        ...apiError("confirm-required"),
        error: "confirm-required",
        plan,
      };
      return c.json(error, 409);
    };
    const runs = body.dryRun !== true && (!providerInfo.paid || body.confirm === true);
    if (!runs) {
      // Only reads, so it need not wait for the queue.
      const plan = await planFor(await scenarioFor(), await AssetCache.load(projectDir));
      return body.dryRun === true ? c.json(plan) : refused(plan);
    }
    // Loaded in the queue, so that a run waiting behind an edit generates the edited text. A
    // paid run is planned again there, and runs only within the cost the user approved. The
    // approved cost is also the run's budget: the plan counts cached items as free and dedupes
    // identical requests, but an asset removed after the check, or a request called again
    // after a failed call, is billed again, so each paid call must fit in what is left.
    type Outcome =
      | { refused: GeneratePlanResponse }
      | { result: Awaited<ReturnType<typeof runGeneration>> };
    const outcome = await exclusive(async (): Promise<Outcome> => {
      const scenario = await scenarioFor();
      const cache = await AssetCache.load(projectDir);
      const run: RunGenerationOptions = { ...only };
      if (providerInfo.paid) {
        const plan = await planFor(scenario, cache);
        if (!body.approved || !withinApproved(plan.plan.cost, body.approved)) {
          return { refused: plan };
        }
        run.budget = body.approved;
      }
      return { result: await runGeneration(scenario, cache, resolvers, run) };
    });
    if ("refused" in outcome) return refused(outcome.refused);
    const { result } = outcome;
    const response: GenerateRunResponse = {
      kind: "run",
      provider: providerInfo,
      items: result.items.map((item): GenerateItemResult => {
        if (item.status !== "failed") return item;
        // GenerationError's message names only the item's kind and ID. A budget refusal adds
        // its own fixed text, so the UI can tell it from a provider failure.
        const { error, ...rest } = item;
        const message =
          error.cause instanceof BudgetExceededError
            ? `${error.message}: ${error.cause.message}`
            : error.message;
        return { ...rest, message };
      }),
      failed: result.failed,
    };
    return c.json(response);
  });

  app.get("/api/library", async (c) => {
    const root = requireLibrary(library);
    const kind = c.req.query("kind");
    if (kind !== undefined && kind !== "" && !isKind(kind)) throw badRequest("Unknown kind");
    const lib = await readLibrary(root).catch(() => {
      throw new HttpError(500, "server-error", LIBRARY_UNREADABLE);
    });
    let results: ReturnType<typeof searchLibrary>;
    try {
      results = searchLibrary(lib, c.req.query("q") ?? "", kind ? { kind } : {});
    } catch {
      throw new HttpError(500, "server-error", LIBRARY_UNREADABLE);
    }
    const entries: LibraryEntryInfo[] = [];
    for (const result of results) {
      const found = lib.entries.find((e) => e.kind === result.kind && e.entry.id === result.id);
      if (found) entries.push(entryInfo(found.entry, lib.licenses));
    }
    const response: LibraryResponse = { name: lib.meta.name, entries };
    return c.json(response);
  });

  app.post("/api/library/:kind/:id/verify", async (c) => {
    const root = requireLibrary(library);
    const { kind, id } = entryParams(c.req.param("kind"), c.req.param("id"));
    const body = await jsonBody(c);
    if (!isRecord(body) || body.confirm !== true) throw badRequest("confirm must be true");
    const unknownKey = Object.keys(body).find((k) => k !== "confirm" && k !== "approveCommercial");
    if (unknownKey !== undefined) throw badRequest("The body has an unknown field");
    if (body.approveCommercial !== undefined && typeof body.approveCommercial !== "boolean") {
      throw badRequest("approveCommercial must be a boolean");
    }
    const approveCommercial = body.approveCommercial === true;
    const response = await exclusive(async (): Promise<VerifyLibraryEntryResponse> => {
      try {
        const result = await verifyEntry(root, id, { kind, approveCommercial });
        const lib = await readLibrary(root);
        const entry = entryInfo(result.entry.entry, lib.licenses);
        return result.verified
          ? { verified: true, entry }
          : { verified: false, entry, message: NOT_VERIFIED };
      } catch (e) {
        if (!(e instanceof LibraryError)) throw e;
        // Refused: answer with the entry as it is, if there is one.
        const lib = await readLibrary(root).catch(() => {
          throw new HttpError(500, "server-error", LIBRARY_UNREADABLE);
        });
        const found = lib.entries.find((x) => x.kind === kind && x.entry.id === id);
        if (!found) throw notFound();
        return {
          verified: false,
          entry: entryInfo(found.entry, lib.licenses),
          message: NOT_VERIFIED,
        };
      }
    });
    return c.json(response);
  });

  app.get("/library-files/:kind/:id", async (c) => {
    const root = requireLibrary(library);
    const { kind, id } = entryParams(c.req.param("kind"), c.req.param("id"));
    const lib = await readLibrary(root).catch(() => {
      throw new HttpError(500, "server-error", LIBRARY_UNREADABLE);
    });
    const found = lib.entries.find((e) => e.kind === kind && e.entry.id === id);
    if (!found) throw notFound();
    const response = await serveFile(root, `${found.dir}/${found.entry.file}`, { sandbox: true });
    if (!response) throw notFound();
    return response;
  });

  app.get("/assets/*", async (c) => {
    const rest = new URL(c.req.url).pathname.slice("/assets/".length);
    const rel = relativeUrlPath(rest);
    if (rel === undefined) throw notFound();
    const response = await serveFile(join(projectDir, ASSETS_DIR), rel, { sandbox: true });
    if (!response) throw notFound();
    return response;
  });

  // The built UI: every other path. Its own files are under ui/, apart from the project's
  // /assets/.
  app.get("/*", async (c) => {
    const webDir = options.webDir;
    const pathname = new URL(c.req.url).pathname;
    if (webDir === undefined || NOT_WEB.some((prefix) => pathname.startsWith(prefix))) {
      throw notFound();
    }
    const rel = pathname === "/" ? "index.html" : relativeUrlPath(pathname.slice(1));
    if (rel === undefined) throw notFound();
    const response = await serveFile(webDir, rel);
    if (!response) throw notFound();
    return response;
  });

  return app;
}

function apiError(code: ApiErrorCode, message = MESSAGES[code]): ApiError {
  return { error: code, message };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function requireLibrary(library: string | undefined): string {
  if (library === undefined) throw notFound();
  return library;
}

function isKind(value: string): value is LibraryKind {
  return (LIBRARY_KINDS as readonly string[]).includes(value);
}

function entryParams(kind: string, id: string): { kind: LibraryKind; id: string } {
  if (!isKind(kind) || !IdSchema.safeParse(id).success) throw notFound();
  return { kind, id };
}

/** The entry as the UI sees it, without paths on disk. */
function entryInfo(entry: Entry, licenses: LicenseRegistry): LibraryEntryInfo {
  const info: LibraryEntryInfo = {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    tags: entry.tags,
    source: entry.source,
    license: entry.license,
  };
  if (entry.durationSec !== undefined) info.durationSec = entry.durationSec;
  if (entry.loopable !== undefined) info.loopable = entry.loopable;
  if (entry.notes !== undefined) info.notes = entry.notes;
  const terms = lookupLicense(licenses, entry.license.id);
  if (terms) info.licenseTerms = terms;
  return info;
}

/** The ID of the page's session, from `X-VD-Session`; absent if the header is not sent. */
function sessionOf(c: Context): string | undefined {
  const value = c.req.header("X-VD-Session");
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw badRequest("X-VD-Session is not a valid ID");
  return value;
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest("The body is not valid JSON");
  }
}

function findItem(data: unknown, id: string): Record<string, unknown> | undefined {
  const scenes = isRecord(data) && Array.isArray(data.scenes) ? data.scenes : [];
  for (const scene of scenes) {
    const items = isRecord(scene) && Array.isArray(scene.items) ? scene.items : [];
    for (const item of items) if (isRecord(item) && item.id === id) return item;
  }
  return undefined;
}

function itemPatch(body: unknown): ItemPatchRequest {
  const fields = ["text", "speaker", "gapBeforeSec", "take", "source"];
  const record = checkFields(body, fields);
  const patch: ItemPatchRequest = {};
  if (record.text !== undefined) {
    if (typeof record.text !== "string" || record.text === "") {
      throw badRequest("text must be a non-empty string");
    }
    patch.text = record.text;
  }
  if (record.speaker !== undefined) {
    if (!IdSchema.safeParse(record.speaker).success) throw badRequest("speaker must be an ID");
    patch.speaker = record.speaker as string;
  }
  if (record.gapBeforeSec !== undefined) {
    if (!isFiniteNumber(record.gapBeforeSec)) throw badRequest("gapBeforeSec must be a number");
    patch.gapBeforeSec = record.gapBeforeSec;
  }
  if (record.take !== undefined) {
    if (!Number.isSafeInteger(record.take) || (record.take as number) < 0) {
      throw badRequest("take must be a whole number, 0 or more");
    }
    patch.take = record.take as number;
  }
  if (record.source !== undefined) patch.source = soundSource(record.source, "source");
  return patch;
}

function scenePatch(body: unknown): ScenePatchRequest {
  const record = checkFields(body, ["bgm", "volume"]);
  const patch: ScenePatchRequest = {};
  if (record.bgm !== undefined) patch.bgm = soundSource(record.bgm, "bgm");
  if (record.volume !== undefined) {
    const volume = record.volume;
    if (!isFiniteNumber(volume) || volume < 0 || volume > 1) {
      throw badRequest("volume must be a number from 0 to 1");
    }
    patch.volume = volume;
  }
  if (patch.bgm === undefined && patch.volume === undefined) throw badRequest("Nothing to change");
  return patch;
}

function soundSource(value: unknown, name: string): SoundSource {
  const invalid = () => badRequest(`${name} must be { prompt } or { library }`);
  if (!isRecord(value)) throw invalid();
  const keys = Object.keys(value);
  if (keys.length !== 1) throw invalid();
  if (typeof value.prompt === "string" && value.prompt !== "") return { prompt: value.prompt };
  if (IdSchema.safeParse(value.library).success) return { library: value.library as string };
  throw invalid();
}

/**
 * The body of `POST /api/generate`. An `approved` that is not two whole numbers, 0 or more,
 * is dropped rather than refused with 400, so that a paid confirm with it gets the 409 with
 * the plan, and a free provider ignores it.
 */
function generateRequest(body: unknown): GenerateRequest {
  const record = checkFields(body, ["ids", "dryRun", "confirm", "approved"]);
  const request: GenerateRequest = {};
  if (record.ids !== undefined) {
    if (!Array.isArray(record.ids) || !record.ids.every((id) => typeof id === "string")) {
      throw badRequest("ids must be a list of item IDs");
    }
    // Absent means all items; an empty list would mean none, which is never what was meant.
    if (record.ids.length === 0) throw badRequest("ids must not be empty; leave it out for all");
    request.ids = record.ids;
  }
  for (const key of ["dryRun", "confirm"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw badRequest(`${key} must be a boolean`);
    request[key] = value;
  }
  const approved = approvedCost(record.approved);
  if (approved) request.approved = approved;
  return request;
}

/** `value` as an approved cost: exactly `characters` and `requests`, whole numbers, 0 or more. */
function approvedCost(value: unknown): ApprovedCost | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "characters" || keys[1] !== "requests") return undefined;
  const { characters, requests } = value;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  return count(characters) && count(requests) ? { characters, requests } : undefined;
}

/** True if a plan's cost needs no more characters and no more requests than approved. */
function withinApproved(cost: ApprovedCost, approved: ApprovedCost | undefined): boolean {
  return (
    approved !== undefined &&
    cost.characters <= approved.characters &&
    cost.requests <= approved.requests
  );
}

/** The body as a record, refusing anything that is not an object or has unknown fields. */
function checkFields(body: unknown, fields: string[]): Record<string, unknown> {
  if (!isRecord(body)) throw badRequest("The body must be a JSON object");
  if (Object.keys(body).some((key) => !fields.includes(key))) {
    throw badRequest("The body has an unknown field");
  }
  return body;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

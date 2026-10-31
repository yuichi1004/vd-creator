// HTTP client of the server API. See "HTTP API" in docs/plans/0005-review-ui.md.
// Every URL is resolved against the page's base URL, never from "/", so the UI also works
// behind a reverse proxy that serves it under a path prefix.

import type {
  ApiError,
  ChangesResponse,
  ConfirmRequiredError,
  GenerateRequest,
  GenerateResponse,
  ItemPatchRequest,
  LibraryQuery,
  LibraryResponse,
  PatchResponse,
  ProjectResponse,
  ScenarioErrorResponse,
  ScenePatchRequest,
  VerifyLibraryEntryRequest,
  VerifyLibraryEntryResponse,
} from "@vd-creator/server";

/** Shown when the server cannot be reached. The text of the fetch error is never shown. */
export const NETWORK_ERROR_MESSAGE = "Could not reach the server.";
/** Shown when the server answers with an error but no usable message. */
export const UNKNOWN_ERROR_MESSAGE = "The request failed.";

/**
 * A failed request. `message` is the fixed message of the error body, or one of the fixed
 * messages above, so it is safe to show to the user.
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the server could not be reached. */
    readonly status: number,
    /** The parsed error body, when the server sent one. */
    readonly body?: ApiError | ScenarioErrorResponse,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/**
 * A random ID for this page's session, sent as `X-VD-Session` so that the server leaves the
 * page's own changes unmarked. 128 bits, as hex; it is never shown or stored.
 */
export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** True if a failed request is the 409 of a paid generation without `confirm`. */
export function isConfirmRequired(
  body: ApiError | ScenarioErrorResponse | undefined,
): body is ConfirmRequiredError {
  return body?.error === "confirm-required" && "plan" in body;
}

/**
 * Encodes one path segment. "." and ".." are refused, since URL resolution would apply them
 * and leave the folder, and even the page's path prefix.
 */
function segment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new ApiRequestError(UNKNOWN_ERROR_MESSAGE, 0);
  }
  return encodeURIComponent(value);
}

/** Encodes each segment of a "/"-separated path, keeping the separators. */
function encodePath(path: string): string {
  return path.split("/").map(segment).join("/");
}

export class ApiClient {
  /**
   * @param baseUrl The page's base URL, normally `document.baseURI`. Paths resolve against it.
   * @param fetchImpl The fetch function, replaced in tests.
   */
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    /** Sent as `X-VD-Session` with every API request. */
    readonly sessionId: string = newSessionId(),
  ) {}

  /** Resolves a relative path, such as `api/project`, against the base URL. */
  url(path: string): string {
    return new URL(path, this.baseUrl).href;
  }

  /** URL of a project asset, given relative to `assets/`. */
  assetUrl(file: string): string {
    return this.url(`assets/${encodePath(file)}`);
  }

  /** URL of a library entry's audio, for preview. */
  libraryFileUrl(kind: string, id: string): string {
    return this.url(`library-files/${segment(kind)}/${segment(id)}`);
  }

  /** URL of the server-sent events stream. */
  eventsUrl(): string {
    return this.url("api/events");
  }

  async getProject(): Promise<ProjectResponse> {
    return this.request<ProjectResponse>("GET", "api/project");
  }

  async patchItem(id: string, patch: ItemPatchRequest): Promise<PatchResponse> {
    return this.request<PatchResponse>("PATCH", `api/items/${segment(id)}`, patch);
  }

  async patchScene(id: string, patch: ScenePatchRequest): Promise<PatchResponse> {
    return this.request<PatchResponse>("PATCH", `api/scenes/${segment(id)}`, patch);
  }

  /** The change log entries after the last review, all of them, or after the entry `since`. */
  async getChanges(since: "review" | "start" | number = "review"): Promise<ChangesResponse> {
    return this.request<ChangesResponse>("GET", `api/changes?since=${since}`);
  }

  /** Marks all changes reviewed. The server answers with the project, now without marks. */
  async markReviewed(): Promise<ProjectResponse> {
    return this.request<ProjectResponse>("POST", "api/changes/review", {});
  }

  async generate(body: GenerateRequest): Promise<GenerateResponse> {
    return this.request<GenerateResponse>("POST", "api/generate", body);
  }

  async getLibrary(query: LibraryQuery = {}): Promise<LibraryResponse> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.kind) params.set("kind", query.kind);
    const search = params.toString();
    return this.request<LibraryResponse>("GET", `api/library${search ? `?${search}` : ""}`);
  }

  async verifyLibraryEntry(
    kind: string,
    id: string,
    body: VerifyLibraryEntryRequest,
  ): Promise<VerifyLibraryEntryResponse> {
    return this.request<VerifyLibraryEntryResponse>(
      "POST",
      `api/library/${segment(kind)}/${segment(id)}/verify`,
      body,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "X-VD-Session": this.sessionId };
    const init: RequestInit = { method, credentials: "same-origin", headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), init);
    } catch {
      throw new ApiRequestError(NETWORK_ERROR_MESSAGE, 0);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (response.ok && json !== undefined) return json as T;
    const errorBody = isErrorBody(json) ? json : undefined;
    throw new ApiRequestError(
      errorBody?.message ?? UNKNOWN_ERROR_MESSAGE,
      response.status,
      errorBody,
    );
  }
}

function isErrorBody(value: unknown): value is ApiError | ScenarioErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

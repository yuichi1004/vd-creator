// Request and response types of the HTTP API. See "HTTP API" in docs/plans/0005-review-ui.md.
// Types only: apps/web imports them with `import type`, so nothing here may be runtime code.

import type { GenerationPlan, ScenarioItemKind, Timeline } from "@vd-creator/core";
import type { Entry, LibraryKind, LicenseCheckIssue, LicenseTerms } from "@vd-creator/library";
import type { Issue, Scenario, ScenarioErrorBody, ScenarioErrorIssue } from "@vd-creator/scenario";

export type { ScenarioErrorIssue };

/** The provider the server runs with, chosen by `vd serve --provider`. */
export type ProviderInfo = {
  id: string;
  /** True if each generation costs real money. Generation then needs `confirm: true`. */
  paid: boolean;
};

/** `GET /api/project`. */
export type ProjectResponse = {
  /** The validated scenario. Absent when `scenario.yaml` has errors; `issues` then says why. */
  scenario?: Scenario;
  /** YAML and validation issues of `scenario.yaml`, errors and warnings. */
  issues: Issue[];
  /** License issues of the library entries and the provider used by the project (0007). */
  licenseIssues: LicenseCheckIssue[];
  /**
   * Start time and duration of every item. Absent when there is no valid scenario. Asset
   * files are relative to `assets/` and are fetched from `assets/<file>`.
   */
  timeline?: Timeline;
  provider: ProviderInfo;
  /** True if the server knows a library, so `/api/library` is available. */
  library: boolean;
};

/** Name of the server-sent events of `GET /api/events`. */
export type ServerEventName = "project-changed";

/** Data of a `project-changed` event, sent as JSON. The UI then reloads `GET /api/project`. */
export type ProjectChangedEvent = {
  file: "scenario.yaml" | "cache.json";
};

/** A sound source written as `{ prompt }` for a generated sound or `{ library }` for a library entry. */
export type SoundSource = { prompt: string } | { library: string };

/**
 * Body of `PATCH /api/items/:id`. Only the given fields change. `text` is the text of a
 * line, `source` the source of an SFX. Saved through `updateItem`, so comments survive.
 */
export type ItemPatchRequest = {
  text?: string;
  speaker?: string;
  gapBeforeSec?: number;
  take?: number;
  source?: SoundSource;
};

/** Body of `PATCH /api/scenes/:id`: the BGM source and volume of the scene. */
export type ScenePatchRequest = {
  bgm?: SoundSource;
  /** BGM volume, 0 to 1. */
  volume?: number;
};

/** Response of `PATCH /api/items/:id` and `PATCH /api/scenes/:id`: the project after the edit. */
export type PatchResponse = ProjectResponse;

/**
 * Body of a 422 response: a refused edit or save of `scenario.yaml`, or a scenario with
 * validation errors. Issue paths point into the scenario, as in `scenes.0.items.2.text`.
 *
 * Every `message`, on the body and on each issue, is either a message of the `yaml` parser
 * about the file's syntax, or fixed text written by the scenario package or the server. A
 * message that does not come from the `yaml` parser, such as the text of an unexpected
 * error, is always replaced by fixed text and never sent to the client.
 */
export type ScenarioErrorResponse = ScenarioErrorBody;

/** Body of `POST /api/generate`. */
export type GenerateRequest = {
  /** Only these item IDs. A BGM uses its scene's ID. All items when absent. */
  ids?: string[];
  /** Required to run a paid provider. Without it, the response is the plan only. */
  confirm?: boolean;
};

/**
 * Response of `POST /api/generate` without `confirm`: what would be generated and its
 * estimated cost. The UI shows "Generate (N characters)" from `plan.cost.characters`.
 */
export type GeneratePlanResponse = {
  kind: "plan";
  provider: ProviderInfo;
  plan: GenerationPlan;
};

/** The outcome of one item of a generation run. Library items are resolved, not generated. */
export type GenerateItemResult = {
  id: string;
  kind: ScenarioItemKind;
  sceneId: string;
  resolver?: string;
} & (
  | { status: "cached" | "generated"; file: string; durationSec: number }
  | { status: "unresolved"; reason: string }
  /** `message` names only the item's kind and ID, never its text or prompt. */
  | { status: "failed"; message: string }
);

/** Response of `POST /api/generate` that ran the generation. */
export type GenerateRunResponse = {
  kind: "run";
  provider: ProviderInfo;
  /** One result per item, in scenario order. */
  items: GenerateItemResult[];
  /** Number of items that failed. */
  failed: number;
};

export type GenerateResponse = GeneratePlanResponse | GenerateRunResponse;

/** Query of `GET /api/library`. */
export type LibraryQuery = {
  /** Words that must all match the ID, title, tags, or notes. All entries when empty. */
  q?: string;
  kind?: LibraryKind;
};

/**
 * A library entry as the UI sees it: its metadata, source, and license record, with the
 * terms of its license from the registry. Paths on disk are left out; the audio is served
 * from `library-files/<kind>/<id>`.
 */
export type LibraryEntryInfo = Pick<
  Entry,
  "id" | "kind" | "title" | "tags" | "durationSec" | "loopable" | "source" | "license" | "notes"
> & {
  /** Terms of `license.id`. Absent when the registry has no such license. */
  licenseTerms?: LicenseTerms;
};

/** Response of `GET /api/library`. 404 when no library is set. */
export type LibraryResponse = {
  /** Name of the library from its library.yaml. */
  name: string;
  entries: LibraryEntryInfo[];
};

/** Body of `POST /api/library/:kind/:id/verify`, sent only after the user confirmed. */
export type VerifyLibraryEntryRequest = {
  confirm: true;
  /** Also approve conditional or unknown terms for commercial use. */
  approveCommercial?: boolean;
};

/** Response of `POST /api/library/:kind/:id/verify`. */
export type VerifyLibraryEntryResponse = {
  verified: boolean;
  entry: LibraryEntryInfo;
  /** Why the entry was not verified, when `verified` is false. */
  message?: string;
};

/** Error codes of `ApiError`. */
export type ApiErrorCode =
  | "bad-request"
  | "unauthorized"
  | "not-found"
  | "confirm-required"
  | "server-error";

/**
 * Body of every error response other than 422: 400 `bad-request`, 401 `unauthorized`
 * (missing or wrong token with `--host`), 404 `not-found`, 409 `confirm-required` (a paid
 * generation without `confirm`), and 500 `server-error`. `message` is fixed text.
 */
export type ApiError = {
  error: ApiErrorCode;
  message: string;
};

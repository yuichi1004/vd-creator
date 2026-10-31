// Request and response types of the HTTP API. See "HTTP API" in docs/plans/0005-review-ui.md.
// Types only: apps/web imports them with `import type`, so nothing here may be runtime code.

import type {
  AudioKind,
  BgmSpan,
  ChangeEntry,
  ChangeTargetKind,
  GenerationPlan,
  InstructionLogEntry,
  ProjectLicenseIssue,
  ScenarioItemKind,
  Timeline,
  TimelineItem,
} from "@vd-creator/core";
import type { Entry, LibraryKind, LicenseTerms } from "@vd-creator/library";
import type { Issue, Scenario, ScenarioErrorBody, ScenarioErrorIssue } from "@vd-creator/scenario";

export type { ScenarioErrorIssue };

/** The provider the server runs with, chosen by `vd serve --provider`. */
export type ProviderInfo = {
  id: string;
  /**
   * True if each generation costs real money. Generation then needs `confirm: true` and the
   * `approved` cost.
   */
  paid: boolean;
};

/**
 * `GET /api/server`: facts about the whole server (plan 0010). No path on disk is ever in it.
 * Later plans add fields.
 */
export type ServerInfoResponse = {
  provider: ProviderInfo;
  /** The library's name from its library.yaml. Absent when no library is set or it is unreadable. */
  library?: { name: string };
  /** The agent that answers instructions (0013). Absent when none is set, so the UI hides its box. */
  agent?: { command: AgentCommand };
  /** The vd version. */
  version: string;
  preview: {
    /**
     * True if `GET /preview/*` can make time-stretched copies that keep the pitch, which needs
     * ffmpeg on `PATH`. When false, the UI plays at a speed with `playbackRate`.
     */
    keepPitch: boolean;
  };
};

/**
 * Whether the audio of a line, SFX, or BGM is draft (made by the free provider) or final (a
 * library sound, or made by a paid provider). `null` where there is no asset yet.
 */
export type { AudioKind };

/**
 * A timeline whose items and BGM spans say whether their audio is draft. The server always sets
 * `audio`, `null` for an item without audio or asset.
 */
export type ProjectTimeline = Omit<Timeline, "items" | "bgm"> & {
  items: (TimelineItem & { audio?: AudioKind | null })[];
  bgm: (BgmSpan & { audio?: AudioKind | null })[];
};

/** A target with changes the user has not reviewed. `count` is the number of change entries. */
export type ChangedTarget = { kind: ChangeTargetKind; id: string; count: number };

/**
 * A change log entry as the server sends it. Session IDs are never sent: a `ui` entry made by
 * the requesting session (the `X-VD-Session` of the request) has `own: true`, and no other
 * entry has `own`. The page makes its session ID random, at least 128 bits, so no one else
 * learns it.
 */
export type ChangeEntryView = ChangeEntry extends infer E
  ? E extends InstructionLogEntry
    ? E
    : E extends { session?: string }
      ? Omit<E, "session"> & { own?: true }
      : E
  : never;

/**
 * Response of `GET /api/changes`: the entries after the point, oldest first. That includes the
 * `instruction` and `instruction-outcome` entries of 0013, which record no change to the drama:
 * they never mark a target, and a page that shows changes skips them.
 */
export type ChangesResponse = { entries: ChangeEntryView[] };

/** `GET /api/project`. */
export type ProjectResponse = {
  /** The validated scenario. Absent when `scenario.yaml` has errors; `issues` then says why. */
  scenario?: Scenario;
  /** YAML and validation issues of `scenario.yaml`, errors and warnings. */
  issues: Issue[];
  /**
   * License issues of the library entries and the providers used by the project (0007), from
   * the same check as `vd validate`. An issue without a `target` concerns the whole project,
   * such as an unreadable `credits.json` or `cache.json`.
   */
  licenseIssues: ProjectLicenseIssue[];
  /**
   * Start time and duration of every item. Absent when there is no valid scenario. Asset
   * files are relative to `assets/` and are fetched from `assets/<file>`.
   */
  timeline?: ProjectTimeline;
  /**
   * Targets changed in the file, or in the UI by another session, since the last `review` entry
   * of the change log, or explained by an `agent` entry after it (0015). `ui` changes of the
   * session sent in `X-VD-Session` are left out. Empty when there is no valid scenario.
   */
  changedSinceReview: ChangedTarget[];
  provider: ProviderInfo;
  /** True if the server knows a library, so `/api/library` is available. */
  library: boolean;
};

/** Name of the server-sent events of `GET /api/events`. */
export type ServerEventName = "project-changed";

/** Data of a `project-changed` event, sent as JSON. The UI then reloads `GET /api/project`. */
export type ProjectChangedEvent = {
  file: "scenario.yaml" | "cache.json" | "changes.jsonl";
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
  /** The direction of a line. An empty string removes it. */
  direction?: string;
  /**
   * The line's own voice settings, merged over its current override one key at a time: a value
   * sets the key and `null` removes it. The line's `voice` is removed when no key is left.
   */
  voiceSettings?: Record<string, unknown>;
  /**
   * Makes the line exactly the listed version `key` of `GET /api/items/:id/takes`: its text,
   * direction, voice override, and take number, so the line plays that very asset. It cannot be
   * combined with other fields. `base` is the line as the sender last saw it; if the line has
   * changed since, or the version cannot be used (`canUse` false), nothing changes and the
   * answer is 409 `stale`.
   */
  restore?: { key: string; base: TrialBase };
};

/** The fields of a line as the sender saw them, to detect an edit made in between. */
export type TrialBase = {
  speaker: string;
  text: string;
  direction?: string;
  voiceSettings?: Record<string, unknown>;
  take: number;
};

/**
 * Body of `POST /api/items/:id/trials`: one trial take of a line with a proposed change. It
 * never writes `scenario.yaml`. `base` is the line as the sender last saw it; if the line has
 * changed, the answer is 409 `stale` and nothing is generated. Without `confirm: true` the
 * answer is a `GeneratePlanResponse` (the plan and cost) and nothing is generated. With a paid
 * provider, `confirm: true` also needs `approved`, as `POST /api/generate` does.
 */
export type TrialRequest = {
  base: TrialBase;
  text?: string;
  direction?: string;
  voiceSettings?: Record<string, unknown>;
  /** The proposal the trial tries; kept in the take history. */
  proposalId?: string;
  confirm?: boolean;
  approved?: ApprovedCost;
};

/** The agents the server can run. Only `claude` has a way to run with no tools (0013). */
export type AgentCommand = "claude";

/** Body of `POST /api/items/:id/proposals`: what the user wants changed, up to 1,000 characters. */
export type ProposalRequest = { instruction: string };

/**
 * What the agent proposes for a line. `base` is the line as the proposal was made from; send it
 * back with the trial. `settings` holds only parameters of the provider, inside their ranges.
 */
export type ProposalView = {
  id: string;
  text?: string;
  direction?: string;
  settings?: Record<string, number | boolean>;
  reason: string;
  base: TrialBase;
};

/** The 200 response of `POST /api/items/:id/proposals`. */
export type ProposalResponse = { proposal: ProposalView };

/** The 200 response of `POST /api/agent-run/cancel`: whether a run was in progress. */
export type CancelAgentResponse = { cancelled: boolean };

/** The 200 response of `POST /api/proposals/:proposalId/discard`. */
export type DiscardProposalResponse = { discarded: true };

/** The 200 response of a trial that generated. */
export type TrialResponse = {
  kind: "trial";
  provider: ProviderInfo;
  /** The cache key of the new asset: the `key` to restore it by. */
  key: string;
  /** The take number the trial used. */
  take: number;
  /** URL of the audio, under `/assets/`. */
  url: string;
  durationSec: number;
};

/** Why a version in the take list cannot be used. `message` is fixed text. */
export type TakeUnavailableInfo = {
  code:
    | "missing-file"
    | "other-provider"
    | "other-voice"
    | "other-speaker-settings"
    | "request-changed"
    | "shadowed";
  message: string;
};

/** One version of a line in `GET /api/items/:id/takes`. */
export type TakeInfo = {
  key: string;
  time: string;
  take: number;
  trial: boolean;
  provider: string;
  /** True if the line's request now has this version's asset. */
  current: boolean;
  text: string;
  direction?: string;
  voiceSettings?: Record<string, unknown>;
  proposalId?: string;
  reason?: string;
  /** URL of the audio under `/assets/`, if the file exists. */
  url?: string;
  durationSec?: number;
  /** True if `PATCH` with `restore` for this key can succeed now. */
  canUse: boolean;
  /** Why `canUse` is false. */
  why?: TakeUnavailableInfo;
};

/** Response of `GET /api/items/:id/takes`: the versions of a line, newest first. */
export type TakesResponse = {
  itemId: string;
  takes: TakeInfo[];
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

/**
 * Body of `POST /api/generate`. The server answers by these rules, for any provider:
 *
 * 1. `dryRun: true`: returns 200 with a `GeneratePlanResponse` and never generates.
 *    `confirm` is ignored.
 * 2. Otherwise, with a free provider (`paid: false`): runs at once and returns 200 with a
 *    `GenerateRunResponse`. `confirm` is ignored.
 * 3. Otherwise, with a paid provider (`paid: true`): runs only with `confirm: true` and an
 *    `approved` cost, and returns 200 with a `GenerateRunResponse`. The server plans again
 *    when the run's turn comes, after any edit sent before it, and runs only if that plan
 *    needs no more characters and no more requests than `approved`. Otherwise, or with
 *    `confirm` absent or false, or `approved` absent or not valid, it generates nothing and
 *    returns 409 with a `ConfirmRequiredError`, which holds the new plan. During the run,
 *    `approved` is also the budget: every paid provider call, including a second call after
 *    a failed one, takes its cost from it before it is sent, and an item whose call would go
 *    past it fails without a call.
 */
export type GenerateRequest = {
  /**
   * Only these item IDs. A BGM uses its scene's ID. All items when absent. An empty list, or
   * an ID that is not in the scenario, is refused with 400 `bad-request`.
   */
  ids?: string[];
  /** True returns the plan only and never generates, for any provider. */
  dryRun?: boolean;
  /** Must be true to run a paid provider. Ignored with `dryRun: true` or a free provider. */
  confirm?: boolean;
  /**
   * The cost of the plan the user approved, sent with `confirm: true`. A paid run needs it.
   * Ignored with `dryRun: true` or a free provider.
   */
  approved?: ApprovedCost;
};

/**
 * The cost the user approved for a paid generation: `plan.cost` of the plan the UI showed.
 * Both are whole numbers, 0 or more.
 */
export type ApprovedCost = {
  characters: number;
  requests: number;
};

/**
 * What a generation would do and its estimated cost: the 200 response of
 * `POST /api/generate` with `dryRun: true`, and the `plan` of a `ConfirmRequiredError`. The
 * UI shows "Generate (N characters)" from `plan.cost.characters`, and sends `plan.cost` as
 * the `approved` cost of the confirm.
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
  /**
   * `message` names only the item's kind and ID, never its text or prompt. For an item
   * refused because its call would go past the approved cost, it adds fixed text that says so.
   */
  | { status: "failed"; message: string }
);

/**
 * The 200 response of `POST /api/generate` that ran the generation: without `dryRun`, with
 * a free provider, or with a paid provider, `confirm: true`, and a plan within `approved`.
 */
export type GenerateRunResponse = {
  kind: "run";
  provider: ProviderInfo;
  /** One result per item, in scenario order. */
  items: GenerateItemResult[];
  /** Number of items that failed. */
  failed: number;
};

/** A 200 response of `POST /api/generate`. `kind` tells the two apart. */
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
  | "stale"
  /** 409: another agent run is in progress (0013). */
  | "busy"
  /** 409: a trial named a proposal that is unknown, expired, discarded, or for another line (0013). */
  | "proposal-gone"
  /** 504: the agent did not answer in time (0013). */
  | "timeout"
  | "server-error";

/**
 * Body of every error response other than 422: 400 `bad-request`, 401 `unauthorized`
 * (missing or wrong token with `--host`), 403 `unauthorized` (without `--host`, a `Host`
 * header that names no allowed host: `localhost`, `127.0.0.1`, `[::1]`, a `.ts.net` name, or
 * one of the server's `allowedHosts`, from `vd serve --allow-host`), 404 `not-found`, 409
 * `confirm-required` (see `ConfirmRequiredError`), 409 `stale` (the line changed since the
 * sender's `base`, or the version cannot be used; nothing changed), and 500 `server-error`. `message` is fixed
 * text.
 */
export type ApiError = {
  error: ApiErrorCode;
  message: string;
};

/**
 * Body of the 409 response of `POST /api/generate`: the provider is paid, `dryRun` is not
 * true, and either `confirm` is absent or false, `approved` is absent or not valid, or the
 * plan now needs more characters or more requests than `approved`. Nothing was generated.
 * `plan` is the same plan a `dryRun: true` request returns at that moment, so the UI can show
 * "Generate (N characters)" and, when the user presses it, send the same request again with
 * `confirm: true` and `approved` set to `plan.plan.cost`.
 */
export type ConfirmRequiredError = ApiError & {
  error: "confirm-required";
  plan: GeneratePlanResponse;
};

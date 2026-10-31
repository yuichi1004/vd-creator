// The review page. See "UI" and "PC and smartphone" in docs/plans/0005-review-ui.md.

import type {
  ChangeEntryView,
  ItemPatchRequest,
  ProjectResponse,
  ScenePatchRequest,
} from "@vd-creator/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AudioContextLike, AudioUnlock, Player, type UnlockState } from "./audio.js";
import { buildMarks, countDraft, groupMarks, loadChangeEntries } from "./changes.js";
import { ApiClient, ApiRequestError, UNKNOWN_ERROR_MESSAGE } from "./client.js";
import { CHANGES_PANEL_ID, ChangesPanel } from "./components/Changes.js";
import { ConfirmDialog, type ConfirmRequest } from "./components/ConfirmDialog.js";
import { ImageLane } from "./components/ImageLane.js";
import { IssueList } from "./components/IssueList.js";
import { LibraryPanel, type LibraryTarget } from "./components/LibraryPanel.js";
import { LineEditor } from "./components/LineEditor.js";
import { PlayerControls } from "./components/PlayerControls.js";
import { type ContextLine, RetakeScreen } from "./components/RetakeScreen.js";
import { SceneList } from "./components/SceneList.js";
import { SettingsScreen } from "./components/SettingsScreen.js";
import { type GenerationStart, nothingSummary, runSummary, startGeneration } from "./generation.js";
import { placeIssues } from "./issues.js";
import { LiveUpdates } from "./live.js";
import { imageAt, itemAt, startOf } from "./playback.js";
import { findLine, lineBase, neighbours, RetakeController, retakePlaceholder } from "./retake.js";
import { buildHash, buildHref, lineRoute, REVIEW_ROUTE, SETTINGS_ROUTE } from "./routes.js";
import { loadSettings, nextQuickSpeed, type Settings, saveSettings } from "./settings.js";
import { useRoute } from "./useRoute.js";

/** Events that arrive within this time of each other reload the project once. */
const COALESCE_MS = 150;
const PHONE_QUERY = "(max-width: 767px)";

type Notice = { text: string; kind: "info" | "error" };

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : UNKNOWN_ERROR_MESSAGE;
}

function createAudioContext(): (() => AudioContextLike) | undefined {
  const Context =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Context ? () => new Context() as unknown as AudioContextLike : undefined;
}

function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setIsPhone(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return isPhone;
}

export function App() {
  const client = useMemo(() => new ApiClient(document.baseURI), []);
  const [project, setProject] = useState<ProjectResponse>();
  const [loadError, setLoadError] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [generating, setGenerating] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmRequest>();
  const [editing, setEditing] = useState<string>();
  const [libraryTarget, setLibraryTarget] = useState<LibraryTarget>();
  const [librarySheetOpen, setLibrarySheetOpen] = useState(false);
  const isPhone = useIsPhone();
  const [changeEntries, setChangeEntries] = useState<ChangeEntryView[]>([]);
  const [changesOpen, setChangesOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  // Screens. The review screen stays mounted under the settings screen, so the player, its
  // position, and the scroll position survive a visit to settings.
  const route = useRoute();
  const onSettings = route.name === "settings";
  const [settings, setSettings] = useState(() => loadSettings());
  const changeSettings = useCallback((next: Settings) => {
    setSettings(next);
    saveSettings(next);
  }, []);
  // True when this page pushed the settings entry, so that Back can pop it.
  const pushedSettings = useRef(false);
  const openSettings = useCallback(() => {
    pushedSettings.current = true;
    window.location.hash = buildHash(SETTINGS_ROUTE);
  }, []);
  const closeSettings = useCallback(() => {
    if (pushedSettings.current) {
      pushedSettings.current = false;
      window.history.back();
    } else {
      // Opened by a link: leave without keeping the settings entry.
      window.location.replace(buildHref(window.location.href, REVIEW_ROUTE));
    }
  }, []);
  // The retake screen of a line (#/line/<id>). It sits on the review screen, which stays mounted.
  const retakeId = route.name === "line" ? route.id : undefined;
  const pushedRetake = useRef(false);
  const openRetake = useCallback((id: string) => {
    pushedRetake.current = true;
    window.location.hash = buildHash(lineRoute(id));
  }, []);
  const closeRetake = useCallback(() => {
    if (pushedRetake.current) {
      pushedRetake.current = false;
      window.history.back();
    } else {
      window.location.replace(buildHref(window.location.href, REVIEW_ROUTE));
    }
  }, []);
  useEffect(() => {
    if (retakeId === undefined) pushedRetake.current = false;
  }, [retakeId]);
  // Focus goes back to the gear button when settings closes (the screen focuses its own heading).
  const settingsButton = useRef<HTMLButtonElement>(null);
  const wasOnSettings = useRef(onSettings);
  useEffect(() => {
    if (!onSettings) pushedSettings.current = false;
    if (wasOnSettings.current && !onSettings) settingsButton.current?.focus();
    wasOnSettings.current = onSettings;
  }, [onSettings]);

  // Player state.
  const unlock = useMemo(() => new AudioUnlock(createAudioContext()), []);
  const [unlockState, setUnlockState] = useState<UnlockState>(unlock.state);
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((n) => n + 1), []);
  const loadServer = useCallback(() => client.getServer(), [client]);
  const player = useMemo(
    () =>
      new Player({
        unlock,
        load: async (file, tempo, signal) => {
          const url = tempo === 1 ? client.assetUrl(file) : client.previewUrl(file, tempo);
          const response = await fetch(url, { credentials: "same-origin", signal });
          if (!response.ok) throw new Error("asset not loaded");
          return response.arrayBuffer();
        },
        onChange: rerender,
      }),
    [unlock, client, rerender],
  );
  // The server says whether it can make pitch-keeping copies (it needs ffmpeg).
  const [serverKeepsPitch, setServerKeepsPitch] = useState(true);
  // The agent that answers instructions on the retake screen. Without one, its box is hidden.
  const [agent, setAgent] = useState<{ command: string }>();
  useEffect(() => {
    let current = true;
    client.getServer().then(
      (server) => {
        if (!current) return;
        setServerKeepsPitch(server.preview.keepPitch);
        setAgent(server.agent);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [client]);
  useEffect(() => {
    player.configure({ speed: settings.speed, keepPitch: settings.keepPitch && serverKeepsPitch });
  }, [player, settings.speed, settings.keepPitch, serverKeepsPitch]);
  const [position, setPosition] = useState(0);
  useEffect(() => unlock.subscribe(setUnlockState), [unlock]);

  // Loading and live updates. A reload that changes nothing keeps the state as it is.
  const lastJson = useRef("");
  // Requests are numbered when they start. An answer older than one already applied is dropped,
  // so a slow response cannot overwrite a newer project.
  const requestCounter = useRef(0);
  const appliedRequest = useRef(0);
  // Counts the answers applied, even those that change nothing, so the details of the marks
  // are read again after every project-changed event.
  const [projectRound, setProjectRound] = useState(0);
  const applyProject = useCallback(
    (next: ProjectResponse, ticket = ++requestCounter.current) => {
      if (ticket < appliedRequest.current) return;
      appliedRequest.current = ticket;
      setProjectRound((n) => n + 1);
      const json = JSON.stringify(next);
      if (json === lastJson.current) return;
      lastJson.current = json;
      setProject(next);
      player.setTimeline(next.timeline);
      setPosition(player.position);
    },
    [player],
  );
  const reload = useCallback(async () => {
    const ticket = ++requestCounter.current;
    try {
      applyProject(await client.getProject(), ticket);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, [client, applyProject]);

  useEffect(() => {
    void reload();
    // One edit sends several events (the scenario and the change log); they reload once.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReload = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void reload();
      }, COALESCE_MS);
    };
    const live = new LiveUpdates({
      url: client.eventsUrl(),
      onChange: scheduleReload,
      createEventSource:
        typeof EventSource === "undefined"
          ? undefined
          : (url) => new EventSource(url, { withCredentials: true }),
    });
    live.start();
    return () => {
      live.stop();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, reload]);

  // The position follows playback.
  useEffect(() => {
    if (!player.isPlaying) {
      setPosition(player.position);
      return;
    }
    const timer = setInterval(() => setPosition(player.position), 200);
    return () => clearInterval(timer);
  });

  // When the phone locks or the tab goes to the background, stop and keep the position.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") {
        player.stop();
        unlock.relock();
      }
    };
    const onPageHide = () => player.stop();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [player, unlock]);

  const showError = useCallback((error: unknown) => {
    setNotice({ text: errorText(error), kind: "error" });
  }, []);

  // The details of the marks. The project says what is marked; the entries only explain it.
  const changedJson = JSON.stringify(project?.changedSinceReview ?? []);
  // The old entries stay shown while the new ones load, and when loading fails.
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectRound triggers the reload
  useEffect(() => {
    if (changedJson === "[]") {
      setChangeEntries([]);
      return;
    }
    let current = true;
    loadChangeEntries(client).then(
      (entries) => current && setChangeEntries(entries),
      () => current && setNotice({ text: "Could not load the change details.", kind: "error" }),
    );
    return () => {
      current = false;
    };
  }, [client, changedJson, projectRound]);

  const markReviewed = useCallback(async () => {
    setReviewing(true);
    const ticket = ++requestCounter.current;
    try {
      applyProject(await client.markReviewed(), ticket);
      setChangesOpen(false);
    } catch (error) {
      showError(error);
    } finally {
      setReviewing(false);
    }
  }, [client, applyProject, showError]);

  const patchItem = useCallback(
    async (id: string, patch: ItemPatchRequest): Promise<boolean> => {
      const ticket = ++requestCounter.current;
      try {
        applyProject(await client.patchItem(id, patch), ticket);
        return true;
      } catch (error) {
        showError(error);
        return false;
      }
    },
    [client, applyProject, showError],
  );

  const patchScene = useCallback(
    async (id: string, patch: ScenePatchRequest): Promise<boolean> => {
      const ticket = ++requestCounter.current;
      try {
        applyProject(await client.patchScene(id, patch), ticket);
        return true;
      } catch (error) {
        showError(error);
        return false;
      }
    },
    [client, applyProject, showError],
  );

  const setBusy = useCallback((id: string, busy: boolean) => {
    setGenerating((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /**
   * Generates one item. With a paid provider this asks for the plan, and runs only when the
   * user presses "Generate (N characters)". `onCancel` undoes what led to the generation.
   */
  const generate = useCallback(
    async (id: string, onCancel?: () => Promise<unknown>) => {
      if (!project) return;
      setBusy(id, true);
      // Shows the outcome of a start or a confirm: a notice, or the confirm dialog, which comes
      // back with the new plan when the server refused a confirm because the plan grew.
      const settle = async (start: GenerationStart): Promise<void> => {
        if (start.kind !== "confirm") {
          const text = start.kind === "done" ? runSummary(start.run) : nothingSummary(start.plan);
          setNotice({ text, kind: "info" });
          await reload();
          setBusy(id, false);
          return;
        }
        setConfirm({
          plan: start.plan,
          changed: start.changed,
          onConfirm: async () => {
            setConfirm(undefined);
            try {
              await settle(await start.confirm());
            } catch (error) {
              showError(error);
              setBusy(id, false);
            }
          },
          onCancel: async () => {
            setConfirm(undefined);
            setBusy(id, false);
            await onCancel?.();
          },
        });
      };
      try {
        await settle(await startGeneration(client, project.provider, [id]));
      } catch (error) {
        showError(error);
        setBusy(id, false);
      }
    },
    [client, project, reload, setBusy, showError],
  );

  /** Increments the take and generates the item. A cancelled paid generation restores it. */
  const regenerate = useCallback(
    async (id: string, take: number) => {
      if (!(await patchItem(id, { take: take + 1 }))) return;
      await generate(id, () => patchItem(id, { take }));
    },
    [patchItem, generate],
  );

  const play = useCallback(
    (fromSec?: number) => {
      // Called inside the tap: `play` unlocks audio before its first await.
      void player.play(fromSec);
    },
    [player],
  );

  const playFrom = useCallback(
    (id: string) => {
      const timeline = project?.timeline;
      const start = timeline && startOf(timeline, id);
      if (start !== undefined) play(start);
    },
    [project, play],
  );

  // The controller of the retake screen. It reads the line from the latest project, so a reload
  // after a stale answer shows in its next request.
  const projectRef = useRef(project);
  projectRef.current = project;
  const paid = project?.provider.paid ?? false;
  // It is created when a line opens and disposed when the screen is left or another line opens,
  // so that a late plan of one line never opens a dialog on the next.
  const [retakeController, setRetakeController] = useState<RetakeController>();
  useEffect(() => {
    if (retakeId === undefined) {
      setRetakeController(undefined);
      return;
    }
    // The confirm step this controller has open, if any.
    let closeOpen: (() => void) | undefined;
    const controller = new RetakeController({
      client,
      itemId: retakeId,
      paid,
      getBase: () => {
        const line = findLine(projectRef.current?.scenario, retakeId);
        return line && lineBase(line);
      },
      applyProject: (next) => applyProject(next),
      reload,
      askConfirm: (plan, changed) =>
        new Promise<boolean>((resolve) => {
          const finish = (answer: boolean) => {
            closeOpen = undefined;
            setConfirm(undefined);
            resolve(answer);
          };
          closeOpen = () => finish(false);
          setConfirm({
            plan,
            changed,
            onConfirm: () => finish(true),
            onCancel: () => finish(false),
          });
        }),
      closeConfirm: () => closeOpen?.(),
    });
    setRetakeController(controller);
    return () => controller.dispose();
  }, [client, retakeId, paid, applyProject, reload]);
  // Never the controller of another line, for the render before the effect has run.
  const retake = retakeController?.itemId === retakeId ? retakeController : undefined;

  const openLibrary = useCallback(
    (target: LibraryTarget) => {
      setLibraryTarget(target);
      if (isPhone) setLibrarySheetOpen(true);
    },
    [isPhone],
  );

  const applyLibraryEntry = useCallback(
    async (entryId: string) => {
      if (!libraryTarget) return;
      const ok =
        libraryTarget.kind === "sfx"
          ? await patchItem(libraryTarget.id, { source: { library: entryId } })
          : await patchScene(libraryTarget.id, { bgm: { library: entryId } });
      if (!ok) return;
      setLibrarySheetOpen(false);
      // Library items are resolved, not generated, and cost nothing.
      await generate(libraryTarget.id);
    },
    [libraryTarget, patchItem, patchScene, generate],
  );

  // The settings screen needs no project, so it opens even when the project fails to load.
  const settingsPage = onSettings ? (
    <div className={`app settings-page ${isPhone ? "phone" : "pc"}`}>
      <SettingsScreen
        settings={settings}
        onChange={changeSettings}
        loadServer={loadServer}
        onBack={closeSettings}
      />
    </div>
  ) : undefined;

  if (!project) {
    if (onSettings) return <>{settingsPage}</>;
    return (
      <main className="app loading">
        <p role="status">{loadError ?? "Loading…"}</p>
        {loadError && (
          <button type="button" onClick={() => void reload()}>
            Retry
          </button>
        )}
        {loadError && (
          <button type="button" onClick={openSettings}>
            Settings
          </button>
        )}
      </main>
    );
  }

  const { scenario, timeline, provider } = project;
  const placed = placeIssues(scenario, project.issues, project.licenseIssues);
  const currentImage = timeline ? imageAt(timeline, position) : undefined;
  const currentItem = timeline ? itemAt(timeline, position) : undefined;
  const marks = buildMarks(project.changedSinceReview, changeEntries);
  const draftCount = countDraft(timeline);
  const editingLine = editing
    ? scenario?.scenes.flatMap((s) => s.items).find((i) => "line" in i && i.id === editing)
    : undefined;

  const retakeLine = retakeId !== undefined ? findLine(scenario, retakeId) : undefined;
  const speakerName = (id: string) => scenario?.speakers.find((s) => s.id === id)?.name ?? id;
  const fileOf = (id: string) => {
    const entry = timeline?.items.find((i) => i.id === id);
    return entry && !entry.missing ? entry.assetFile : undefined;
  };
  const contextLine = (item: ReturnType<typeof findLine>): ContextLine | undefined =>
    item && {
      id: item.id,
      speaker: speakerName(item.speaker),
      text: item.line,
      file: fileOf(item.id),
    };
  const around = retakeId !== undefined ? neighbours(scenario, retakeId) : undefined;
  const retakeScreen =
    retakeId === undefined ? undefined : retakeLine && retake ? (
      <RetakeScreen
        // Each line starts with its own state.
        key={retakeId}
        controller={retake}
        client={client}
        line={retakeLine}
        speakerName={speakerName(retakeLine.speaker)}
        before={contextLine(around?.before)}
        after={contextLine(around?.after)}
        currentFile={fileOf(retakeLine.id)}
        agent={agent}
        speed={settings.speed}
        generating={generating.has(retakeLine.id)}
        onRegenerate={() => void regenerate(retakeLine.id, retakeLine.take)}
        onClose={closeRetake}
      />
    ) : (
      <section className="retake" aria-label="Retake">
        <p role="status">{retakePlaceholder(scenario, retakeId, retake !== undefined)}</p>
        <button type="button" onClick={closeRetake}>
          Back
        </button>
      </section>
    );

  const controls = (
    <PlayerControls
      playing={player.isPlaying}
      unlockState={unlockState}
      position={position}
      duration={timeline?.durationSec ?? 0}
      disabled={!timeline}
      loading={player.isLoading}
      speed={settings.speed}
      onSpeed={() => changeSettings({ ...settings, speed: nextQuickSpeed(settings.speed) })}
      onPlay={() => play()}
      onStop={() => player.stop()}
      onRestart={() => play(0)}
    />
  );
  const imageView = currentImage?.file ? (
    <img
      className="current-image"
      src={client.assetUrl(currentImage.file)}
      alt={currentImage.imageId}
    />
  ) : (
    <div className="current-image empty">No image</div>
  );
  const library = project.library ? (
    <LibraryPanel
      client={client}
      target={libraryTarget}
      onUse={(id) => void applyLibraryEntry(id)}
      onClose={isPhone ? () => setLibrarySheetOpen(false) : undefined}
      onError={showError}
    />
  ) : undefined;

  return (
    <>
      {settingsPage}
      <div className={`app ${isPhone ? "phone" : "pc"}`} hidden={onSettings}>
        <header className="app-header">
          <h1>{scenario?.title ?? "vd-creator"}</h1>
          <span className={`provider ${provider.paid ? "paid" : "free"}`}>
            {provider.id}
            {provider.paid ? " (paid)" : ""}
          </span>
          {draftCount > 0 && (
            <span className="status draft" title="Audio made by the free provider">
              {draftCount} draft
            </span>
          )}
          {marks.size > 0 && (
            <button
              type="button"
              className="changed-mark"
              aria-expanded={changesOpen}
              aria-controls={changesOpen ? CHANGES_PANEL_ID : undefined}
              onClick={() => setChangesOpen(!changesOpen)}
            >
              {marks.size} changed
            </button>
          )}
          {!isPhone && controls}
          <button
            ref={settingsButton}
            type="button"
            className="icon settings-button"
            onClick={openSettings}
          >
            <span aria-hidden="true">⚙</span>
            <span className="visually-hidden">Settings</span>
          </button>
        </header>

        {changesOpen && marks.size > 0 && (
          <ChangesPanel
            groups={groupMarks(marks, scenario)}
            busy={reviewing}
            onMarkReviewed={() => void markReviewed()}
          />
        )}

        {notice && (
          <div
            className={`notice ${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            <span>{notice.text}</span>
            <button type="button" className="link" onClick={() => setNotice(undefined)}>
              Dismiss
            </button>
          </div>
        )}
        {loadError && (
          <div className="notice error" role="alert">
            {loadError}
          </div>
        )}

        {isPhone && timeline && <div className="image-strip">{imageView}</div>}

        <div className="layout">
          <main className="main-column">
            <IssueList issues={placed.general} />
            {timeline && (
              <ImageLane
                timeline={timeline}
                client={client}
                current={currentImage}
                onSeek={(sec) => player.seek(sec)}
              />
            )}
            {scenario && (
              <SceneList
                scenario={scenario}
                timeline={timeline}
                issues={placed.byItem}
                generating={generating}
                currentItemId={currentItem?.id}
                isPhone={isPhone}
                hasLibrary={project.library}
                libraryTarget={libraryTarget}
                marks={marks}
                onPatchItem={patchItem}
                onPatchScene={patchScene}
                onRegenerate={(id, take) => void regenerate(id, take)}
                onGenerate={(id) => void generate(id)}
                onPlayFrom={playFrom}
                onEditLine={setEditing}
                onRetake={openRetake}
                onOpenLibrary={openLibrary}
              />
            )}
          </main>
          {!isPhone && (
            <aside className="side-panel">
              {retakeScreen}
              {imageView}
              {library}
            </aside>
          )}
        </div>

        {isPhone && <footer className="bottom-bar">{controls}</footer>}

        {isPhone && retakeScreen && (
          <div className="sheet retake-sheet" role="dialog" aria-modal="true" aria-label="Retake">
            {retakeScreen}
          </div>
        )}

        {isPhone && librarySheetOpen && library && (
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Library">
            {library}
          </div>
        )}

        {editingLine && "line" in editingLine && scenario && (
          <LineEditor
            item={editingLine}
            speakers={scenario.speakers}
            generating={generating.has(editingLine.id)}
            onSave={async (patch) => {
              if (await patchItem(editingLine.id, patch)) setEditing(undefined);
            }}
            onRegenerate={() => void regenerate(editingLine.id, editingLine.take)}
            onCancel={() => setEditing(undefined)}
          />
        )}

        {confirm && <ConfirmDialog request={confirm} />}
      </div>
    </>
  );
}

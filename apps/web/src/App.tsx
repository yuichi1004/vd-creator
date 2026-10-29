// The review page. See "UI" and "PC and smartphone" in docs/plans/0005-review-ui.md.

import type { ItemPatchRequest, ProjectResponse, ScenePatchRequest } from "@vd-creator/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AudioContextLike, AudioUnlock, Player, type UnlockState } from "./audio.js";
import { ApiClient, ApiRequestError, UNKNOWN_ERROR_MESSAGE } from "./client.js";
import { ConfirmDialog, type ConfirmRequest } from "./components/ConfirmDialog.js";
import { ImageLane } from "./components/ImageLane.js";
import { IssueList } from "./components/IssueList.js";
import { LibraryPanel, type LibraryTarget } from "./components/LibraryPanel.js";
import { LineEditor } from "./components/LineEditor.js";
import { PlayerControls } from "./components/PlayerControls.js";
import { SceneList } from "./components/SceneList.js";
import { runSummary, startGeneration } from "./generation.js";
import { placeIssues } from "./issues.js";
import { LiveUpdates } from "./live.js";
import { imageAt, itemAt, startOf } from "./playback.js";

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

  // Player state.
  const unlock = useMemo(() => new AudioUnlock(createAudioContext()), []);
  const [unlockState, setUnlockState] = useState<UnlockState>(unlock.state);
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((n) => n + 1), []);
  const player = useMemo(
    () =>
      new Player({
        unlock,
        load: async (file) => {
          const response = await fetch(client.assetUrl(file), { credentials: "same-origin" });
          if (!response.ok) throw new Error("asset not loaded");
          return response.arrayBuffer();
        },
        onChange: rerender,
      }),
    [unlock, client, rerender],
  );
  const [position, setPosition] = useState(0);
  useEffect(() => unlock.subscribe(setUnlockState), [unlock]);

  // Loading and live updates. A reload that changes nothing keeps the state as it is.
  const lastJson = useRef("");
  const applyProject = useCallback(
    (next: ProjectResponse) => {
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
    try {
      applyProject(await client.getProject());
      setLoadError(undefined);
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, [client, applyProject]);

  useEffect(() => {
    void reload();
    const live = new LiveUpdates({
      url: client.eventsUrl(),
      onChange: () => void reload(),
      createEventSource:
        typeof EventSource === "undefined"
          ? undefined
          : (url) => new EventSource(url, { withCredentials: true }),
    });
    live.start();
    return () => live.stop();
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

  const patchItem = useCallback(
    async (id: string, patch: ItemPatchRequest): Promise<boolean> => {
      try {
        applyProject(await client.patchItem(id, patch));
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
      try {
        applyProject(await client.patchScene(id, patch));
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
      try {
        const start = await startGeneration(client, project.provider, [id]);
        if (start.kind === "done") {
          setNotice({ text: runSummary(start.run), kind: "info" });
          await reload();
          setBusy(id, false);
          return;
        }
        setConfirm({
          plan: start.plan,
          onConfirm: async () => {
            setConfirm(undefined);
            try {
              const run = await start.confirm();
              setNotice({ text: runSummary(run), kind: "info" });
              await reload();
            } catch (error) {
              showError(error);
            } finally {
              setBusy(id, false);
            }
          },
          onCancel: async () => {
            setConfirm(undefined);
            setBusy(id, false);
            await onCancel?.();
          },
        });
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

  if (!project) {
    return (
      <main className="app loading">
        <p role="status">{loadError ?? "Loading…"}</p>
        {loadError && (
          <button type="button" onClick={() => void reload()}>
            Retry
          </button>
        )}
      </main>
    );
  }

  const { scenario, timeline, provider } = project;
  const placed = placeIssues(scenario, project.issues, project.licenseIssues);
  const currentImage = timeline ? imageAt(timeline, position) : undefined;
  const currentItem = timeline ? itemAt(timeline, position) : undefined;
  const editingLine = editing
    ? scenario?.scenes.flatMap((s) => s.items).find((i) => "line" in i && i.id === editing)
    : undefined;

  const controls = (
    <PlayerControls
      playing={player.isPlaying}
      unlockState={unlockState}
      position={position}
      duration={timeline?.durationSec ?? 0}
      disabled={!timeline}
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
    <div className={`app ${isPhone ? "phone" : "pc"}`}>
      <header className="app-header">
        <h1>{scenario?.title ?? "vd-creator"}</h1>
        <span className={`provider ${provider.paid ? "paid" : "free"}`}>
          {provider.id}
          {provider.paid ? " (paid)" : ""}
        </span>
        {!isPhone && controls}
      </header>

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
              onPatchItem={patchItem}
              onPatchScene={patchScene}
              onRegenerate={(id, take) => void regenerate(id, take)}
              onGenerate={(id) => void generate(id)}
              onPlayFrom={playFrom}
              onEditLine={setEditing}
              onOpenLibrary={openLibrary}
            />
          )}
        </main>
        {!isPhone && (
          <aside className="side-panel">
            {imageView}
            {library}
          </aside>
        )}
      </div>

      {isPhone && <footer className="bottom-bar">{controls}</footer>}

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
  );
}

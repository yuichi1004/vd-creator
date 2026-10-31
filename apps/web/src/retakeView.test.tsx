import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseScenario } from "@vd-creator/scenario";
import type { TakeInfo } from "@vd-creator/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { type RetakeActions, RetakeView } from "./components/RetakeScreen.js";
import { SceneList } from "./components/SceneList.js";
import { SequencePlayer } from "./contextAudio.js";
import type { RetakeState } from "./retake.js";
import type { LineItem, Scenario, Timeline } from "./types.js";

const SAMPLE = fileURLToPath(
  new URL("../../../packages/scenario/fixtures/sample.yaml", import.meta.url),
);

const noop = () => {};

const LINE = { id: "l1", speaker: "a", line: "Hello.", take: 1 } as unknown as LineItem;

const IDLE: RetakeState = {
  takes: [],
  takesError: undefined,
  asking: false,
  proposal: undefined,
  trial: undefined,
  working: undefined,
  message: undefined,
};

const ACTIONS: RetakeActions = {
  ask: noop,
  cancel: noop,
  discard: noop,
  tryProposal: noop,
  tryEdit: noop,
  editProposal: noop,
  keep: noop,
  dropTrial: noop,
  takeBack: noop,
  regenerate: noop,
  play: noop,
  stop: noop,
  close: noop,
  dismiss: noop,
};

function view(state: Partial<RetakeState>, agent: { command: string } | undefined) {
  return renderToStaticMarkup(
    <RetakeView
      line={LINE}
      speakerName="Ann"
      before={{ id: "l0", speaker: "Bob", text: "Before text", file: "l0.mp3" }}
      after={{ id: "l2", speaker: "Bob", text: "After text", file: "l2.mp3" }}
      currentFile="l1.mp3"
      state={{ ...IDLE, ...state }}
      agent={agent}
      assetUrl={(file) => `/assets/${file}`}
      playingId={undefined}
      generating={false}
      actions={ACTIONS}
    />,
  );
}

const take = (key: string, canUse: boolean): TakeInfo =>
  ({
    key,
    time: "2026-10-31T09:00:00.000Z",
    take: 1,
    trial: false,
    provider: "mock",
    current: false,
    text: `text ${key}`,
    url: `/assets/${key}.mp3`,
    canUse,
    ...(canUse ? {} : { why: { code: "other", message: `why ${key}` } }),
  }) as TakeInfo;

describe("the retake screen", () => {
  test("shows the line in context with a play-in-a-row button", () => {
    const markup = view({}, undefined);
    expect(markup).toContain("Before text");
    expect(markup).toContain("After text");
    expect(markup).toContain("Play in context");
  });

  test("hides the agent box without an agent", () => {
    expect(view({}, undefined)).not.toContain("Ask the agent");
    const withAgent = view({}, { command: "claude" });
    expect(withAgent).toContain("Ask the agent");
    expect(withAgent).toContain(">Ask<");
  });

  test("shows Cancel and a status while the agent works", () => {
    const markup = view({ asking: true }, { command: "claude" });
    expect(markup).toContain("Cancel");
    expect(markup).toContain("The agent is working");
    expect(markup).not.toContain(">Ask<");
  });

  test("shows the proposal diff with Try it, Edit, and Discard", () => {
    const markup = view(
      {
        proposal: {
          id: "p1",
          text: "Hello!",
          reason: "More energy",
          base: { speaker: "a", text: "Hello.", take: 1 },
        },
      },
      { command: "claude" },
    );
    for (const word of ["More energy", "Hello.", "Hello!", "Try it", "Edit", "Discard"]) {
      expect(markup).toContain(word);
    }
  });

  test("shows Keep and Not this one for a trial take", () => {
    const markup = view(
      {
        trial: {
          key: "t1",
          take: 2,
          url: "/assets/t1.mp3",
          durationSec: 1,
          base: { speaker: "a", text: "Hello.", take: 1 },
        },
      },
      undefined,
    );
    expect(markup).toContain(">Keep<");
    expect(markup).toContain("Not this one");
  });

  test("offers Use this take only where the server allows it, and says why elsewhere", () => {
    const markup = view({ takes: [take("ok", true), take("no", false)] }, undefined);
    expect(markup.match(/Use this take/g)).toHaveLength(1);
    expect(markup).toContain("why no");
    expect(markup).not.toContain("why ok");
  });

  test("shows the message with a way to dismiss it", () => {
    const markup = view({ message: { text: "It was reloaded.", kind: "error" } }, undefined);
    expect(markup).toContain("It was reloaded.");
    expect(markup).toContain("Dismiss");
  });
});

describe("the line card", () => {
  async function list(isPhone: boolean) {
    const { scenario } = parseScenario(await readFile(SAMPLE, "utf8"));
    if (!scenario) throw new Error("the sample is not valid");
    const timeline: Timeline = { items: [], images: [], bgm: [], scenes: [], durationSec: 0 };
    return renderToStaticMarkup(
      <SceneList
        scenario={scenario as Scenario}
        timeline={timeline}
        issues={new Map()}
        generating={new Set()}
        currentItemId={undefined}
        isPhone={isPhone}
        hasLibrary={false}
        libraryTarget={undefined}
        onPatchItem={async () => true}
        onPatchScene={async () => true}
        onRegenerate={noop}
        onGenerate={noop}
        onPlayFrom={noop}
        onEditLine={noop}
        onRetake={noop}
        onOpenLibrary={noop}
      />,
    );
  }

  test("on a phone, every line card shows Retake without a tap", async () => {
    const markup = await list(true);
    expect(markup).toContain("retake-button");
    expect(markup).toContain("Retake");
  });

  test("on a PC, the line's controls have Retake too", async () => {
    expect(await list(false)).toContain("retake-button");
  });
});

describe("the sequence player", () => {
  function fake() {
    const played: string[] = [];
    const audio = {
      src: "",
      playbackRate: 1,
      onended: null as null | (() => void),
      onerror: null,
      play: async () => {
        played.push(audio.src);
      },
      pause: noop,
    };
    return { audio, played };
  }

  test("plays the files one after another and reuses one element", () => {
    const { audio, played } = fake();
    let created = 0;
    const player = new SequencePlayer(() => {
      created += 1;
      return audio;
    });
    player.play(["a", "b", "c"], 1.25, "row");
    expect(player.id).toBe("row");
    expect(audio.playbackRate).toBe(1.25);
    audio.onended?.();
    audio.onended?.();
    audio.onended?.();
    expect(played).toEqual(["a", "b", "c"]);
    expect(player.playing).toBe(false);
    expect(created).toBe(1);
  });

  test("stop ends the row", () => {
    const { audio } = fake();
    const player = new SequencePlayer(() => audio);
    player.play(["a", "b"], 1, "row");
    player.stop();
    expect(player.playing).toBe(false);
    expect(player.id).toBeUndefined();
  });
});

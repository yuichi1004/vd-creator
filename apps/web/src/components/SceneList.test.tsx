import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseScenario } from "@vd-creator/scenario";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Scenario, Timeline } from "../types.js";
import { SceneList } from "./SceneList.js";

const SAMPLE = fileURLToPath(
  new URL("../../../../packages/scenario/fixtures/sample.yaml", import.meta.url),
);

/** The text of the rendered markup, as a browser would give it for copying. */
function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

test("an item's start time is separated from its label by a space", async () => {
  const { scenario } = parseScenario(await readFile(SAMPLE, "utf8"));
  if (!scenario) throw new Error("the sample is not valid");
  const timeline: Timeline = {
    items: [
      { kind: "image", sceneId: "s1", index: 0, startSec: 0, durationSec: 0 },
      { kind: "pause", sceneId: "s1", index: 4, startSec: 3, durationSec: 1.5 },
    ],
    images: [],
    bgm: [],
    scenes: [],
    durationSec: 4.5,
  };
  const noop = () => {};
  const markup = renderToStaticMarkup(
    <SceneList
      scenario={scenario as Scenario}
      timeline={timeline}
      issues={new Map()}
      generating={new Set()}
      currentItemId={undefined}
      isPhone={false}
      hasLibrary={false}
      libraryTarget={undefined}
      onPatchItem={async () => true}
      onPatchScene={async () => true}
      onRegenerate={noop}
      onGenerate={noop}
      onPlayFrom={noop}
      onEditLine={noop}
      onOpenLibrary={noop}
    />,
  );
  const rendered = text(markup);
  expect(rendered).toContain("0:00 Image shore");
  expect(rendered).toContain("0:03 Pause 1.5 s");
  expect(rendered).not.toContain("0:00Image");
});

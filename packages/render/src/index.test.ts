import { expect, test } from "vitest";
import * as render from "./index.js";

test("exports the audio mix, ffmpeg, and subtitle functions", () => {
  expect(typeof render.buildAudioMixArgs).toBe("function");
  expect(typeof render.renderAudio).toBe("function");
  expect(typeof render.runFfmpeg).toBe("function");
  expect(typeof render.buildSrt).toBe("function");
});

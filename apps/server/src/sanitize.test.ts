import { describe, expect, test } from "vitest";
import { HIDDEN_PATH, type MessageRoot, sanitizeMessage } from "./sanitize.js";

const roots: MessageRoot[] = [
  { dir: "/work/drama", name: "the project folder" },
  { dir: "/work/drama/lib", name: "the library" },
];

describe("sanitizeMessage", () => {
  test("keeps a message without paths or excerpts", () => {
    const message = "sfx:door is not copied into the project yet; run vd generate";
    expect(sanitizeMessage(message, roots)).toBe(message);
  });

  test("drops a parser's source excerpt and says what to run", () => {
    const message =
      'Cannot look up "door" until these are fixed: Invalid YAML: Map keys must be unique at line 3, column 1:\n\nfile: /private/sound-library/recording.wav\nfile: x\n^\n';
    expect(sanitizeMessage(message, roots)).toBe(
      'Cannot look up "door" until these are fixed: Invalid YAML: Map keys must be unique at line 3, column 1 (details omitted; run vd validate)',
    );
  });

  test("shows paths in a root relative to the innermost root", () => {
    expect(sanitizeMessage("Cannot read /work/drama/assets/a.wav", roots)).toBe(
      "Cannot read assets/a.wav",
    );
    expect(sanitizeMessage('Missing "/work/drama/lib/sfx/door/entry.yaml"', roots)).toBe(
      'Missing "sfx/door/entry.yaml"',
    );
    expect(sanitizeMessage("Cannot read /work/drama/lib", roots)).toBe("Cannot read the library");
  });

  test("hides any other absolute path", () => {
    expect(sanitizeMessage('Unrecognized key: "/private/credits/secret.wav"', roots)).toBe(
      `Unrecognized key: "${HIDDEN_PATH}"`,
    );
    expect(sanitizeMessage("Cannot read /work/drama2/a.wav", roots)).toBe(
      `Cannot read ${HIDDEN_PATH}`,
    );
    expect(sanitizeMessage("At C:\\Users\\me\\a.wav and ~/a.wav", roots)).toBe(
      `At ${HIDDEN_PATH} and ${HIDDEN_PATH}`,
    );
    expect(sanitizeMessage("See file:///home/me/a.wav", roots)).toBe(`See ${HIDDEN_PATH}`);
  });

  test("leaves relative paths alone", () => {
    const message = "sfx/door/entry.yaml: license.id: Required";
    expect(sanitizeMessage(message, roots)).toBe(message);
  });
});

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ChangeLockError, LOCK_FILE, readEntries, withProjectLock } from "./index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-core-lock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const gatePath = () => join(dir, `${LOCK_FILE}.break`);

describe("the gate", () => {
  test("a gate left by a process that stopped is removed", async () => {
    await writeFile(gatePath(), "");
    const old = new Date(Date.now() - 60_000);
    await utimes(gatePath(), old, old);
    await writeFile(
      join(dir, LOCK_FILE),
      JSON.stringify({ pid: 2 ** 22 + 1, time: old.toISOString(), token: "dead" }),
    );
    expect(await withProjectLock(dir, async () => "ran", { waitMs: 1000 })).toBe("ran");
    await expect(readFile(gatePath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a gate in use is kept, and the release gives up at its deadline", async () => {
    await expect(
      withProjectLock(dir, async () => writeFile(gatePath(), ""), { waitMs: 150 }),
    ).rejects.toThrow(ChangeLockError);
    // The live gate was not removed by the waiting release.
    expect(await readFile(gatePath(), "utf8")).toBe("");
  });

  test("a release that fails does not hide the error of the work", async () => {
    await expect(
      withProjectLock(
        dir,
        async () => {
          await writeFile(gatePath(), "");
          throw new Error("boom");
        },
        { waitMs: 100 },
      ),
    ).rejects.toThrow("boom");
  });
});

describe("processes racing for the lock", () => {
  const dist = fileURLToPath(new URL("../../dist/changes/index.js", import.meta.url));
  const script = `
import { appendFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [dist, dir, name, rounds, crash] = process.argv.slice(2);
const { appendEntries, withProjectLock } = await import(dist);
const options = { waitMs: 30000, pollMs: 5 };
if (crash === "crash") {
  // Stop while holding the lock: the next holder takes it over.
  await withProjectLock(dir, async () => process.exit(0), options);
}
for (let i = 0; i < Number(rounds); i++) {
  await withProjectLock(dir, async () => {
    const holder = join(dir, "holder");
    try {
      await writeFile(holder, name, { flag: "wx" });
    } catch {
      await appendFile(join(dir, "overlaps"), name + "\\n");
    }
    await appendEntries(dir, [{ source: "review" }]);
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
    await rm(holder, { force: true });
  }, options);
}
`;

  const run = (file: string, ...args: string[]) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [file, dist, dir, ...args]);
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("close", (code) => resolve({ code, stderr }));
    });

  test("acquiring, taking over, and releasing never overlap, and entry IDs stay unique", async () => {
    // Run `npm run build` first: the children use the compiled code.
    expect(existsSync(dist), `${dist} is missing`).toBe(true);
    const file = join(dir, "child.mjs");
    await writeFile(file, script);
    // A gate left long ago must not stand in the way.
    await writeFile(gatePath(), "");
    const old = new Date(Date.now() - 60_000);
    await utimes(gatePath(), old, old);

    const rounds = 12;
    const workers = ["a", "b", "c", "d"];
    const results = await Promise.all([
      run(file, "crasher", "0", "crash"),
      ...workers.map((name) => run(file, name, String(rounds), "run")),
    ]);
    for (const r of results) expect(r, r.stderr).toMatchObject({ code: 0 });

    await expect(readFile(join(dir, "overlaps"))).rejects.toMatchObject({ code: "ENOENT" });
    const ids = (await readEntries(dir)).map((e) => e.id);
    expect(ids).toEqual(Array.from({ length: workers.length * rounds }, (_, i) => i + 1));
  }, 90_000);
});

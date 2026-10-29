#!/usr/bin/env node
// Checked-in launcher for the vd command. npm links bins at install time, before the
// first build, so the bin entry must point at a file that exists in the source tree.
import { existsSync } from "node:fs";

const target = new URL("../dist/bin.js", import.meta.url);
if (!existsSync(target)) {
  process.stderr.write("vd: not built yet; run npm run build in the vd-creator repository\n");
  process.exitCode = 1;
} else {
  try {
    await import(target.href);
  } catch (e) {
    // A stale or partial build, for example after a pull. Node's message and stack hold
    // absolute paths, so they are shown only with VD_DEBUG=1.
    const code = typeof e?.code === "string" ? ` (${e.code})` : "";
    process.stderr.write(`vd: cannot load the build${code}; run npm run build\n`);
    if (process.env.VD_DEBUG === "1") process.stderr.write(`${e?.stack ?? e}\n`);
    process.exitCode = 1;
  }
}

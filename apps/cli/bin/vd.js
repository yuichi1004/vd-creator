#!/usr/bin/env node
// Checked-in launcher for the vd command. npm links bins at install time, before the
// first build, so the bin entry must point at a file that exists in the source tree.
import { existsSync } from "node:fs";

const target = new URL("../dist/bin.js", import.meta.url);
if (existsSync(target)) {
  await import(target.href);
} else {
  process.stderr.write("vd: not built yet; run npm run build in the vd-creator repository\n");
  process.exitCode = 1;
}

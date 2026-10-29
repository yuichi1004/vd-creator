#!/usr/bin/env node
import { EXIT_FAILURE, run } from "./cli.js";

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (e) {
  // Unexpected errors, such as permission problems, get one line instead of a stack trace.
  process.stderr.write(`vd: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = EXIT_FAILURE;
}

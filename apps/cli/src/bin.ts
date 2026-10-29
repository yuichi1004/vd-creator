// Entry point of the vd command, started by the checked-in launcher bin/vd.js.
import { run } from "./cli.js";

process.exitCode = await run(process.argv.slice(2));

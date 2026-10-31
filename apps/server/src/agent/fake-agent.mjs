// A fake agent command for the tests. It never calls a real agent or any network.
//
// It records what it got (arguments, stdin, working folder, process IDs) in
// $FAKE_AGENT_DIR/record.json, then acts as $FAKE_AGENT_MODE says:
//   ok       print a claude-style JSON envelope whose `result` is $FAKE_AGENT_RESULT
//   raw      print $FAKE_AGENT_RAW as it is
//   fail     exit with status 1
//   big      print more than 64 KB
//   bigerr   print more than 16 KB on stderr, then wait
//   hang     wait until it is stopped
//   child    start a child process in the same process group, record its ID, and wait
//   stubborn ignore SIGTERM and wait, so that only SIGKILL ends it

import { spawn } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_AGENT_DIR ?? process.cwd();
const mode = process.env.FAKE_AGENT_MODE ?? "ok";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => start());

function wait() {
  setInterval(() => {}, 1000);
}

function start() {
  const record = {
    argv: process.argv.slice(2),
    stdin: input,
    cwd: process.cwd(),
    cwdFiles: readdirSync(process.cwd()),
    pid: process.pid,
  };
  if (mode === "child") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    record.childPid = child.pid;
  }
  if (mode === "stubborn") process.on("SIGTERM", () => {});
  writeFileSync(join(dir, "record.json"), JSON.stringify(record));

  switch (mode) {
    case "ok":
      process.stdout.write(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: process.env.FAKE_AGENT_RESULT,
        }),
      );
      break;
    case "raw":
      process.stdout.write(process.env.FAKE_AGENT_RAW ?? "");
      break;
    case "fail":
      process.stderr.write("the fake agent failed: SECRET-FROM-AGENT");
      process.exit(1);
      break;
    case "big":
      process.stdout.write("x".repeat(70 * 1024));
      wait();
      break;
    case "bigerr":
      process.stderr.write("e".repeat(20 * 1024));
      wait();
      break;
    default:
      wait();
  }
}

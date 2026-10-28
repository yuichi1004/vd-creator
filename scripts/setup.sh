#!/usr/bin/env bash
# Sets up a fresh clone or worktree: checks system dependencies and installs packages.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "setup: error: $1" >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "node is not installed. Install Node.js 22 or later (see .nvmrc)."
fi

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  fail "Node.js 22 or later is required, but found $(node --version). Install Node.js 22 or later (see .nvmrc)."
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is not installed. It normally comes with Node.js."
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  fail "ffmpeg is not installed or not on PATH. Install it with your package manager, for example 'apt install ffmpeg' or 'brew install ffmpeg'."
fi

echo "setup: node $(node --version), ffmpeg found"
echo "setup: running npm ci"
npm ci

echo "setup: done"

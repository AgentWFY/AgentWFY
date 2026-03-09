#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ELECTRON="$ROOT_DIR/node_modules/.bin/electron"

cleanup() {
  trap '' EXIT INT TERM
  [ -n "$ESBUILD_PID" ] && kill "$ESBUILD_PID" 2>/dev/null
  wait 2>/dev/null
  exit
}
trap cleanup EXIT INT TERM

node "$ROOT_DIR/scripts/build.mjs" --watch &
ESBUILD_PID=$!

# Wait for initial build
while [ ! -f "$ROOT_DIR/dist/client/index.js" ]; do
  sleep 0.2
done

NODE_OPTIONS="--disable-warning=ExperimentalWarning" "$ELECTRON" "$ROOT_DIR"

#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# In a git worktree, symlink node_modules from the main worktree
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  MAIN_WORKTREE=$(git -C "$ROOT_DIR" worktree list --porcelain | head -1 | sed 's/^worktree //')
  if [ -n "$MAIN_WORKTREE" ] && [ "$MAIN_WORKTREE" != "$ROOT_DIR" ] && [ -d "$MAIN_WORKTREE/node_modules" ]; then
    ln -s "$MAIN_WORKTREE/node_modules" "$ROOT_DIR/node_modules"
  fi
fi

ELECTRON="$ROOT_DIR/node_modules/.bin/electron"

cleanup() {
  trap '' EXIT INT TERM
  [ -n "$ESBUILD_PID" ] && kill "$ESBUILD_PID" 2>/dev/null
  [ -n "$ELECTRON_PID" ] && kill "$ELECTRON_PID" 2>/dev/null
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

# Respawn Electron when it exits (e.g., via Cmd+Shift+Option+R or cdp.mjs restart).
# Ctrl+C triggers cleanup() and exits everything.
while true; do
  NODE_OPTIONS="--disable-warning=ExperimentalWarning" "$ELECTRON" "$ROOT_DIR" "$@" &
  ELECTRON_PID=$!
  wait "$ELECTRON_PID" 2>/dev/null
  EXIT_CODE=$?
  # Signal kill (Ctrl+C) or exit code 1 (stop) → don't respawn
  if [ $EXIT_CODE -gt 128 ] || [ $EXIT_CODE -eq 1 ]; then
    break
  fi
done

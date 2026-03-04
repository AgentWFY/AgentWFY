#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VITE="$ROOT_DIR/node_modules/.bin/vite"
ELECTRON="$ROOT_DIR/node_modules/.bin/electron"

cleanup() {
  trap '' EXIT INT TERM
  [ -n "$VITE_PID" ] && kill "$VITE_PID" 2>/dev/null
  wait 2>/dev/null
  exit
}
trap cleanup EXIT INT TERM

npm run build-main --prefix "$ROOT_DIR"

(cd "$ROOT_DIR/src/renderer" && exec "$VITE" --port 5173 --strictPort) &
VITE_PID=$!

until curl -s -o /dev/null http://localhost:5173; do
  sleep 0.3
done

VITE_DEV_SERVER_URL=http://localhost:5173 "$ELECTRON" --no-warnings "$ROOT_DIR/dist"

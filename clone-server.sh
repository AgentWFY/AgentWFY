#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLONE_DIR="$SCRIPT_DIR/tmp/server"
OUTPUT_DIR="$SCRIPT_DIR/dist/server"

LOCAL_SERVER_REPO="${LOCAL_SERVER_REPO:-$SCRIPT_DIR/../server}"
REMOTE_SERVER_REPO="${REMOTE_SERVER_REPO:-https://github.com/TradingLogApp/tradinglog-server}"

if [ -d "$LOCAL_SERVER_REPO" ]; then
  echo "Using local server repo: $LOCAL_SERVER_REPO"
  BUILD_DIR="$LOCAL_SERVER_REPO"
else
  if [ -d "$CLONE_DIR" ]; then
    echo "Removing existing directory: $CLONE_DIR"
    rm -rf "$CLONE_DIR"
  fi
  mkdir -p "$CLONE_DIR"
  echo "Local server repo not found, cloning from: $REMOTE_SERVER_REPO"
  git clone "$REMOTE_SERVER_REPO" "$CLONE_DIR"
  BUILD_DIR="$CLONE_DIR"
fi

cd "$BUILD_DIR"

npm install
npm run build-prod

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
cp -r dist/. "$OUTPUT_DIR/"

echo "Server build completed."
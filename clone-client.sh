#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/dist/client"
WORK_DIR="$(mktemp -d)"
SOURCE_DIR="$WORK_DIR/client-source"

LOCAL_CLIENT_REPO="${LOCAL_CLIENT_REPO:-$SCRIPT_DIR/../client}"
REMOTE_CLIENT_REPO="${REMOTE_CLIENT_REPO:-git@github.com:endenwer/trading-app.git}"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

if [ -d "$LOCAL_CLIENT_REPO" ]; then
  echo "Using local client repo: $LOCAL_CLIENT_REPO"
  SOURCE_DIR="$LOCAL_CLIENT_REPO"
else
  echo "Local client repo not found, cloning from: $REMOTE_CLIENT_REPO"
  git clone "$REMOTE_CLIENT_REPO" "$SOURCE_DIR"
fi

if [ -f "$SOURCE_DIR/package.json" ]; then
  CLIENT_PROJECT_DIR="$SOURCE_DIR"
elif [ -f "$SOURCE_DIR/client/package.json" ]; then
  CLIENT_PROJECT_DIR="$SOURCE_DIR/client"
else
  echo "Unable to find client package.json in '$SOURCE_DIR'"
  exit 1
fi

cd "$CLIENT_PROJECT_DIR"

export VITE_IS_ELECTRON=true
export VITE_PUBLIC_API_URL=http://localhost:23578
npm install
npm run build

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
cp -a dist/. "$OUTPUT_DIR/"

SPECTRUM_STYLES_DIR="$CLIENT_PROJECT_DIR/node_modules/@spectrum-web-components/styles"
if [ -d "$SPECTRUM_STYLES_DIR" ]; then
  SPECTRUM_OUTPUT_DIR="$OUTPUT_DIR/assets/spectrum-styles"
  mkdir -p "$SPECTRUM_OUTPUT_DIR"
  cp "$SPECTRUM_STYLES_DIR"/*.css "$SPECTRUM_OUTPUT_DIR"/
  echo "Copied local Spectrum styles to: $SPECTRUM_OUTPUT_DIR"
else
  echo "Spectrum styles directory not found at $SPECTRUM_STYLES_DIR, using runtime CDN fallback"
fi

echo "Client build completed successfully!"

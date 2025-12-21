#!/bin/bash

REPO_URL="git@github.com:endenwer/trading-app.git"
TARGET_DIR="$(pwd)/dist/client"
TEMP_DIR=$(mktemp -d)

# Remove the target directory if it exists
if [ -d "$TARGET_DIR" ]; then
    echo "Removing existing directory: $TARGET_DIR"
    rm -rf "$TARGET_DIR"
fi

# Create the target directory
mkdir -p "$TARGET_DIR"

# Change to the temporary directory
git clone $REPO_URL $TEMP_DIR

cd "$TEMP_DIR/client" || exit

# Install dependencies and run the build
export VITE_IS_ELECTRON=true
export VITE_PUBLIC_API_URL=http://localhost:23578
npm install
npm run build

# Copy build to dist location
cp -a dist/. "$TARGET_DIR/"

# Clean up
rm -rf $TEMP_DIR

echo "Client build completed successfully!"

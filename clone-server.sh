#!/bin/bash

# Define the target directory
TARGET_DIR="tmp/server"

# Remove the target directory if it exists
if [ -d "$TARGET_DIR" ]; then
    echo "Removing existing directory: $TARGET_DIR"
    rm -rf "$TARGET_DIR"
fi

# Create the target directory
mkdir -p "$TARGET_DIR"

# Clone the repository
git clone https://github.com/TradingLogApp/tradinglog-server "$TARGET_DIR"

# Change to the cloned directory
cd "$TARGET_DIR"

# Install dependencies and run the build
npm install
npm run build-prod

[ ! -d ../../dist/server ] && mkdir ../../dist/server
cp -r dist/* ../../dist/server

echo "Server build completed."

#!/bin/bash

# Define the target directory
TARGET_DIR="dist/client/dist"

# Remove the target directory if it exists
if [ -d "$TARGET_DIR" ]; then
    echo "Removing existing directory: $TARGET_DIR"
    rm -rf "$TARGET_DIR"
fi

# Create the target directory
mkdir -p "$TARGET_DIR"

# Clone the repository
git clone https://github.com/TradingLogApp/tradinglog-client "$TARGET_DIR"

# Check if the clone was successful
if [ $? -eq 0 ]; then
    echo "Client dist successfully cloned"
else
    echo "Failed to clone repository"
    exit 1
fi

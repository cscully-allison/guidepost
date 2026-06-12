#!/usr/bin/env bash

# Directory to watch (subfolder)
WATCH_DIR="guidepost/src"

# Command to run on changes
CMD="node esbuild.config.js"

# Latency (seconds) to batch multiple rapid changes
LATENCY=0.2

# Check if fswatch exists
if ! command -v fswatch &> /dev/null; then
  echo "fswatch could not be found. Install with: brew install fswatch"
  exit 1
fi

echo "Initial run. Running $CMD ..."
$CMD

# fswatch batches events within --latency and emits one line per batch (-o).
# This loops forever, running CMD once per batch of file changes.
fswatch -o -r --latency "$LATENCY" "$WATCH_DIR" | while read -r _; do
  echo "Change detected. Running $CMD ..."
  $CMD
done

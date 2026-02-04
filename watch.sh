# esbuild --bundle --format=esm --outdir=guidepost/static guidepost/src/guidepost.js guidepost/src/campsite/campsite.ts guidepost/src/trailmark.js guidepost/src/campsite/server.ts --watch

#!/usr/bin/env bash

# Directory to watch (subfolder)
WATCH_DIR="guidepost/src"

# Command to run on changes
CMD="node esbuild.config.js"
CMD2="npx peggy guidepost/src/campsite/lib/semantic_invariant_checker/ir_parser/grammar.pegjs -o guidepost/src/campsite/lib/semantic_invariant_checker/ir_parser/parser.js"

# Delay to batch multiple changes (milliseconds)
DEBOUNCE_MS=200

# Check if inotifywait exists
if ! command -v inotifywait &> /dev/null; then
  echo "inotifywait could not be found. Install with: sudo apt install inotify-tools"
  exit 1
fi

# Keep track of last run to debounce
LAST_RUN=0

echo "Running $CMD2 ..."
$CMD2
echo "Inital run. Running $CMD ..."
$CMD

# Infinite loop
while true; do
  # Wait for any modify/create/delete event in the folder or subfolders
  inotifywait -r -e modify,create,delete,move "$WATCH_DIR" >/dev/null 2>&1

  NOW=$(date +%s%3N) # current time in milliseconds
  ELAPSED=$((NOW-LAST_RUN))

  # Debounce to avoid multiple rapid triggers
  if [ $ELAPSED -ge $DEBOUNCE_MS ]; then
    echo "Running $CMD2 ..."
    $CMD2
    echo "Change detected. Running $CMD ..."
    $CMD
    LAST_RUN=$(date +%s%3N)
  fi
done
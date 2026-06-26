#!/usr/bin/env bash
set -euo pipefail

# Build the frontend bundles FIRST. guidepost/static/ is gitignored, so a clean
# checkout has none — and the widget can't render without them. Skipping this is
# what shipped 0.3.1 to PyPI with no JS.
node esbuild.config.js
test -f guidepost/static/guidepost.js || { echo "ERROR: esbuild did not produce guidepost/static/guidepost.js"; exit 1; }

rm -rf ./*.egg-info dist
python3 -m build

# Guard: refuse to upload a wheel that is missing the compiled bundle.
python3 - <<'PY'
import glob, sys, zipfile
whl = glob.glob("dist/*.whl")[0]
names = zipfile.ZipFile(whl).namelist()
if not any(n.endswith("guidepost/static/guidepost.js") for n in names):
    sys.exit(f"ERROR: {whl} is missing guidepost/static/guidepost.js — aborting upload")
print(f"OK: {whl} contains the compiled JS bundle")
PY

python3 -m twine upload --verbose --repository pypi dist/*

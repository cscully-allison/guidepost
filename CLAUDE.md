# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Guidepost is a Python/JavaScript library for visualizing HPC (High Performance Computing) job data in Jupyter notebooks. It provides interactive visualizations with brushable histograms, heatmaps, and categorical bar charts.

**Key modules:**
- **Guidepost** - Core visualization widget (Python + D3.js frontend)
- **Trailmark** - Alternative visualization module

> Note: Campsite (the AI analysis assistant) was extracted to its own repository at `~/Programming/campsite/` and is no longer part of this repo.

## Build & Development Commands

```bash
# Install Python package in development mode
pip install -e .

# Build frontend bundles (compiles JS to static/)
node esbuild.config.js

# Watch for changes during development (auto-rebuilds)
./watch.sh

# Run JavaScript tests
npx mocha

# Build and publish to PyPI
./publish.sh
```

## Architecture

### Python-JavaScript Widget Communication
- Python widgets (`guidepost.py`, `trailmark.py`) use `anywidget` + `traitlets` for bidirectional sync with JS frontends
- Data flows: `load_data(df)` → validation/cleaning (`utils.py`) → JSON serialization → traitlet sync → frontend rendering
- User selections sync back via `selected_records` trait

### Frontend (guidepost/src/)
- **guidepost.js** - Main entry, initializes D3 visualization
- **guidepost/js_model.js** - Transforms dict-major data to list-major, handles faceting
- **guidepost/heatmap.js** - Main heatmap visualization
- **guidepost/histogram.js** - Brushable histograms for selection
- **guidepost/barchart.js** - Categorical bar charts with click filtering
- Bundles compile to `guidepost/static/`

### Data Requirements
- Minimum 3 numerical columns, 2 categorical columns
- No NaN/None values (dropped with warnings)
- No timedelta columns (dropped)
- Performance warnings at >250k rows

## Testing

Tests use Mocha (config in `.mocharc.js`):
```bash
npx mocha                    # Run all tests
npx mocha tests/guidepost.test.js  # Run specific test file
```

Test files are in `tests/` with pattern `*.test.js`.

## Key Dependencies

**Python:** anywidget, traitlets, pandas, numpy, scikit-learn
**JavaScript:** d3@7

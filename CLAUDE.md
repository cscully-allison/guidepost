# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Guidepost is a Python/JavaScript library for visualizing HPC (High Performance Computing) job data in Jupyter notebooks. It provides interactive visualizations with brushable histograms, heatmaps, and categorical bar charts.

**Key modules:**
- **Guidepost** - Core visualization widget (Python + D3.js frontend)
- **Campsite** - AI-powered analysis assistant with Node.js backend (TypeScript/LangChain)
- **Trailmark** - Alternative visualization module

## Build & Development Commands

```bash
# Install Python package in development mode
pip install -e .

# Build frontend bundles (compiles TS/JS to static/)
node esbuild.config.js

# Watch for changes during development (auto-rebuilds)
./watch.sh

# Compile Peggy grammar (for IR parser)
npx peggy guidepost/src/campsite/lib/semantic_invariant_checker/ir_parser/grammar.pegjs -o guidepost/src/campsite/lib/semantic_invariant_checker/ir_parser/parser.js

# Run JavaScript tests
npx mocha

# Build and publish to PyPI
./publish.sh
```

## Architecture

### Python-JavaScript Widget Communication
- Python widgets (`guidepost.py`, `campsite.py`, `trailmark.py`) use `anywidget` + `traitlets` for bidirectional sync with JS frontends
- Data flows: `load_data(df)` → validation/cleaning (`utils.py`) → JSON serialization → traitlet sync → frontend rendering
- User selections sync back via `selected_records` trait

### Frontend (guidepost/src/)
- **guidepost.js** - Main entry, initializes D3 visualization
- **guidepost/js_model.js** - Transforms dict-major data to list-major, handles faceting
- **guidepost/heatmap.js** - Main heatmap visualization
- **guidepost/histogram.js** - Brushable histograms for selection
- **guidepost/barchart.js** - Categorical bar charts with click filtering
- Bundles compile to `guidepost/static/`

### Campsite (AI Analysis)
- **campsite.py** - Python widget + `LocalNodeServer` singleton (spawns Node.js subprocess)
- **src/campsite/server.ts** - Express server with endpoints: `/analyze`, `/parse`, `/ping`
- **src/campsite/lib/analysis_graph.ts** - LangChain state graph for multi-turn conversation
- **src/campsite/lib/semantic_invariant_checker/** - Peggy grammar + IR parser for validating AI-generated code

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
**JavaScript:** d3@7, express@5, @langchain/langgraph, @langchain/openai, peggy

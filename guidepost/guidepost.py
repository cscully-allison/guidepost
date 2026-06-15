import anywidget
import traitlets
import pandas as pd
import numpy as np
import pyarrow as pa
import ast
import json
import os
import sys
from .utils import validate_and_clean_dataframe, extract_summary_statistics
from .seriation import compute_category_ordering
from .aggregation import AggregationEngine

# Guidepost needs two categorical roles — facet_by ("Group By") and categorical
# ("Categorical Bar Chart"). When a dataset has fewer than two usable categorical
# columns we affix this synthetic constant column so the unfilled role(s) have
# something to bind to: it yields a single facet and an (empty) categorical bar
# chart rather than a hard validation failure. The frontend keys off the
# `is_synthetic` flag on its summary-stats entry (never the name) to relabel it
# as "n/a" and render the empty state.
SYNTHETIC_FACET_COL = "__gp_no_grouping__"
SYNTHETIC_FACET_VALUE = "All records"

class Guidepost(anywidget.AnyWidget):

    _esm = os.path.join(os.path.dirname(__file__), "static",  "guidepost.js")
    records = None
    # Arrow IPC stream of the loaded DataFrame. Replaces the prior dict trait
    # which JSON-encoded the full dataset on every sync; pyarrow ships the
    # same data ~5× smaller and skips the o_df.astype(object).where() cast
    # that dominated load_data for >100k rows.
    _vis_data = traitlets.Bytes(b'').tag(sync=True)

    vis_configs = None
    _vis_configs = traitlets.Unicode("{}").tag(sync=True)
    cached_records_df = None
    
    selected_records = traitlets.Unicode("[]").tag(sync=True)
    records_df = pd.DataFrame()
    selection = None

    _summary_stats = traitlets.Dict({}).tag(sync=True)

    suppress_warnings = False

    def __init__(self, *args, **kwargs):
        # `records` is a property (not a traitlet) so HasTraits silently
        # drops it from **kwargs. Pull it out before super() and apply via
        # the setter below — otherwise `Guidepost(records=df)` looks like
        # it works but ships no data.
        records = kwargs.pop("records", None)
        # Columns whose cells are lists of categorical values (one job → many
        # nodes). Declared explicitly so we can parse stringified lists and
        # mark them in _summary_stats; only list/categorical columns may sit
        # on the x-axis. Pulled before super() for the same reason as records.
        list_columns = kwargs.pop("list_columns", None)
        # Separator used to split bare (non-literal) list cells, e.g. the
        # comma-joined node strings in ALCF LOCATION data ("nodeA,nodeB").
        # Defaults to "," but is configurable for space/semicolon formats.
        list_delimiter = kwargs.pop("list_delimiter", None)
        super().__init__(*args, **kwargs)
        self._list_columns = list(list_columns) if list_columns else []
        # Declared list columns plus any auto-detected array/list columns;
        # recomputed each load_data. Initialized so methods that reference it
        # before the first load don't fail.
        self._effective_list_columns = list(self._list_columns)
        self._list_delimiter = list_delimiter or ","
        # DuckDB-backed aggregator. Lazily created when the first DataFrame
        # is loaded — keeping it None until then so widgets constructed
        # without data don't pay the import/registration cost.
        self._agg_engine = None
        # Route JS-originated request_aggregation / request_brush_indices
        # messages here. anywidget calls the handler with (widget, content,
        # buffers); content is the parsed JSON payload. Note: do NOT name
        # this method `_handle_msg` — that's the ipywidgets Widget base
        # class's comm dispatcher, and shadowing it eats every incoming
        # message before it reaches on_msg callbacks.
        self.on_msg(self._dispatch_custom_msg)
        if records is not None:
            self.records = records

    @property
    def vis_configs(self):
        return json.loads(self._vis_configs)
    
    @vis_configs.setter
    def vis_configs(self, config_dict):
        self._vis_configs = json.dumps(config_dict)

    @property
    def records(self):
        return self._vis_data

    @records.setter
    def records(self, df):
        self._vis_data = self.load_data(df)

    def load_data(self, in_df):
        '''
            Load dataframe in a safe way.
            Drop NAs, remove time deltas, report warnings.
            Serializes the cleaned frame as an Arrow IPC stream into _vis_data;
            the JS side decodes via apache-arrow.
        '''

        in_cpy = in_df.copy()
        in_cpy.insert(0, 'gp_idx', range(0, len(in_cpy)))
        # Columns whose cells are genuine arrays/lists (e.g. parquet list
        # columns) are auto-detected and treated as list columns — parsed and
        # exploded like declared ones rather than dropped by the array guard.
        # Declared columns (incl. delimited *string* lists, which can't be
        # auto-detected) are unioned in.
        self._effective_list_columns = sorted(
            set(self._list_columns) | set(self._detect_list_columns(in_cpy)))
        # Normalize list columns to real Python lists (stringified lists are
        # parsed) before validation/serialization so DuckDB, Arrow and the
        # summary all see the same shape.
        in_cpy = self._parse_list_columns(in_cpy)
        self.cached_records_df = in_cpy

        if sys.version_info.major < 3 or sys.version_info.minor < 12:
            warn_supported_version = False

        o_df, report = validate_and_clean_dataframe(in_cpy, self.suppress_warnings, self._effective_list_columns)

        summary_stats = extract_summary_statistics(o_df, self._effective_list_columns)

        # Fill the categorical "cracks": if there are too few real (non-list)
        # categorical columns to fill both the facet_by and categorical roles,
        # affix a synthetic constant categorical column so guidepost still renders
        # (a single facet + an empty/"n/a" categorical bar chart) instead of
        # failing config validation. Done after extract_summary_statistics so the
        # count uses pandas' authoritative semantic types, and before the Arrow
        # serialization + DuckDB registration below so the column flows through
        # both. cached_records_df was captured from the input frame, so the
        # synthetic column never leaks into exported selected_records.
        n_real_categorical = sum(
            1 for col, info in summary_stats.items()
            if col != 'gp_idx'
            and info.get('semantic_type') == 'categorical'
            and not info.get('is_list'))
        if n_real_categorical < 2:
            n_rows = len(o_df)
            o_df[SYNTHETIC_FACET_COL] = SYNTHETIC_FACET_VALUE
            summary_stats[SYNTHETIC_FACET_COL] = {
                "dtype": "object",
                "semantic_type": "categorical",
                "is_synthetic": True,
                "n_rows": n_rows,
                "n_missing": 0,
                "pct_missing": 0.0,
                "n_unique": 1,
                "top": SYNTHETIC_FACET_VALUE,
                "top_freq": n_rows,
                "top_values": [{"value": SYNTHETIC_FACET_VALUE, "count": int(n_rows)}],
            }

        # Ordering for list columns, shipped on _summary_stats (same channel as
        # is_list, so it survives config-UI rewrites). Structure-aware node-name
        # layout is preferred (ships `category_hierarchy` + `category_levels` so
        # the frontend can build an adaptive grouped overview and fisheye lens
        # that retains every node); arbitrary categories fall back to spectral
        # seriation (ships `category_score` for the column cap). Both share
        # `category_order` for the kept/ordered sequence.
        ordering = compute_category_ordering(o_df, self._effective_list_columns)
        for col, info in ordering.items():
            if col not in summary_stats:
                continue
            summary_stats[col]["category_order"] = info["order"]
            if "hierarchy" in info:
                summary_stats[col]["category_hierarchy"] = info["hierarchy"]
                summary_stats[col]["category_levels"] = info["levels"]
            if "score" in info:
                summary_stats[col]["category_score"] = info["score"]

        self._summary_stats = summary_stats

        # Arrow preserves nulls natively, so the prior astype(object).where()
        # cast (which materialized a full object-dtype copy of o_df) is no
        # longer needed — pyarrow handles NaN/None at the array level.
        table = pa.Table.from_pandas(o_df, preserve_index=False)
        sink = pa.BufferOutputStream()
        with pa.ipc.new_stream(sink, table.schema) as writer:
            writer.write_table(table)
        self._vis_data = sink.getvalue().to_pybytes()

        # Register the cleaned frame with DuckDB so JS-originated aggregation
        # requests have a current source. Use the cleaned o_df (not in_cpy)
        # so subsequent SQL matches the bins JS computed from the same shape.
        if self._agg_engine is None:
            self._agg_engine = AggregationEngine(o_df)
        else:
            self._agg_engine.replace(o_df)

        return self._vis_data

    def _detect_list_columns(self, df):
        '''
            Auto-detect columns whose cells are genuine arrays/lists (the first
            non-null value is a list/tuple/ndarray) — e.g. parquet list columns.
            Returns the column names so they can be handled as list columns
            instead of being dropped by the array guard. Delimited *string*
            lists are NOT detected here (they look like plain strings); declare
            those via `list_columns`.
        '''
        detected = []
        for col in df.columns:
            if col == 'gp_idx':
                continue
            idx = df[col].first_valid_index()
            if idx is None:
                continue
            if isinstance(df[col].loc[idx], (list, tuple, np.ndarray)):
                detected.append(col)
        return detected

    def _parse_list_columns(self, df):
        '''
            Normalize each list column (declared or auto-detected) to a Python
            list per cell. Accepts already-list cells, numpy arrays, and
            stringified lists ("['a','b']"). Per-cell values are de-duplicated
            (order-preserving) so a value repeated in one cell can't
            double-count. NaN cells are left as-is.
        '''
        for col in self._effective_list_columns:
            if col not in df.columns:
                continue

            def _norm(v):
                if isinstance(v, (list, tuple, np.ndarray)):
                    seq = list(v)
                elif isinstance(v, str):
                    try:
                        parsed = ast.literal_eval(v)
                        seq = list(parsed) if isinstance(parsed, (list, tuple)) else [parsed]
                    except (ValueError, SyntaxError):
                        # Not a Python literal — treat as a delimited string
                        # (e.g. "nodeA,nodeB") and split into its members
                        # rather than keeping the whole string as one value.
                        seq = [s.strip() for s in v.split(self._list_delimiter) if s.strip()]
                elif pd.isna(v):
                    return v
                else:
                    seq = [v]
                seen = set()
                out = []
                for item in seq:
                    if item not in seen:
                        seen.add(item)
                        out.append(item)
                return out

            df[col] = df[col].map(_norm)
        return df

    @property
    def selection(self):
        return self.retrieve_selected_data()

    def retrieve_selected_data(self):
        if self.cached_records_df is None:
            raise ValueError("No data has been loaded yet. Please call load_data() first.")
        elif len(self.selected_records) == 0:
            return pd.DataFrame()  # Return empty DataFrame if no selection

        selected_records_idx = json.loads(self.selected_records)

        self.records_df = self.cached_records_df[self.cached_records_df['gp_idx'].isin(selected_records_idx)]

        #remove synthetic index
        return self.records_df.drop('gp_idx', axis=1)

    # ---- comm-channel handlers ----------------------------------------------
    #
    # The JS side sends `{type, request_id, ...}` messages. We dispatch by
    # `type`, run the engine, and reply with `{type: '<x>_result', request_id,
    # ...}` so the JS promise keyed by `request_id` can resolve.

    def _dispatch_custom_msg(self, _widget, content, _buffers):
        if not isinstance(content, dict):
            return
        msg_type = content.get("type")
        request_id = content.get("request_id")
        try:
            if msg_type == "request_aggregation":
                if self._agg_engine is None:
                    raise RuntimeError(
                        "Aggregation engine not initialized. Did you forget "
                        "to set widget.records = df (or pass records via the "
                        "property)?"
                    )
                grid = self._handle_aggregation(content)
                self.send({"type": "aggregation_result", "request_id": request_id, "grid": grid})
            elif msg_type == "request_brush_indices":
                if self._agg_engine is None:
                    raise RuntimeError("Aggregation engine not initialized.")
                indices = self._handle_brush_indices(content)
                self.send({
                    "type": "brush_indices_result",
                    "request_id": request_id,
                    "indices": indices.tolist(),
                })
        except Exception as e:
            # Surface the error back so the JS promise rejects with context
            # instead of hanging forever.
            self.send({
                "type": (msg_type or "unknown") + "_error",
                "request_id": request_id,
                "error": f"{type(e).__name__}: {e}",
            })

    def _handle_aggregation(self, content: dict) -> dict:
        return self._agg_engine.aggregate(
            facet_by=content["facet_by"],
            x=content["x"],
            y=content["y"],
            color=content["color"],
            color_agg=content.get("color_agg", "avg"),
            x_thresholds_by_facet=content["x_thresholds_by_facet"],
            y_thresholds_by_facet=content["y_thresholds_by_facet"],
            category_col=content.get("category_col"),
            category_filter=content.get("category_filter"),
        )

    def _handle_brush_indices(self, content: dict):
        return self._agg_engine.brush_indices(
            facet_by=content["facet_by"],
            x=content["x"],
            y=content["y"],
            facet=content["facet"],
            x_range=content.get("x_range"),
            y_range=content.get("y_range"),
            category_col=content.get("category_col"),
            category_filter=content.get("category_filter"),
        )
import anywidget
import traitlets
import pandas as pd
import pyarrow as pa
import json
import os
import sys
from .utils import validate_and_clean_dataframe, extract_summary_statistics
from .aggregation import AggregationEngine

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
        super().__init__(*args, **kwargs)
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
        self.cached_records_df = in_cpy

        if sys.version_info.major < 3 or sys.version_info.minor < 12:
            warn_supported_version = False

        o_df, report = validate_and_clean_dataframe(in_cpy, self.suppress_warnings)

        self._summary_stats = extract_summary_statistics(o_df)

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
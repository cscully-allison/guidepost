import anywidget
import traitlets
import pandas as pd
import numpy as np
import warnings
import json
import os
import sys
from pandas.api import types as ptypes

class Trailmark(anywidget.AnyWidget):
    _esm = os.path.join(os.path.dirname(__file__), "trailmark.js")
    vis_data = traitlets.Dict({}).tag(sync=True)
    vis_configs = traitlets.Dict({}).tag(sync=True)
    
    def load_data(self, in_df, supress_warnings=False):
        '''
            Load dataframe and extract summary statistics for visualization.
        '''
        
        # validate / coerce dataframe
        if not isinstance(in_df, pd.DataFrame):
            try:
            in_df = pd.DataFrame(in_df)
            except Exception:
            raise ValueError("in_df must be a pandas DataFrame or convertible to one")

        if not supress_warnings and in_df.empty:
            warnings.warn("load_data called with an empty DataFrame")


        summary = {}
        type_counts = {"continuous": 0, "ordinal": 0, "categorical": 0}

        for col in in_df.columns:
            s = in_df[col]
            n_rows = len(s)
            n_missing = int(s.isna().sum())
            pct_missing = float(n_missing) / n_rows if n_rows > 0 else 0.0
            n_unique = int(s.nunique(dropna=True))

            # determine semantic type
            if ptypes.is_categorical_dtype(s.dtype):
            semantic = "ordinal" if getattr(s.dtype, "ordered", False) else "categorical"
            elif ptypes.is_bool_dtype(s.dtype):
            semantic = "categorical"
            elif ptypes.is_numeric_dtype(s.dtype):
            # heuristic: small-integer domains likely ordinal (e.g., ratings)
            if ptypes.is_integer_dtype(s.dtype) and n_unique <= 10:
                semantic = "ordinal"
            else:
                semantic = "continuous"
            else:
            # object, string, datetime, etc.
            # treat datetimes separately as continuous-like
            if ptypes.is_datetime64_any_dtype(s.dtype) or ptypes.is_timedelta64_dtype(s.dtype):
                semantic = "continuous"
            else:
                semantic = "categorical"

            type_counts[semantic] += 1

            col_summary = {
            "dtype": str(s.dtype),
            "semantic_type": semantic,
            "n_rows": n_rows,
            "n_missing": n_missing,
            "pct_missing": pct_missing,
            "n_unique": n_unique,
            }

            if semantic == "continuous":
            # compute robust numeric summaries (skip NA)
            ser = pd.to_numeric(s, errors="coerce")
            col_summary.update({
                "count": int(ser.count()),
                "mean": None if ser.count() == 0 else float(ser.mean()),
                "std": None if ser.count() == 0 else float(ser.std()),
                "min": None if ser.count() == 0 else float(ser.min()),
                "25%": None if ser.count() == 0 else float(ser.quantile(0.25)),
                "50%": None if ser.count() == 0 else float(ser.quantile(0.5)),
                "75%": None if ser.count() == 0 else float(ser.quantile(0.75)),
                "max": None if ser.count() == 0 else float(ser.max()),
            })
            else:
            # categorical / ordinal: top categories and frequencies
            vc = s.astype(object).value_counts(dropna=True)
            top = vc.index[0] if len(vc) > 0 else None
            top_freq = int(vc.iloc[0]) if len(vc) > 0 else 0
            # include up to 20 most frequent values
            top_items = []
            for k, v in vc.iloc[:20].items():
                # convert numpy types to native python types for JSON serialization
                try:
                key = k.item() if hasattr(k, "item") else k
                except Exception:
                key = str(k)
                top_items.append({"value": key, "count": int(v)})
            col_summary.update({
                "top": top,
                "top_freq": top_freq,
                "top_values": top_items
            })

            summary[col] = col_summary

        # store results in widget traits for frontend sync
        self.vis_data = summary
        
        self.vis_configs = {
            "n_rows": len(in_df),
            "n_columns": len(in_df.columns),
            "type_counts": type_counts,
        }

        print("Data loaded: {} rows, {} columns".format(len(in_df), len(in_df.columns)))
        print("Column types: {} continuous, {} ordinal, {} categorical".format(
            type_counts["continuous"],
            type_counts["ordinal"],
            type_counts["categorical"]
        ))
        return self.vis_data
        
        
    # def retrieve_configuration_selection(self):
        # 
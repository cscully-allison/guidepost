import pandas as pd
import numpy as np
import warnings
import os
import sys
from pandas.api import types as ptypes

def convert_to_float(value):
    if pd.isna(value):
        return np.nan
    elif value.endswith('K'):
        return float(value[:-1]) * 1e3
    if value.endswith('M'):
        return float(value[:-1]) * 1e6
    elif value.endswith('B'):
        return float(value[:-1]) * 1e9
    return float(value)


def validate_and_clean_dataframe(in_cpy, supress_warnings=False, list_columns=None):
    _warn_skips = (os.path.dirname('.'),)
    warn_supported_version = False
    list_columns = set(list_columns or [])

    original_cols = in_cpy.columns
    o_df = in_cpy.dropna(axis=1, how='all')

    error_report = {}
    report = {}
    

    #remove columns with only nans
    col_diff = original_cols.difference(o_df.columns)
    if(len(col_diff)>0):
        rmvd_cols = ', '.join(col_diff)
        report = {"na_columns": col_diff}
        if(not supress_warnings):
            if warn_supported_version:
                warnings.warn("The following columns were dropped because they contained entirely 'na' values which guidepost does not support:[{}]".format(rmvd_cols), skip_file_prefixes=_warn_skips)
            else:
                print("Warning: The following columns were dropped because they contained entirely 'na' values which guidepost does not support:[{}]".format(rmvd_cols))
        original_cols = o_df.columns
        
    # report per-column null counts but keep the rows; downstream JS handles nulls per-axis
    null_counts = {col: int(o_df[col].isna().sum()) for col in o_df.columns if o_df[col].isna().any()}
    if null_counts:
        error_report["na_column_counts"] = null_counts
        if(not supress_warnings):
            print("Warning: The following columns contain null values which will be skipped per-axis at render time: {}".format(null_counts))
    
    #convert timedelta columns to numeric seconds (instead of dropping them) so
    # they're usable as continuous variables downstream (binning, DuckDB, Arrow)
    td_cols = list(o_df.select_dtypes(include=['timedelta']).columns)
    if(len(td_cols) > 0):
        for col in td_cols:
            o_df[col] = o_df[col].dt.total_seconds()
        report["timedelta_columns_converted"] = td_cols
        if(not supress_warnings):
            conv_cols = ', '.join(td_cols)
            msg = "Note: The following timedelta columns were converted to seconds: [{}]".format(conv_cols)
            if warn_supported_version:
                warnings.warn(msg, skip_file_prefixes=_warn_skips)
            else:
                print(msg)
        original_cols = o_df.columns
    
    #drop arrays/complex datatypes (but keep declared list columns, which are
    # intentionally list-valued and parsed to Python lists upstream)
    col_diff = []
    for col in o_df.columns:
        if col in list_columns:
            continue
        if(type(o_df[col].iloc[0]) == type(np.ndarray([]))):
            col_diff.append(col)
            o_df = o_df.drop(col, axis=1)
            
    if(len(col_diff)>0):
        rmvd_cols = ', '.join(col_diff)
        report = {"array_columns": col_diff}

        if(not supress_warnings):
            if warn_supported_version:
                warnings.warn("The following columns were dropped because they contained array values in cells which guidepost does not support:[{}]".format(rmvd_cols), skip_file_prefixes=_warn_skips)
            else:
                print("Warning: The following columns were dropped because they contained array values in cells which guidepost does not support:[{}]".format(rmvd_cols))
        original_cols = o_df.columns
        
            
    #add synthetic index
    if(o_df.shape[0]>250_000):
        if(not supress_warnings):
            if warn_supported_version:
                warnings.warn("Your dataframe is very large. You may experience performance issues. Consider subsampling or reducing the data down to below 200,000 rows to enhance performance.", skip_file_prefixes=_warn_skips)
            else:
                print("Warning: Your dataframe is very large. You may experience performance issues. Consider subsampling or reducing the data down to below 200,000 rows to enhance performance.") 

    return o_df, report

def extract_summary_statistics(o_df, list_columns=None):
        summary = {}
        list_columns = set(list_columns or [])
        type_counts = {"continuous": 0, "ordinal": 0, "categorical": 0}

        for col in o_df.columns:
            s = o_df[col]
            n_rows = len(s)
            n_missing = int(s.isna().sum())
            pct_missing = float(n_missing) / n_rows if n_rows > 0 else 0.0

            # List columns hold unhashable lists, so nunique/value_counts must
            # operate on the flattened (exploded) values, not the raw cells.
            # They are always categorical and flagged is_list so the frontend
            # can switch on explode/dedup behavior.
            if col in list_columns:
                exploded = s.dropna().explode()
                vc = exploded.astype(object).value_counts(dropna=True)
                top = vc.index[0] if len(vc) > 0 else None
                top_freq = int(vc.iloc[0]) if len(vc) > 0 else 0
                top_items = []
                for k, v in vc.iloc[:10].items():
                    try:
                        key = k.item() if hasattr(k, "item") else k
                    except Exception:
                        key = str(k)
                    top_items.append({"value": key, "count": int(v)})
                summary[col] = {
                    "dtype": str(s.dtype),
                    "semantic_type": "categorical",
                    "is_list": True,
                    "n_rows": n_rows,
                    "n_missing": n_missing,
                    "pct_missing": pct_missing,
                    "n_unique": int(exploded.nunique()),
                    "top": top,
                    "top_freq": top_freq,
                    "top_values": top_items,
                }
                type_counts["categorical"] += 1
                continue

            n_unique = int(s.nunique(dropna=True))

            # determine semantic type
            if ptypes.is_categorical_dtype(s.dtype):
                semantic = "ordinal" if getattr(s.dtype, "ordered", False) else "categorical"
            elif ptypes.is_bool_dtype(s.dtype):
                semantic = "categorical"
            elif ptypes.is_numeric_dtype(s.dtype):
                # heuristic: small-integer domains likely ordinal (e.g., ratings)
                if ptypes.is_integer_dtype(s.dtype) or n_unique < 20:
                    semantic = "ordinal"
                else:
                    semantic = "continuous"
            else:
                # object, string, datetime, etc.
                # treat datetimes separately as continuous-like
                if ptypes.is_datetime64_any_dtype(s.dtype) or ptypes.is_timedelta64_dtype(s.dtype):
                    semantic = "continuous"
                else:
                    # Check if categorical values are numbers with suffixes M, K, or B
                    if s.dropna().astype(str).str.fullmatch(r'\d+(\.\d+)?[MKB]').all():
                        s = s.map(convert_to_float)
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
                    "IQR": None if ser.count() == 0 else float(ser.quantile(0.75) - ser.quantile(0.25)),
                    "max": None if ser.count() == 0 else float(ser.max()),
                    "var": None if ser.count() == 0 else float(ser.var())
                })
            else:
                # categorical / ordinal: top categories and frequencies
                vc = s.astype(object).value_counts(dropna=True)
                top = vc.index[0] if len(vc) > 0 else None
                top_freq = int(vc.iloc[0]) if len(vc) > 0 else 0

                # include up to 20 most frequent values
                top_items = []
                for k, v in vc.iloc[:10].items():
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
        return summary


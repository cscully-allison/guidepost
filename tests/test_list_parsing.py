"""
Unit tests for list-column parsing (``Guidepost._parse_list_columns``).
Exercised via pytest:

    pytest tests/test_list_parsing.py -v

Regression coverage for delimited (comma-separated) list cells such as the
ALCF LOCATION column ("nodeA,nodeB"), which are NOT Python literals and must
be split into their members rather than kept as one giant category.
"""

import os

import numpy as np
import pandas as pd
import pytest

from guidepost import Guidepost


def _parse(values, list_columns=("nodes",), delimiter=None):
    """Run a single column of raw cell values through _parse_list_columns."""
    kwargs = {"list_columns": list(list_columns)}
    if delimiter is not None:
        kwargs["list_delimiter"] = delimiter
    gp = Guidepost(**kwargs)
    df = pd.DataFrame({"nodes": list(values)})
    return gp._parse_list_columns(df)["nodes"].tolist()


def test_comma_delimited_bare_string_is_split():
    # The bug this fixes: "a,b,c" must explode into members, not stay whole.
    assert _parse(["a,b,c"]) == [["a", "b", "c"]]


def test_literal_list_string_still_parsed():
    # Backward compatibility: genuine Python-literal lists keep working.
    assert _parse(["['a','b']"]) == [["a", "b"]]


def test_single_bare_value():
    assert _parse(["x3004c0s37b1n0"]) == [["x3004c0s37b1n0"]]


def test_per_cell_dedup_preserves_order():
    assert _parse(["a,a,b"]) == [["a", "b"]]


def test_nan_passes_through():
    out = _parse([np.nan])
    assert len(out) == 1 and pd.isna(out[0])


def test_already_list_cell_is_deduped():
    assert _parse([["a", "b", "a"]]) == [["a", "b"]]


def test_custom_delimiter_splits_on_semicolon_only():
    # Semicolon splits; an embedded comma stays part of the member.
    assert _parse(["a;b,c"], delimiter=";") == [["a", "b,c"]]


def test_whitespace_around_members_is_stripped():
    assert _parse(["a, b ,c"]) == [["a", "b", "c"]]


def test_array_columns_are_auto_detected_as_list_columns():
    # A column of genuine arrays/lists (e.g. a parquet list column) is detected
    # and treated as a list column without being declared — so it's parsed and
    # flagged is_list rather than dropped by the array guard.
    df = pd.DataFrame({
        "nodes":  [["a", "b"], ["b"], np.array(["c", "a"]), ["d"]],
        "y":      [1.0, 2.0, 3.0, 4.0],
        "color":  [5.0, 6.0, 7.0, 8.0],
    })
    gp = Guidepost()                      # no list_columns declared
    gp.suppress_warnings = True
    gp.load_data(df)
    assert "nodes" in gp._effective_list_columns
    assert gp._summary_stats["nodes"]["is_list"] is True
    assert "nodes" in gp._summary_stats          # kept, not dropped
    # array cell normalized to a deduped python list
    assert gp.cached_records_df["nodes"].iloc[2] == ["c", "a"]


def test_timedelta_columns_converted_to_seconds():
    # Timedelta columns are kept (not dropped) and converted to numeric seconds
    # so they're usable as continuous variables.
    secs = list(range(1, 31))  # 30 distinct → continuous
    df = pd.DataFrame({
        "dur": pd.to_timedelta(secs, unit="s"),
        "a": [float(i) for i in range(30)],
        "b": [float(i * 2) for i in range(30)],
        "c": ["x", "y"] * 15,
        "d": ["p", "q"] * 15,
    })
    gp = Guidepost()
    gp.suppress_warnings = True
    gp.load_data(df)
    s = gp._summary_stats["dur"]
    assert s["semantic_type"] == "continuous"   # numeric, not dropped
    assert s["min"] == 1.0 and s["max"] == 30.0  # in seconds


# Committed ~1 MB sample: header + first 20,000 rows of the real ALCF POLARIS
# export. Small enough to live in git so this regression runs in CI; identical
# to the slice the test read from the full export previously.
POLARIS_CSV = os.path.join(
    os.path.dirname(__file__), "data", "polaris_sample.csv.gz"
)


@pytest.mark.skipif(not os.path.exists(POLARIS_CSV), reason="POLARIS sample data not present")
def test_real_location_data_yields_node_count_not_string_combos():
    # Load a slice of the real ALCF data; LOCATION holds comma-joined node
    # strings. After the fix the distinct count should be on the order of
    # hundreds (physical nodes), not thousands (unique string combinations).
    df = pd.read_csv(POLARIS_CSV, compression="gzip", nrows=20000)
    gp = Guidepost(list_columns=["LOCATION"])
    gp.suppress_warnings = True
    gp.load_data(df)

    parsed = gp.cached_records_df["LOCATION"].dropna()
    distinct_nodes = set()
    for cell in parsed:
        distinct_nodes.update(cell)

    # Polaris has ~560 compute nodes; allow generous headroom but well below
    # the thousands of unique comma-joined combinations the bug produced.
    assert 100 < len(distinct_nodes) < 1500
    assert gp._summary_stats["LOCATION"]["is_list"] is True

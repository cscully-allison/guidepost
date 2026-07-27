"""
Unit tests for the ``sort_by`` custom x-axis ordering override
(``guidepost.seriation.compute_category_ordering`` + the Guidepost
constructor). Run via:

    pytest tests/test_custom_sort.py -v

Covers the motivating case: list data that is ordinal but NOT hierarchical
(nodes named "1","2",...,"12"), which the built-in node-layout / seriation
heuristics can't order sensibly. A user-supplied full-list transform replaces
them and its result flows through the existing ``category_order`` channel.
"""

import numpy as np
import pandas as pd
import pytest

from guidepost import Guidepost
from guidepost.seriation import compute_category_ordering


def _df(cells, col="nodes"):
    """A one-list-column frame whose cells are already-parsed Python lists."""
    return pd.DataFrame({col: list(cells)})


# Numeric-named nodes: string sort gives "1","10","11",... — the override fixes it.
NUMERIC_CELLS = [[str(n)] for n in range(1, 13)]          # "1".."12"
NUMERIC_EXPECTED = [str(n) for n in range(1, 13)]

# Cray-convention names → default heuristic yields a node-name hierarchy.
CRAY_CELLS = [["x1008c0s0b0n0"], ["x1008c0s0b0n1"], ["x1008c0s0b1n0"]]


def _numeric_sort(cats):
    return sorted(cats, key=int)


# ----- override wins, produces a bare {"order"} entry -----

def test_dict_override_numeric_order():
    ordering = compute_category_ordering(
        _df(NUMERIC_CELLS), ["nodes"], sort_overrides={"nodes": _numeric_sort})
    info = ordering["nodes"]
    assert info["order"] == NUMERIC_EXPECTED
    # Override short-circuits the heuristics: no hierarchy / score shipped.
    assert "category_hierarchy" not in info and "hierarchy" not in info
    assert "score" not in info


def test_bare_callable_applies_to_all_list_columns():
    df = pd.DataFrame({"nodes": NUMERIC_CELLS, "racks": [[c[0]] for c in NUMERIC_CELLS]})
    ordering = compute_category_ordering(
        df, ["nodes", "racks"], sort_overrides=_numeric_sort)
    assert ordering["nodes"]["order"] == NUMERIC_EXPECTED
    assert ordering["racks"]["order"] == NUMERIC_EXPECTED


def test_dict_targets_one_column_other_keeps_default():
    # nodes -> override; racks -> default heuristic (Cray hierarchy). Both
    # columns must share a length; cycle the Cray names to match nodes.
    racks = [CRAY_CELLS[i % len(CRAY_CELLS)] for i in range(len(NUMERIC_CELLS))]
    df = pd.DataFrame({"nodes": NUMERIC_CELLS, "racks": racks})
    ordering = compute_category_ordering(
        df, ["nodes", "racks"], sort_overrides={"nodes": _numeric_sort})
    assert ordering["nodes"]["order"] == NUMERIC_EXPECTED
    assert "hierarchy" not in ordering["nodes"]
    # Untouched column ran a heuristic → carries a heuristic-only shape.
    racks = ordering["racks"]
    assert "order" in racks and ("hierarchy" in racks or "score" in racks)


def test_result_is_stringified_to_match_js_keys():
    # An override that returns ints must be coerced back to the String() keys
    # the frontend builds columns from.
    ordering = compute_category_ordering(
        _df(NUMERIC_CELLS), ["nodes"], sort_overrides=lambda c: sorted(c, key=int))
    assert all(isinstance(k, str) for k in ordering["nodes"]["order"])


# ----- robustness: a bad override never aborts loading -----

def test_raising_override_falls_back_with_warning():
    # int() on non-numeric names raises → fall back to the heuristic, don't abort.
    df = _df(CRAY_CELLS)
    with pytest.warns(UserWarning, match="falling back"):
        ordering = compute_category_ordering(
            df, ["nodes"], sort_overrides=_numeric_sort)
    info = ordering["nodes"]
    assert "order" in info
    # Fell back to the node-layout heuristic (hierarchy present), not the override.
    assert "hierarchy" in info


def test_unknown_dict_key_warns():
    with pytest.warns(UserWarning, match="not list columns"):
        compute_category_ordering(
            _df(NUMERIC_CELLS), ["nodes"],
            sort_overrides={"nodes": _numeric_sort, "typo_col": _numeric_sort})


def test_partial_order_kept_verbatim():
    # An override may drop values; the Python order is the subset as-returned
    # (the frontend's _ordered_nodes appends any present-but-omitted keys).
    subset = lambda c: [x for x in sorted(c, key=int) if int(x) <= 3]
    ordering = compute_category_ordering(
        _df(NUMERIC_CELLS), ["nodes"], sort_overrides={"nodes": subset})
    assert ordering["nodes"]["order"] == ["1", "2", "3"]


# ----- constructor validation -----

def test_constructor_rejects_non_callable():
    with pytest.raises(TypeError):
        Guidepost(list_columns=["nodes"], sort_by=123)


def test_constructor_rejects_dict_with_non_callable_value():
    with pytest.raises(TypeError):
        Guidepost(list_columns=["nodes"], sort_by={"nodes": "not callable"})


def test_constructor_accepts_callable_and_dict():
    Guidepost(list_columns=["nodes"], sort_by=_numeric_sort)
    Guidepost(list_columns=["nodes"], sort_by={"nodes": _numeric_sort})


# ----- end-to-end: sort_by reaches _summary_stats via load_data -----

def test_load_data_wires_sort_by_into_summary_stats():
    rng = np.arange(24)
    df = pd.DataFrame({
        "nodes": [[str((i % 12) + 1)] for i in rng],   # numeric-named node list
        "runtime": rng.astype(float),
        "power": (rng * 2).astype(float),
        "energy": (rng * 3).astype(float),
        "queue": ["short" if i % 2 else "long" for i in rng],
    })
    gp = Guidepost(list_columns=["nodes"], sort_by={"nodes": _numeric_sort})
    gp.suppress_warnings = True
    gp.load_data(df)
    stats = gp._summary_stats["nodes"]
    assert stats["category_order"] == NUMERIC_EXPECTED
    assert "category_hierarchy" not in stats and "category_score" not in stats

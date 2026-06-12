"""
Unit tests for co-occurrence seriation + association-aware selection
(``guidepost.seriation``). Run via:

    pytest tests/test_seriation.py -v
"""

import numpy as np
import pandas as pd
import pytest

from guidepost import Guidepost
from guidepost.seriation import compute_category_seriation


def _seriate(cells):
    df = pd.DataFrame({"nodes": cells})
    return compute_category_seriation(df, ["nodes"]).get("nodes")


def _contiguous(order, group):
    # True when every member of `group` occupies a single unbroken run in order.
    idxs = sorted(order.index(g) for g in group)
    return idxs == list(range(idxs[0], idxs[0] + len(group)))


# ----- seriation order -----

def test_two_clusters_stay_contiguous():
    # Two cliques with no cross-cluster co-occurrence.
    cells = [
        ["a1", "a2"], ["a2", "a3"], ["a1", "a3"],
        ["b1", "b2"], ["b2", "b3"], ["b1", "b3"],
    ]
    info = _seriate(cells)
    order = info["order"]
    assert set(order) == {"a1", "a2", "a3", "b1", "b2", "b3"}
    assert _contiguous(order, ["a1", "a2", "a3"])
    assert _contiguous(order, ["b1", "b2", "b3"])


def test_deterministic_across_runs():
    cells = [["a1", "a2"], ["a2", "a3"], ["a1", "a3"], ["b1", "b2"], ["b2", "b3"]]
    first = _seriate(cells)
    second = _seriate(cells)
    assert first["order"] == second["order"]
    assert first["score"] == second["score"]


def test_single_node():
    info = _seriate([["x"], ["x"]])
    assert info["order"] == ["x"]
    assert info["score"] == {"x": 1.0}


def test_empty_column_is_skipped():
    df = pd.DataFrame({"nodes": [np.nan, np.nan]})
    assert "nodes" not in compute_category_seriation(df, ["nodes"])


def test_disconnected_singletons_fall_back_to_name_order():
    info = _seriate([["q"], ["p"]])
    assert info["order"] == ["p", "q"]


# ----- association-aware score -----

def test_rare_node_coupled_to_common_outscores_unremarkable_node():
    # A: common (10 jobs). B: rare (2 jobs) but ALWAYS with A. C: mid-frequency
    # (4 jobs), no strong partner. D/E: mutually-rare, only ever with each other.
    cells = []
    for _ in range(8):
        cells.append(["A"])            # A alone
    cells.append(["A", "B"])           # B's only two jobs, both include common A
    cells.append(["A", "B"])
    for _ in range(4):
        cells.append(["C"])            # C alone, mid frequency
    cells.append(["D", "E"])           # mutually-rare pair
    cells.append(["D", "E"])

    info = _seriate(cells)
    score = info["score"]
    freq = {"A": 10, "B": 2, "C": 4, "D": 2, "E": 2}

    # B is rarer than C but scores higher — it's surprisingly coupled to common A.
    assert freq["B"] < freq["C"]
    assert score["B"] > score["C"]
    # Mutually-rare D/E (coupled only to each other) stay low — below mid node C.
    assert score["D"] < score["C"]
    assert score["E"] < score["C"]


# ----- integration through load_data -----

def test_load_data_ships_order_and_score_for_list_columns_only():
    df = pd.DataFrame({
        "nodes": [["a1", "a2"], ["a2", "a3"], ["a1", "a3"], ["b1", "b2"]],
        "plain": ["x", "y", "x", "z"],
        "y":     [1.0, 2.0, 3.0, 4.0],
        "color": [5.0, 6.0, 7.0, 8.0],
    })
    gp = Guidepost(list_columns=["nodes"])
    gp.suppress_warnings = True
    gp.load_data(df)

    nodes_stats = gp._summary_stats["nodes"]
    assert "category_order" in nodes_stats and "category_score" in nodes_stats
    assert set(nodes_stats["category_order"]) == {"a1", "a2", "a3", "b1", "b2"}

    # Non-list columns carry neither field.
    assert "category_order" not in gp._summary_stats["plain"]
    assert "category_score" not in gp._summary_stats["plain"]

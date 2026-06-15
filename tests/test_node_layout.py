"""
Unit tests for structure-aware node-name layout (``guidepost.node_layout``).
Run via:

    pytest tests/test_node_layout.py -v
"""

import pandas as pd
import pytest

from guidepost import Guidepost
from guidepost.node_layout import (
    parse_node_name,
    detect_structured,
    compute_node_layout,
)
from guidepost.seriation import compute_category_ordering


# ----- parse_node_name -----

def test_parse_cray_xname():
    assert parse_node_name("x1008c0s0b1n1") == [
        ("x", 1008), ("c", 0), ("s", 0), ("b", 1), ("n", 1)
    ]


def test_parse_polaris_xname():
    assert parse_node_name("x3005c0s19b1n0") == [
        ("x", 3005), ("c", 0), ("s", 19), ("b", 1), ("n", 0)
    ]


@pytest.mark.parametrize("bad", ["", "foo", "x", "queue-a", "x1c", "1234", "x1.2"])
def test_parse_rejects_unstructured(bad):
    assert parse_node_name(bad) is None


def test_parse_single_segment_ok():
    assert parse_node_name("nid001234") == [("nid", 1234)]


# ----- detect_structured -----

def test_detect_pure_xname():
    names = ["x1000c0s0b0n0", "x1000c0s0b0n1", "x1008c1s2b1n1"]
    ok, parsed, prefixes = detect_structured(names)
    assert ok
    assert prefixes == ["x", "c", "s", "b", "n"]
    assert set(parsed) == set(names)


def test_detect_rejects_below_threshold():
    # 80% garbage -> not structured.
    names = ["x1000c0s0b0n0"] + [f"queue-{i}" for i in range(9)]
    ok, _parsed, prefixes = detect_structured(names)
    assert not ok
    assert prefixes is None


def test_detect_rejects_mixed_depths():
    # Uniform-depth requirement: ragged segment counts are not structured.
    names = ["x1c0", "x1c0s0b0n0", "x2c1", "x3c2"]
    ok, _parsed, prefixes = detect_structured(names)
    # Dominant prefix seq is the depth-2 one (3 of 4); depth-5 outlier excluded,
    # but 3/4 = 0.75 < 0.95 so overall not structured.
    assert not ok


# ----- compute_node_layout -----

def test_layout_numeric_aware_order():
    # x1009 must precede x1010 (numeric), and x100... is cabinet-major.
    names = ["x1010c0s0b0n0", "x1009c0s0b0n0", "x1009c0s0b0n1"]
    layout = compute_node_layout(names)
    assert layout is not None
    assert layout["order"] == ["x1009c0s0b0n0", "x1009c0s0b0n1", "x1010c0s0b0n0"]


def test_layout_hierarchy_nesting():
    names = ["x1008c0s0b1n1"]
    layout = compute_node_layout(names)
    keys = layout["hierarchy"]["x1008c0s0b1n1"]
    # Grouping levels = depth-1 (4 cabinet..blade) + leaf node name.
    assert keys == ["x1008", "x1008c0", "x1008c0s0", "x1008c0s0b1", "x1008c0s0b1n1"]
    # Each level key is a string-prefix of the next (clean nesting).
    for a, b in zip(keys, keys[1:]):
        assert b.startswith(a)


def test_layout_levels_labels():
    layout = compute_node_layout(["x1008c0s0b1n1"])
    assert layout["levels"] == ["cabinet", "chassis", "slot", "blade"]


def test_layout_returns_none_when_unstructured():
    assert compute_node_layout(["queue-a", "queue-b", "debug"]) is None


# ----- dispatch through compute_category_ordering -----

def test_ordering_dispatch_structured_vs_fallback():
    df = pd.DataFrame({
        "nodes": [["x1008c0s0b1n1"], ["x1008c0s0b1n0"], ["x1009c1s2b0n0"]],
        "queues": [["debug"], ["batch"], ["debug", "batch"]],
    })
    out = compute_category_ordering(df, ["nodes", "queues"])
    # Structured node column ships hierarchy/levels, no score.
    assert "hierarchy" in out["nodes"] and "levels" in out["nodes"]
    assert "score" not in out["nodes"]
    # Arbitrary categories fall back to seriation: order + score, no hierarchy.
    assert "score" in out["queues"] and "hierarchy" not in out["queues"]


# ----- integration through load_data -----

def test_load_data_ships_hierarchy_for_structured_nodes():
    df = pd.DataFrame({
        "nodes": [
            ["x1008c0s0b1n1"], ["x1008c0s0b1n0"],
            ["x1009c1s2b0n0"], ["x1009c1s2b0n1"],
        ],
        "y":     [1.0, 2.0, 3.0, 4.0],
        "color": [5.0, 6.0, 7.0, 8.0],
        "cat":   ["a", "b", "a", "b"],
    })
    gp = Guidepost(list_columns=["nodes"])
    gp.suppress_warnings = True
    gp.load_data(df)

    stats = gp._summary_stats["nodes"]
    assert "category_hierarchy" in stats
    assert "category_levels" in stats
    assert stats["category_levels"] == ["cabinet", "chassis", "slot", "blade"]
    # All nodes present in the hierarchy + order (nothing dropped).
    assert set(stats["category_order"]) == set(stats["category_hierarchy"])
    # Structured columns don't carry the seriation score.
    assert "category_score" not in stats

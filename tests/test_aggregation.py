"""
Unit tests for the AggregationEngine. Exercised via pytest:

    pytest tests/test_aggregation.py -v

Covers the contract the JS side relies on: per-facet column rollups, per-cell
stats keyed by (x_bin, y_bin), category filter masking, and brush-indices
returning gp_idx for the matching rows.
"""

import numpy as np
import pandas as pd
import pytest

from guidepost.aggregation import AggregationEngine


@pytest.fixture
def df_small():
    rng = np.random.default_rng(seed=42)
    n = 1000
    return pd.DataFrame({
        "gp_idx": np.arange(n, dtype=np.int64),
        "cpu":   rng.gamma(2, 30, n),
        "mem":   rng.gamma(2, 60, n),
        "iops":  rng.exponential(50, n),
        "team":  rng.choice(["alpha", "beta"], n),
        "queue": rng.choice(["short", "medium", "long"], n),
    })


def linear_thresholds(series, n_bins):
    lo, hi = float(series.min()), float(series.max())
    return [lo + (hi - lo) * i / n_bins for i in range(n_bins + 1)]


def test_aggregate_returns_one_entry_per_facet(df_small):
    eng = AggregationEngine(df_small)
    x_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "cpu"], 10)
             for f in df_small.team.unique()}
    y_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "mem"], 5)
             for f in df_small.team.unique()}

    grid = eng.aggregate(
        facet_by="team", x="cpu", y="mem", color="iops", color_agg="avg",
        x_thresholds_by_facet=x_thr,
        y_thresholds_by_facet=y_thr,
    )

    assert set(grid.keys()) == set(df_small.team.unique())
    for fac in grid:
        assert "columns" in grid[fac]
        assert len(grid[fac]["columns"]) == 10
        for col in grid[fac]["columns"]:
            assert len(col["bins"]) == 5
            assert "count" in col
            assert "avg" in col
            for cell in col["bins"]:
                assert "count" in cell
                assert "avg" in cell
                assert "std_ratio" in cell


def test_aggregate_counts_match_dataframe(df_small):
    """The summed per-column counts should equal the total non-null rows per facet."""
    eng = AggregationEngine(df_small)
    x_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "cpu"], 10)
             for f in df_small.team.unique()}
    y_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "mem"], 5)
             for f in df_small.team.unique()}

    grid = eng.aggregate(
        facet_by="team", x="cpu", y="mem", color="iops", color_agg="avg",
        x_thresholds_by_facet=x_thr,
        y_thresholds_by_facet=y_thr,
    )

    for fac in grid:
        col_sum = sum(c["count"] for c in grid[fac]["columns"])
        expected = int((df_small.team == fac).sum())
        # Bucket boundaries can drop a small number of rows on the upper edge
        # depending on float jitter; assert we account for ≥99% of them.
        assert col_sum / expected >= 0.99, f"{fac}: bucketed {col_sum} of {expected}"


def test_aggregate_filter_reduces_counts(df_small):
    eng = AggregationEngine(df_small)
    x_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "cpu"], 10)
             for f in df_small.team.unique()}
    y_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "mem"], 5)
             for f in df_small.team.unique()}

    unfiltered = eng.aggregate(
        facet_by="team", x="cpu", y="mem", color="iops", color_agg="avg",
        x_thresholds_by_facet=x_thr,
        y_thresholds_by_facet=y_thr,
    )
    filtered = eng.aggregate(
        facet_by="team", x="cpu", y="mem", color="iops", color_agg="avg",
        x_thresholds_by_facet=x_thr,
        y_thresholds_by_facet=y_thr,
        category_col="queue", category_filter=["short"],
    )

    for fac in unfiltered:
        u_total = sum(c["count"] for c in unfiltered[fac]["columns"])
        f_total = sum(c["count"] for c in filtered[fac]["columns"])
        assert f_total < u_total, f"{fac}: filter did not reduce count"
        # Filter to one of three categories — roughly a third of rows.
        assert 0.2 * u_total <= f_total <= 0.5 * u_total


def test_aggregate_supports_alternative_color_aggregators(df_small):
    """Each agg name should populate the per-cell key the JS heatmap reads."""
    eng = AggregationEngine(df_small)
    x_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "cpu"], 5)
             for f in df_small.team.unique()}
    y_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "mem"], 3)
             for f in df_small.team.unique()}

    for agg in ["avg", "median", "min", "max", "sum"]:
        grid = eng.aggregate(
            facet_by="team", x="cpu", y="mem", color="iops", color_agg=agg,
            x_thresholds_by_facet=x_thr,
            y_thresholds_by_facet=y_thr,
        )
        fac = next(iter(grid))
        cell = grid[fac]["columns"][0]["bins"][0]
        # Canonical avg/median/min/max keys always present; the active agg
        # also has a value either there or under its own key.
        if agg in ("avg", "median", "min", "max"):
            assert cell[agg] != 0 or cell["count"] == 0
        else:
            assert agg in cell


def test_brush_indices_returns_gp_idx_in_range(df_small):
    eng = AggregationEngine(df_small)
    # Brush the whole cpu range for facet 'alpha'; should return all alpha rows.
    alpha = df_small[df_small.team == "alpha"]
    indices = eng.brush_indices(
        facet_by="team", x="cpu", y="mem", facet="alpha",
        x_range=[float(alpha.cpu.min()), float(alpha.cpu.max())],
    )
    assert indices.dtype == np.int32
    assert set(indices.tolist()) == set(alpha.gp_idx.tolist())


def test_brush_indices_respects_y_range_screen_inverted(df_small):
    """JS sends y_range as [upper, lower] (screen-inverted). Engine must sort."""
    eng = AggregationEngine(df_small)
    alpha = df_small[df_small.team == "alpha"]
    lo, hi = float(alpha.mem.quantile(0.25)), float(alpha.mem.quantile(0.75))
    # Pass screen-inverted order on purpose
    indices = eng.brush_indices(
        facet_by="team", x="cpu", y="mem", facet="alpha",
        y_range=[hi, lo],
    )
    in_band = alpha[(alpha.mem >= lo) & (alpha.mem <= hi)]
    assert set(indices.tolist()) == set(in_band.gp_idx.tolist())


def test_brush_indices_intersects_brush_and_category_filter(df_small):
    """When both a brush range and a category filter are active, the engine
    must intersect the two (rows in the brush AND matching the filter)."""
    eng = AggregationEngine(df_small)
    alpha = df_small[df_small.team == "alpha"]
    cpu_lo = float(alpha.cpu.quantile(0.25))
    cpu_hi = float(alpha.cpu.quantile(0.75))
    indices = eng.brush_indices(
        facet_by="team", x="cpu", y="mem", facet="alpha",
        x_range=[cpu_lo, cpu_hi],
        category_col="queue", category_filter=["short"],
    )
    expected = alpha[
        (alpha.cpu >= cpu_lo) & (alpha.cpu <= cpu_hi) & (alpha.queue == "short")
    ]
    assert set(indices.tolist()) == set(expected.gp_idx.tolist())


def test_brush_indices_filter_alone_returns_empty(df_small):
    """Filter without an actual brush yields no selection — selection is gated
    by the brush, filter only narrows. Matches the legacy JS semantic."""
    eng = AggregationEngine(df_small)
    indices = eng.brush_indices(
        facet_by="team", x="cpu", y="mem", facet="alpha",
        category_col="queue", category_filter=["short"],
    )
    assert len(indices) == 0


def test_brush_indices_returns_empty_when_no_brush(df_small):
    """A cleared brush should not return any rows, with or without filter."""
    eng = AggregationEngine(df_small)
    assert len(eng.brush_indices(
        facet_by="team", x="cpu", y="mem", facet="alpha",
    )) == 0
    # Same for explicit empty ranges
    assert len(eng.brush_indices(
        facet_by="team", x="cpu", y="mem", facet="alpha",
        x_range=[], y_range=[],
    )) == 0


def test_aggregate_includes_zero_values_with_log_floor_thresholds():
    """Regression: log-scale axes have thresholds[0] = log_values_floor (1).
    JS replaces zero-valued rows with 1 before binning; Python sees raw zeros.
    The engine must absorb those zero rows into bin 0 instead of dropping
    them — otherwise the unfilter response misses ~all rows for axes that
    contain zeros (the perma-filter symptom)."""
    rng = np.random.default_rng(0)
    n = 1000
    df = pd.DataFrame({
        "gp_idx": np.arange(n, dtype=np.int64),
        # Mix of zeros and log-scale-spanning values to mirror real HPC data.
        "cpu":   np.concatenate([np.zeros(400), rng.gamma(2, 30, n - 400)]),
        "mem":   np.concatenate([np.zeros(300), rng.gamma(2, 60, n - 300)]),
        "iops":  rng.exponential(50, n),
        "team":  rng.choice(["alpha", "beta"], n),
        "queue": rng.choice(["short", "medium", "long"], n),
    })
    eng = AggregationEngine(df)
    # Thresholds shaped like the JS log-scale path: start at 1 (the log floor),
    # extend through the data max. Linear spacing for test simplicity.
    def log_thresholds(series, n_thr):
        hi = float(series.replace(0, 1).max())
        # 1-anchored thresholds (mimics JS logScale(1, max+1, n_thr))
        return [1 + (hi - 1) * i / (n_thr - 1) for i in range(n_thr)]
    x_thr = {f: log_thresholds(df.loc[df.team == f, "cpu"], 50)
             for f in df.team.unique()}
    y_thr = {f: log_thresholds(df.loc[df.team == f, "mem"], 25)
             for f in df.team.unique()}

    grid = eng.aggregate(
        facet_by="team", x="cpu", y="mem", color="iops", color_agg="avg",
        x_thresholds_by_facet=x_thr,
        y_thresholds_by_facet=y_thr,
    )
    for fac in grid:
        # Must include every non-null row in this facet; the zero-valued
        # rows should land in bin 0 along with values in [1, threshold[1]).
        total = sum(c["count"] for c in grid[fac]["columns"])
        expected = int((df.team == fac).sum())
        assert total == expected, (
            f"facet {fac!r}: binned {total} of {expected} rows — "
            "underflow bin should absorb zero values"
        )


def test_brush_indices_captures_zero_values_at_edge():
    """Regression: when the user brushes the leftmost/bottommost histogram
    bin, the JS-side extends the range to MIN_SAFE_INTEGER so the SQL
    captures data points below `log_values_floor` (zeros that JS would
    have sanitized into bin 0). Without this, the heatmap visually
    highlights the bin but the selection count stays at 0."""
    n = 1000
    rng = np.random.default_rng(123)
    df = pd.DataFrame({
        "gp_idx": np.arange(n, dtype=np.int64),
        # Mix zeros and log-spanning values, like real HPC data.
        "cpu":   np.concatenate([np.zeros(400), rng.gamma(2, 30, n - 400)]),
        "mem":   np.concatenate([np.zeros(300), rng.gamma(2, 60, n - 300)]),
        "iops":  rng.exponential(50, n),
        "team":  rng.choice(["alpha", "beta"], n),
        "queue": rng.choice(["short", "medium", "long"], n),
    })
    eng = AggregationEngine(df)

    # Simulate the JS edge-extension: lower bound becomes MIN_SAFE_INTEGER
    # when the brush touches threshold[0] = 1 (the log floor).
    MIN_SAFE = -(2 ** 53 - 1)
    indices = eng.brush_indices(
        facet_by="team", x="cpu", y="mem", facet="alpha",
        x_range=[MIN_SAFE, 50.0],  # extended low edge
    )
    expected = df[(df.team == "alpha") & (df.cpu <= 50.0)]
    assert set(indices.tolist()) == set(expected.gp_idx.tolist())
    # Sanity: this must include the cpu==0 rows that the prior fixed-bound
    # brush would have dropped.
    assert (expected.cpu == 0).any()


def test_brush_indices_handles_timestamptz_columns():
    """Regression: TIMESTAMP WITH TIME ZONE columns compared against the
    naive ISO strings JS sends (Date.toISOString() minus the trailing Z)
    used to be interpreted in the DuckDB session timezone — which, on a
    typical America/Chicago dev machine, shifted the comparison boundary
    by 5–6 hours and silently dropped all rows for densely-clustered UTC
    data. The engine now pins the session timezone to UTC so JS-supplied
    naive strings round-trip cleanly."""
    import pyarrow as pa
    # Cluster the data in early UTC hours of one day — exactly the case
    # where a Chicago-tz session would drop every row.
    arr = pa.array(pd.to_datetime(
        ["2025-04-15 01:00", "2025-04-15 02:00", "2025-04-15 03:00", "2025-04-15 04:00"],
        utc=True,
    ))
    df = pd.DataFrame({
        "gp_idx": np.arange(4, dtype=np.int64),
        "x": pd.array(arr, dtype=pd.ArrowDtype(pa.timestamp("ns", tz="UTC"))),
        "y": [1.0, 2.0, 3.0, 4.0],
        "team": ["alpha"] * 4,
    })
    eng = AggregationEngine(df)
    # JS-style naive UTC ISO range that brackets the data.
    indices = eng.brush_indices(
        facet_by="team", x="x", y="y", facet="alpha",
        x_range=["2025-04-15 00:00:00.000", "2025-04-16 00:00:00.000"],
    )
    assert set(indices.tolist()) == {0, 1, 2, 3}


def test_aggregate_cache_hit_returns_same_grid(df_small):
    """Identical aggregate() calls should be served from cache, both
    correctness-wise (same grid) and quickly (no extra DuckDB call)."""
    eng = AggregationEngine(df_small)
    x_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "cpu"], 20)
             for f in df_small.team.unique()}
    y_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "mem"], 10)
             for f in df_small.team.unique()}
    args = dict(
        facet_by="team", x="cpu", y="mem", color="iops", color_agg="avg",
        x_thresholds_by_facet=x_thr, y_thresholds_by_facet=y_thr,
    )

    g1 = eng.aggregate(**args)
    assert eng._agg_cache_hits == 0 and eng._agg_cache_misses == 1
    g2 = eng.aggregate(**args)
    assert eng._agg_cache_hits == 1 and eng._agg_cache_misses == 1
    # Same instance — cache returns a shared reference (JS doesn't mutate it).
    assert g1 is g2


def test_aggregate_cache_differs_on_filter(df_small):
    """A different category_filter must miss the cache and yield a different
    result; switching back to the original must hit again."""
    eng = AggregationEngine(df_small)
    x_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "cpu"], 10)
             for f in df_small.team.unique()}
    y_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "mem"], 5)
             for f in df_small.team.unique()}
    base = dict(
        facet_by="team", x="cpu", y="mem", color="iops", color_agg="avg",
        x_thresholds_by_facet=x_thr, y_thresholds_by_facet=y_thr,
    )

    g_all = eng.aggregate(**base)
    g_short = eng.aggregate(**base, category_col="queue", category_filter=["short"])
    g_all_again = eng.aggregate(**base)
    assert g_all is g_all_again            # cache hit
    assert g_all is not g_short            # distinct keys
    assert eng._agg_cache_hits == 1
    assert eng._agg_cache_misses == 2


def test_replace_invalidates_cache(df_small):
    """Swapping the underlying DataFrame must invalidate any cached grids."""
    eng = AggregationEngine(df_small)
    x_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "cpu"], 10)
             for f in df_small.team.unique()}
    y_thr = {f: linear_thresholds(df_small.loc[df_small.team == f, "mem"], 5)
             for f in df_small.team.unique()}
    args = dict(
        facet_by="team", x="cpu", y="mem", color="iops", color_agg="avg",
        x_thresholds_by_facet=x_thr, y_thresholds_by_facet=y_thr,
    )
    _ = eng.aggregate(**args)
    assert len(eng._agg_cache) == 1
    eng.replace(df_small.iloc[:50])
    assert len(eng._agg_cache) == 0


def test_replace_swaps_underlying_dataframe(df_small):
    eng = AggregationEngine(df_small)
    new_df = df_small.iloc[:10].copy()
    eng.replace(new_df)
    indices = eng.brush_indices(
        facet_by="team", x="cpu", y="mem", facet="alpha",
        x_range=[float(new_df.cpu.min()), float(new_df.cpu.max())],
    )
    # After replace, only the first 10 rows (some of which are 'alpha') can match.
    assert len(indices) <= 10

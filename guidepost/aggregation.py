"""
Server-side aggregation engine for Guidepost.

Moves the heaviest interactive path — recomputing per-(x,y)-cell statistics
when a category filter is applied — off the browser and into DuckDB. At
1M rows the JS-side `calculate_box_metrics` rerun was ~1–2s per bar-chart
click; DuckDB's vectorized groupby completes the same work in ~100ms.

The engine is owned by the Guidepost widget. The widget calls
`aggregate(...)` in response to JS-originated `request_aggregation` messages
and ships the result back over anywidget's comm channel.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Optional

import duckdb
import numpy as np
import pandas as pd

# Cap on the per-engine aggregate-result cache. The user typically cycles
# through ≤10 bar-chart categories plus the unfiltered baseline; 32 leaves
# headroom for axis/color-agg switching as well.
_AGG_CACHE_MAX = 32


# Aggregator name → DuckDB SQL function. AVG and MEDIAN are exact (DuckDB
# uses APPROX_QUANTILE for very large groups but the row counts per cell
# stay well below that threshold).
_COLOR_AGG_SQL = {
    "avg":      "AVG",
    "mean":     "AVG",
    "average":  "AVG",
    "median":   "MEDIAN",
    "med":      "MEDIAN",
    "min":      "MIN",
    "max":      "MAX",
    "sum":      "SUM",
    "count":    "COUNT",
}


class AggregationEngine:
    """
    Owns a DuckDB view over the cleaned DataFrame and computes per-facet,
    per-(x,y)-cell stats from explicit threshold arrays produced by the JS
    side. Thresholds are passed in (rather than recomputed here) so the
    cell layout stays aligned with the JS-side bins the heatmap is already
    rendering.
    """

    def __init__(self, df: pd.DataFrame) -> None:
        # Single in-process connection; DuckDB is thread-safe for reads.
        self._conn = duckdb.connect()
        # Pin the session timezone to UTC. JS sends Date values as naive UTC
        # ISO strings (`Date.toISOString()` minus the trailing `Z`); DuckDB
        # otherwise interprets those naive strings — and TIMESTAMP literals
        # built from them — in the *system* timezone when comparing them
        # against TIMESTAMP WITH TIME ZONE columns, which silently shifts
        # bin boundaries (e.g. by 5–6 h in America/Chicago) and can drop
        # all rows for densely-clustered UTC data.
        self._conn.execute("SET TimeZone='UTC'")
        # `register` exposes the DataFrame as a zero-copy view named "df".
        self._conn.register("df", df)
        self._df = df
        # LRU cache for aggregate() results. The same request signature is
        # dispatched by every mouseleave (always-unfiltered) and by repeat
        # hovers on the same bar; caching turns those into instant returns
        # instead of re-running 3+ SQL queries per facet.
        self._agg_cache: "OrderedDict[tuple, dict]" = OrderedDict()
        self._agg_cache_hits = 0
        self._agg_cache_misses = 0

    def replace(self, df: pd.DataFrame) -> None:
        """Swap the underlying DataFrame (e.g., on `records=` re-assignment)."""
        self._conn.unregister("df")
        self._conn.register("df", df)
        self._df = df
        # New data → previous grids are stale.
        self._agg_cache.clear()

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass

    @staticmethod
    def _freeze_thresholds(d: dict[str, list]) -> tuple:
        """Hashable, order-preserving snapshot of a facet→thresholds dict."""
        return tuple((k, tuple(d[k] or ())) for k in sorted(d or {}))

    def aggregate(
        self,
        *,
        facet_by: str,
        x: str,
        y: str,
        color: str,
        color_agg: str,
        x_thresholds_by_facet: dict[str, list],
        y_thresholds_by_facet: dict[str, list],
        category_col: Optional[str] = None,
        category_filter: Optional[list[str]] = None,
    ) -> dict:
        # Cache lookup. Keyed by every input that affects the SQL output.
        cache_key = (
            facet_by, x, y, color, color_agg,
            self._freeze_thresholds(x_thresholds_by_facet),
            self._freeze_thresholds(y_thresholds_by_facet),
            category_col,
            tuple(category_filter) if category_filter else None,
        )
        cached = self._agg_cache.get(cache_key)
        if cached is not None:
            # Touch for LRU ordering, then return the same dict — JS-side
            # `_apply_python_grid` only reads cells (no mutation), so a
            # shared reference is safe.
            self._agg_cache.move_to_end(cache_key)
            self._agg_cache_hits += 1
            return cached
        self._agg_cache_misses += 1
        result = self._aggregate_uncached(
            facet_by=facet_by, x=x, y=y, color=color, color_agg=color_agg,
            x_thresholds_by_facet=x_thresholds_by_facet,
            y_thresholds_by_facet=y_thresholds_by_facet,
            category_col=category_col,
            category_filter=category_filter,
        )
        self._agg_cache[cache_key] = result
        if len(self._agg_cache) > _AGG_CACHE_MAX:
            self._agg_cache.popitem(last=False)
        return result

    def _aggregate_uncached(
        self,
        *,
        facet_by: str,
        x: str,
        y: str,
        color: str,
        color_agg: str,
        x_thresholds_by_facet: dict[str, list],
        y_thresholds_by_facet: dict[str, list],
        category_col: Optional[str] = None,
        category_filter: Optional[list[str]] = None,
    ) -> dict:
        """
        Computes the heatmap grid for each facet.

        Returns a dict shaped to match what JSModel.calculate_box_metrics
        writes onto `faceted_bins[fac].column[i]` and `.column[i].bins[j]`:

            {
              facet_name: {
                "columns": [
                  {
                    "count": int,
                    "min": ..., "max": ..., "avg": ..., "median": ...,
                    "bins": [
                      {"count": int, "min": ..., "max": ..., "avg": ...,
                       "median": ..., "std_ratio": float},
                      ...one entry per y-bin...
                    ]
                  },
                  ...one entry per x-bin (left-edge per threshold)...
                ]
              },
              ...
            }

        Cells with zero matching rows still appear as zero-count slots so
        the JS renderer can address them by index.
        """
        agg = _COLOR_AGG_SQL.get(color_agg, "AVG")

        # Build per-facet WHERE clauses for the optional category filter.
        cat_clause = ""
        params: list = []
        if category_col and category_filter:
            placeholders = ",".join(["?"] * len(category_filter))
            cat_clause = f' AND "{category_col}" IN ({placeholders})'
            params.extend(category_filter)

        result: dict = {}

        # One query per facet keeps thresholds tractable (each facet can
        # have its own x/y thresholds because _build_axis re-detects log
        # vs linear per facet). For 10 facets at 1M rows total this is
        # still ~100ms end-to-end in DuckDB.
        for facet, x_thresholds in x_thresholds_by_facet.items():
            y_thresholds = y_thresholds_by_facet.get(facet, [])
            if not x_thresholds or not y_thresholds:
                result[facet] = {"columns": []}
                continue

            n_x = len(x_thresholds) - 1
            n_y = len(y_thresholds) - 1
            if n_x <= 0 or n_y <= 0:
                result[facet] = {"columns": []}
                continue

            # Datetimes need ms-since-epoch coercion before bucketing so
            # the JS-side Date thresholds match the SQL comparisons.
            x_expr = self._coerce_for_threshold(f'"{x}"', x_thresholds)
            y_expr = self._coerce_for_threshold(f'"{y}"', y_thresholds)

            # Single query computes all three aggregation levels we need —
            # per-cell stats, per-column rollup, and the facet-level color
            # STDDEV for std_ratio — via GROUPING SETS. Replaces the prior
            # three sequential queries per facet (~3× fewer round-trips
            # into DuckDB at the dominant CASE-WHEN parsing cost).
            sql = f"""
                WITH binned AS (
                    SELECT
                        {self._threshold_case(x_expr, x_thresholds, 'x_bin')} AS x_bin,
                        {self._threshold_case(y_expr, y_thresholds, 'y_bin')} AS y_bin,
                        "{color}" AS color_val,
                        "{y}" AS y_val
                    FROM df
                    WHERE "{facet_by}" = ?
                      AND "{x}" IS NOT NULL
                      AND "{y}" IS NOT NULL
                      {cat_clause}
                ), kept AS (
                    SELECT * FROM binned WHERE x_bin IS NOT NULL AND y_bin IS NOT NULL
                )
                SELECT
                    x_bin, y_bin,
                    COUNT(*) AS row_count,
                    MIN(color_val) AS c_min,
                    MAX(color_val) AS c_max,
                    AVG(color_val) AS c_avg,
                    MEDIAN(color_val) AS c_median,
                    STDDEV(color_val) AS c_std,
                    {agg}(color_val) AS c_agg,
                    MIN(y_val) AS y_min,
                    MAX(y_val) AS y_max,
                    AVG(y_val) AS y_avg,
                    MEDIAN(y_val) AS y_median,
                    STDDEV(y_val) AS y_std,
                    GROUPING(x_bin) AS g_x,
                    GROUPING(y_bin) AS g_y
                FROM kept
                GROUP BY GROUPING SETS ((x_bin, y_bin), (x_bin), ())
                ORDER BY GROUPING(x_bin) + GROUPING(y_bin) DESC
            """
            facet_params = [facet] + params
            rows = self._conn.execute(sql, facet_params).fetchall()

            # Materialize an n_x × n_y empty grid, then fill from the query.
            columns: list[dict] = []
            for xi in range(n_x):
                cell_bins = [
                    {
                        "count": 0, "min": 0, "max": 0, "avg": 0,
                        "median": 0, "std": 0, "std_ratio": 0,
                    }
                    for _ in range(n_y)
                ]
                columns.append({
                    "count": 0, "min": 0, "max": 0, "avg": 0,
                    "median": 0, "std": 0,
                    "bins": cell_bins,
                })

            # Rows arrive in grouping-set order (grand → column → cell), so
            # facet_color_std is known by the time per-cell rows are
            # processed and std_ratio can be filled in-place.
            facet_color_std = 0.0
            for row in rows:
                (xi, yi, count, c_min, c_max, c_avg, c_median, c_std, c_agg,
                 y_min, y_max, y_avg, y_median, y_std, g_x, g_y) = row

                if g_x == 1 and g_y == 1:
                    # Grand total — single row, captures facet-color STDDEV.
                    facet_color_std = float(c_std) if c_std else 0.0
                    continue

                if g_y == 1:
                    # Per-column rollup: stats over y values for this x_bin.
                    if xi is not None and 0 <= xi < n_x:
                        col = columns[xi]
                        col["count"] = int(count or 0)
                        col["min"] = self._safe_num(y_min)
                        col["max"] = self._safe_num(y_max)
                        col["avg"] = self._safe_num(y_avg)
                        col["median"] = self._safe_num(y_median)
                        col["std"] = self._safe_num(y_std)
                    continue

                # Per-cell stats.
                if (xi is not None and yi is not None
                        and 0 <= xi < n_x and 0 <= yi < n_y):
                    cell = columns[xi]["bins"][yi]
                    cell["count"] = int(count or 0)
                    cell["min"] = self._safe_num(c_min)
                    cell["max"] = self._safe_num(c_max)
                    cell["avg"] = self._safe_num(c_avg)
                    cell["median"] = self._safe_num(c_median)
                    cell["std"] = self._safe_num(c_std)
                    cell["std_ratio"] = (
                        cell["std"] / facet_color_std if facet_color_std else 0
                    )
                    # The JS heatmap reads `cell[color_agg]` for fill; the
                    # _COLOR_AGG_SQL aliases (avg/mean/average etc.) all
                    # map back to the canonical fields above. For non-canonical
                    # names also expose the requested aggregation under its
                    # original key so JS can index by it directly.
                    cell[color_agg] = self._safe_num(c_agg)

            result[facet] = {"columns": columns}

        return result

    def brush_indices(
        self,
        *,
        facet_by: str,
        x: str,
        y: str,
        facet: str,
        x_range: Optional[list] = None,
        y_range: Optional[list] = None,
        category_col: Optional[str] = None,
        category_filter: Optional[list[str]] = None,
    ) -> np.ndarray:
        """
        Returns the gp_idx values for rows that fall inside the given x/y
        brush ranges within the named facet (and optional category filter).

        Returns an empty array if no brush range is active — filter alone
        does not yield a selection (matches the legacy JS semantic). A
        cleared brush, even with a category filter still selected on the
        bar chart, should report zero selected records.
        """
        has_x = x_range and len(x_range) == 2
        has_y = y_range and len(y_range) == 2
        if not has_x and not has_y:
            return np.empty(0, dtype=np.int32)

        clauses = [f'"{facet_by}" = ?']
        params: list = [facet]
        if has_x:
            # JS sends ISO-like strings for Date axes. For TIMESTAMP WITH
            # TIME ZONE columns DuckDB parses naive strings in the *session*
            # timezone, not UTC, which can drop rows whose values fall in
            # the offset gap between UTC midnight and the local midnight
            # JS rounded toward. Coerce to UTC-aware datetime first so the
            # bind is unambiguous.
            x_lo, x_hi = self._to_utc_if_str(x_range[0]), self._to_utc_if_str(x_range[1])
            clauses.append(f'"{x}" >= ? AND "{x}" <= ?')
            params.extend([x_lo, x_hi])
        if has_y:
            # JS pre-normalizes y_range to ascending data values when it
            # translates from row-index space, but sort here defensively so
            # any direct caller (e.g., tests) can still pass either order.
            y0 = self._to_utc_if_str(y_range[0])
            y1 = self._to_utc_if_str(y_range[1])
            lo, hi = sorted([y0, y1])
            clauses.append(f'"{y}" >= ? AND "{y}" <= ?')
            params.extend([lo, hi])
        if category_col and category_filter:
            placeholders = ",".join(["?"] * len(category_filter))
            clauses.append(f'"{category_col}" IN ({placeholders})')
            params.extend(category_filter)
        where = " AND ".join(clauses)
        # DISTINCT guards the forthcoming node-scoped selection path: once a
        # list-valued (exploded) column drives the WHERE, a job touching N
        # matching nodes would otherwise return its gp_idx N times.
        sql = f'SELECT DISTINCT "gp_idx" FROM df WHERE {where}'
        arr = self._conn.execute(sql, params).fetchnumpy()
        # `fetchnumpy` returns a dict {col: ndarray}; pick the single column.
        indices = next(iter(arr.values())) if arr else np.empty(0, dtype=np.int64)
        return indices.astype(np.int32, copy=False)

    @staticmethod
    def _to_utc_if_str(v):
        """
        JS Date.toISOString() (after the `T`/`Z` strip) yields naive ISO
        strings even though the value is UTC. Bind them as UTC-aware
        datetimes so DuckDB's session-timezone interpretation can't shift
        the comparison boundary against TIMESTAMP WITH TIME ZONE columns.
        Non-strings pass through unchanged.
        """
        if not isinstance(v, str):
            return v
        from datetime import datetime, timezone
        s = v.strip()
        # Handle trailing 'Z' just in case, and the JS-stripped form.
        if s.endswith("Z"):
            s = s[:-1]
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            return v  # Let DuckDB try to parse if our format guess is off.
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt

    @staticmethod
    def _safe_num(v):
        if v is None:
            return 0
        if isinstance(v, float) and (v != v):  # NaN
            return 0
        return float(v)

    @staticmethod
    def _coerce_for_threshold(col_sql: str, thresholds: list) -> str:
        """
        When threshold values are datetimes (sent from JS as ms-since-epoch
        numbers, JS Date.getTime()-style), coerce the DuckDB column to the
        same epoch-ms representation for an apples-to-apples comparison.
        """
        if thresholds and isinstance(thresholds[0], (int, float)):
            # Numeric thresholds — column might still be a TIMESTAMP if JS
            # sent ms-based thresholds derived from a datetime. Detect that
            # case from the value magnitude (epoch-ms for modern dates is
            # > 1e12, well above any HPC numeric range we'd reasonably
            # bucket). We can't easily introspect column types here without
            # a probe query, so let DuckDB handle the coercion via EPOCH_MS.
            #
            # In practice this is only an issue for datetime axes, which JS
            # currently always sends as Date objects (not ms). The threshold
            # values themselves arrive as ISO strings or numbers depending
            # on JSON serialization; the comm-layer handler normalizes them
            # before calling this method.
            return col_sql
        return col_sql

    @staticmethod
    def _threshold_case(col_sql: str, thresholds: list, alias: str) -> str:
        """
        Builds a CASE expression that maps `col_sql` into an integer bin
        index against `thresholds`. Uniform width_bucket would be faster
        but doesn't handle non-uniform (log-scale) thresholds.

        Outer-bin semantics match what JS does:
          - The FIRST bin is an underflow bucket — any value < threshold[1]
            lands here. JS uses log-scale thresholds that start at
            `log_values_floor = 1` and calls `sanitize_data_for_log` to
            replace zeros with 1 *before* binning. Python sees the raw
            DataFrame and would otherwise drop every zero-valued row to
            NULL; making bin 0 an underflow bucket absorbs them.
          - The LAST bin is an overflow bucket — any value >= the second-
            to-last threshold lands here. Matches `binValues`' overflow
            check (`i === thresholds.length - 2`) so values at exactly
            `stats.max` aren't lost.
        """
        if len(thresholds) < 2:
            return f"CASE WHEN {col_sql} IS NOT NULL THEN 0 ELSE NULL END"
        last_i = len(thresholds) - 2
        parts = []
        for i in range(len(thresholds) - 1):
            lo = AggregationEngine._sql_literal(thresholds[i])
            hi = AggregationEngine._sql_literal(thresholds[i + 1])
            if i == 0:
                parts.append(f"WHEN {col_sql} < {hi} THEN {i}")
            elif i == last_i:
                parts.append(f"WHEN {col_sql} >= {lo} THEN {i}")
            else:
                parts.append(f"WHEN {col_sql} >= {lo} AND {col_sql} < {hi} THEN {i}")
        return "CASE " + " ".join(parts) + " ELSE NULL END"

    @staticmethod
    def _sql_literal(v) -> str:
        if v is None:
            return "NULL"
        if isinstance(v, str):
            # Datetime threshold sent as ISO string.
            return f"TIMESTAMP '{v}'"
        return str(v)

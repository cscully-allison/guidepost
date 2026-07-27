"""
Selection as a first-class analytical object.

`gp.selection` used to be a thin wrapper exposing only `.dataframe`. This module
turns a selection into an object that describes the *hypothesis it implies*: the
predicate that separates the selected rows from the population, operationalizations
of that predicate (pandas / SQL / Altair), a rich per-variable distribution
description (selection vs. population), and a link to the widget's selection history.

Design note — where the predicate comes from
---------------------------------------------
The visualization only syncs the *result* of a selection back to Python (a list of
`gp_idx` row indices). The defining brush ranges / category filters live in the JS
frontend and are not synced. So here we *derive* the predicate by comparing the
selected rows to the full population: the [min, max] span for numeric/temporal
columns and the value-set for categorical columns, keeping a clause only when the
selection is a strict subset of the population on that column.

This is *descriptive* (the bounding box the selection occupies) rather than
*authoritative* (the exact pixels the user brushed), but it has two nice properties:
it covers **every** column rather than just the 2-3 on the axes, and it needs no
frontend changes. `Predicate`/`Clause` are structured so an authoritative JS-synced
source could replace `_derive_predicate` later without changing the public API.
"""

from __future__ import annotations

import math
from typing import Optional

import numpy as np
import pandas as pd
from pandas.api import types as ptypes

# scipy ships transitively via scikit-learn (a hard dependency), but we never
# hard-require it: skew/kurtosis/normaltest all have closed-form numpy fallbacks
# so the POC degrades gracefully in a stripped environment.
try:  # pragma: no cover - exercised via the fallback path in tests
    from scipy import stats as _scipy_stats
    _HAVE_SCIPY = True
except Exception:  # pragma: no cover
    _scipy_stats = None
    _HAVE_SCIPY = False

# Columns that are internal plumbing and must never surface in a predicate or
# distribution report.
_INTERNAL_COLS = {"gp_idx"}

# Float tolerance when deciding whether a selection's [min, max] is a *strict*
# subset of the population's range. Relative to the population span so it scales
# across HPC magnitudes (nanoseconds vs. petabytes).
_RANGE_REL_TOL = 1e-9

# A numeric/temporal range only counts as a real *constraint* if it actually cuts
# off a meaningful fraction of the population — not if it's merely a hair narrower
# because a subset of N rows naturally has a tighter min/max than the whole
# population (sampling shrinkage). Require at least this fraction of the
# population to fall strictly outside the selection's range on at least one side.
# Without this, essentially every numeric column would pick up a spurious clause.
_MIN_NUMERIC_CUT = 0.02

# A categorical constraint is only a meaningful *filter* if the selection occupies
# a small set of values. On real data, high-cardinality columns (user/job hashes,
# node lists) would otherwise emit a clause enumerating hundreds of incidental
# values — noise, not a predicate. Above this many distinct selected values we
# treat the column as unconstrained.
_MAX_CATEGORY_CLAUSE = 25


def _is_numeric_kind(semantic_type: str, dtype) -> bool:
    return semantic_type in ("continuous", "ordinal") and ptypes.is_numeric_dtype(dtype)


def _is_temporal_kind(dtype) -> bool:
    return ptypes.is_datetime64_any_dtype(dtype)


class Clause:
    """A single per-column constraint that helps define a selection.

    A clause is one of:
      * a numeric/temporal *range* constraint (``lo``/``hi`` both set), or
      * a categorical *membership* constraint (``values`` set).

    It knows how to render itself into the three operational dialects the API
    exposes: a pandas ``df.query`` fragment, a SQL ``WHERE`` fragment, and an
    Altair predicate dict.
    """

    def __init__(self, column, kind, lo=None, hi=None, values=None):
        self.column = column
        self.kind = kind  # "numeric" | "temporal" | "categorical"
        self.lo = lo
        self.hi = hi
        self.values = list(values) if values is not None else None

    # ---- pandas ---------------------------------------------------------
    def to_pandas(self) -> str:
        col = f"`{self.column}`"
        if self.kind in ("numeric", "temporal"):
            lo, hi = self._pandas_bound(self.lo), self._pandas_bound(self.hi)
            return f"{col} >= {lo} and {col} <= {hi}"
        return f"{col} in {self._py_list_literal(self.values)}"

    def _pandas_bound(self, v):
        if self.kind == "temporal":
            # pd.Timestamp is round-trippable and df.query understands it.
            return f'@pd.Timestamp("{pd.Timestamp(v).isoformat()}")'
        return repr(float(v))

    @staticmethod
    def _py_list_literal(values) -> str:
        return "[" + ", ".join(repr(_py_scalar(v)) for v in values) + "]"

    # ---- SQL ------------------------------------------------------------
    def to_sql(self) -> str:
        col = _sql_ident(self.column)
        if self.kind in ("numeric", "temporal"):
            return f"{col} BETWEEN {self._sql_lit(self.lo)} AND {self._sql_lit(self.hi)}"
        return f"{col} IN ({', '.join(self._sql_lit(v) for v in self.values)})"

    def _sql_lit(self, v) -> str:
        if self.kind == "temporal":
            return f"TIMESTAMP '{pd.Timestamp(v).isoformat(sep=' ')}'"
        if isinstance(v, str):
            return "'" + v.replace("'", "''") + "'"
        if isinstance(v, bool):
            return "TRUE" if v else "FALSE"
        return str(_py_scalar(v))

    # ---- Altair ---------------------------------------------------------
    def to_altair(self) -> dict:
        if self.kind == "numeric":
            return {"field": self.column, "range": [float(self.lo), float(self.hi)]}
        if self.kind == "temporal":
            return {
                "field": self.column,
                "range": [pd.Timestamp(self.lo).isoformat(),
                          pd.Timestamp(self.hi).isoformat()],
            }
        return {"field": self.column, "oneOf": [_py_scalar(v) for v in self.values]}

    def __repr__(self) -> str:
        if self.kind in ("numeric", "temporal"):
            return f"{self.column} ∈ [{_fmt(self.lo)}, {_fmt(self.hi)}]"
        n = len(self.values)
        shown = ", ".join(str(v) for v in self.values[:4])
        more = f", …(+{n - 4})" if n > 4 else ""
        return f"{self.column} ∈ {{{shown}{more}}}"


class Predicate:
    """A conjunction (AND) of :class:`Clause` constraints.

    An empty predicate means "no constraint distinguishes the selection from the
    population" — its operationalizations are the identity filter (all rows).
    """

    def __init__(self, clauses=None):
        self.clauses = list(clauses or [])

    def __bool__(self):
        return len(self.clauses) > 0

    def __len__(self):
        return len(self.clauses)

    def __iter__(self):
        return iter(self.clauses)

    def column(self, name) -> Optional[Clause]:
        """Return the clause constraining ``name`` (or None)."""
        for c in self.clauses:
            if c.column == name:
                return c
        return None

    def to_pandas(self) -> str:
        if not self.clauses:
            return "index == index"  # all-true, valid for df.query
        return " and ".join(f"({c.to_pandas()})" for c in self.clauses)

    def to_sql_where(self) -> str:
        if not self.clauses:
            return "1=1"
        return " AND ".join(f"({c.to_sql()})" for c in self.clauses)

    def to_altair_filter(self) -> dict:
        if not self.clauses:
            return {}
        return {"and": [c.to_altair() for c in self.clauses]}

    def describe(self) -> str:
        if not self.clauses:
            return "(no constraints — selection spans the full population)"
        return "\n".join(f"  • {c!r}" for c in self.clauses)

    def __repr__(self) -> str:
        return f"Predicate(\n{self.describe()}\n)" if self.clauses else "Predicate(empty)"


def _derive_predicate(selected_df: pd.DataFrame,
                      population_df: pd.DataFrame,
                      summary_stats: dict) -> Predicate:
    """Reconstruct the predicate that separates ``selected_df`` from the population.

    For each column, add a clause only when the selection is a *strict* subset of
    the population on that column — i.e. the column actually constrains the
    selection. Unconstrained columns contribute nothing, so the predicate reads as
    exactly the dimensions that define the selection.

    A clause must never *drop* a selected row: a range/membership predicate can't
    represent a column the selection has missing (NaN) values on — those rows fail
    the comparison — so such columns are skipped. This keeps the predicate a
    faithful superset of the selection (and exact for rectangle selections).
    """
    clauses = []
    if selected_df is None or len(selected_df) == 0:
        return Predicate(clauses)

    for col in population_df.columns:
        if col in _INTERNAL_COLS or col not in selected_df.columns:
            continue
        info = summary_stats.get(col, {}) if summary_stats else {}
        semantic = info.get("semantic_type")
        is_list = info.get("is_list", False)
        dtype = population_df[col].dtype

        sel_raw = selected_df[col]
        # If any selected row is missing on this column, a clause built from the
        # non-null values would exclude those rows — so the column can't faithfully
        # constrain the selection. Skip it.
        if sel_raw.isna().any():
            continue
        sel = sel_raw.dropna()
        pop = population_df[col].dropna()
        if len(sel) == 0 or len(pop) == 0:
            continue

        # Categorical / ordinal-as-label / list columns → membership clause.
        if is_list or semantic in ("categorical",) or (
            semantic is None and not ptypes.is_numeric_dtype(dtype)
            and not _is_temporal_kind(dtype)
        ):
            sel_vals = _value_set(sel, is_list)
            pop_vals = _value_set(pop, is_list)
            # Strict subset, and small enough to read as a real category filter
            # (not an incidental enumeration of a high-cardinality column).
            if sel_vals and sel_vals < pop_vals and len(sel_vals) <= _MAX_CATEGORY_CLAUSE:
                ordered = [v for v in _stable_order(pop, is_list) if v in sel_vals]
                clauses.append(Clause(col, "categorical", values=ordered))
            continue

        # Temporal → range clause on timestamps.
        if _is_temporal_kind(dtype):
            s_lo, s_hi = sel.min(), sel.max()
            if _range_is_real_cut(sel, pop, s_lo, s_hi):
                clauses.append(Clause(col, "temporal", lo=s_lo, hi=s_hi))
            continue

        # Numeric (continuous or ordinal) → range clause.
        if _is_numeric_kind(semantic or "continuous", dtype) or ptypes.is_numeric_dtype(dtype):
            s_lo, s_hi = float(sel.min()), float(sel.max())
            if _range_is_real_cut(sel, pop, s_lo, s_hi):
                clauses.append(Clause(col, "numeric", lo=s_lo, hi=s_hi))
            continue

    return Predicate(clauses)


def _range_is_real_cut(sel, pop, s_lo, s_hi) -> bool:
    """True when the selection's [s_lo, s_hi] excludes a meaningful fraction of
    the population — i.e. it's an actual brush, not just sampling shrinkage of the
    min/max. Requires ``_MIN_NUMERIC_CUT`` of the population strictly outside the
    range on at least one side."""
    n = len(pop)
    if n == 0:
        return False
    frac_below = float((pop < s_lo).sum()) / n
    frac_above = float((pop > s_hi).sum()) / n
    return max(frac_below, frac_above) >= _MIN_NUMERIC_CUT


class DistributionReport(dict):
    """Distribution stats for one variable, selection vs. population.

    Behaves as a plain dict (so it's easy to serialize / feed to `mentor`) but
    renders as a compact human-readable block, including a unicode sparkline.
    """

    def __repr__(self) -> str:
        c = self.get("column")
        lines = [f"Distribution of {c!r}  (selection vs. population)"]
        lines.append(f"  n            {self['n']}  ({self['pct_of_population']:.1f}% of population)")
        lines.append(f"  mean         {_fmt(self['mean'])}   (pop {_fmt(self['population_mean'])})")
        lines.append(f"  median       {_fmt(self['median'])}   (pop {_fmt(self['population_median'])})")
        lines.append(f"  std          {_fmt(self['std'])}   (pop {_fmt(self['population_std'])})")
        lines.append(f"  min / max    {_fmt(self['min'])} / {_fmt(self['max'])}")
        lines.append(f"  q25 / q75    {_fmt(self['q25'])} / {_fmt(self['q75'])}   (IQR {_fmt(self['iqr'])})")
        lines.append(f"  skew         {_fmt(self['skew'])}    kurtosis {_fmt(self['kurtosis'])}")
        lines.append(f"  normality    {self['normality_hint']}")
        if self.get("median_ratio") is not None:
            lines.append(f"  vs pop       median {self['median_ratio']:.2f}×, "
                         f"shift {_fmt(self['shift_in_sigma'])}σ")
        lines.append(f"  histogram    {self['sparkline']}")
        return "\n".join(lines)


def _describe_distribution(col: str,
                           selected_df: pd.DataFrame,
                           population_df: pd.DataFrame) -> DistributionReport:
    """Rich numeric distribution description, selection vs. population."""
    if col not in population_df.columns:
        raise KeyError(f"Column {col!r} is not in the data.")

    sel = pd.to_numeric(selected_df[col], errors="coerce").dropna() \
        if col in selected_df.columns else pd.Series([], dtype=float)
    pop = pd.to_numeric(population_df[col], errors="coerce").dropna()
    if len(pop) == 0:
        raise ValueError(f"Column {col!r} has no numeric values to describe.")
    if len(sel) == 0:
        raise ValueError(f"Selection has no values for {col!r} (empty selection?).")

    arr = sel.to_numpy(dtype="float64")
    mean, std = float(np.mean(arr)), float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0
    median = float(np.median(arr))
    q25, q75 = float(np.quantile(arr, 0.25)), float(np.quantile(arr, 0.75))

    pop_mean = float(np.mean(pop))
    pop_median = float(np.median(pop))
    pop_std = float(np.std(pop.to_numpy(dtype="float64"), ddof=1)) if len(pop) > 1 else 0.0

    report = DistributionReport({
        "column": col,
        "n": int(len(arr)),
        "pct_of_population": 100.0 * len(arr) / len(pop),
        "mean": mean,
        "std": std,
        "median": median,
        "min": float(np.min(arr)),
        "max": float(np.max(arr)),
        "q25": q25,
        "q75": q75,
        "iqr": q75 - q25,
        "skew": _skew(arr),
        "kurtosis": _kurtosis(arr),
        "normality_hint": _normality_hint(arr),
        "population_mean": pop_mean,
        "population_median": pop_median,
        "population_std": pop_std,
        # vs-population deltas: how far the selection sits from the whole.
        "median_ratio": (median / pop_median) if pop_median not in (0, 0.0) else None,
        "shift_in_sigma": ((mean - pop_mean) / pop_std) if pop_std else 0.0,
        "sparkline": _sparkline(arr),
    })
    return report


class CategoricalReport(dict):
    """Category-frequency description for one variable, selection vs. population.

    The categorical analogue of :class:`DistributionReport`. Like it, behaves as a
    plain dict but renders as a compact block. The headline signal is per-category
    *lift* — how over- or under-represented a value is in the selection relative to
    the population (the categorical counterpart of the numeric σ-shift).
    """

    kind = "categorical"

    def __repr__(self) -> str:
        c = self.get("column")
        lines = [f"Categorical distribution of {c!r}  (selection vs. population)"]
        lines.append(f"  n             {self['n']}  ({self['pct_of_population']:.1f}% of population)")
        lines.append(f"  distinct      {self['n_unique']}   (pop {self['population_n_unique']})")
        lines.append(f"  concentration {_fmt(self['concentration'])}   "
                     f"(0 = one value, 1 = spread evenly across its values)")
        lines.append("  top categories          selection   population     lift")
        for row in self["top_categories"]:
            lift = "  n/a" if row["lift"] is None else f"{row['lift']:5.1f}×"
            bar = _share_bar(row["sel_share"])
            lines.append(
                f"    {str(row['value'])[:20]:20s}  {row['sel_share']*100:6.1f}%   "
                f"{row['pop_share']*100:6.1f}%   {lift}  {bar}")
        if self["over_represented"]:
            over = ", ".join(f"{r['value']} ({r['lift']:.1f}×)" for r in self["over_represented"])
            lines.append(f"  over-represented:  {over}")
        if self["only_in_selection"]:
            vals = ", ".join(str(v) for v in self["only_in_selection"][:6])
            lines.append(f"  only in selection: {vals}")
        return "\n".join(lines)


# How many top categories to tabulate in a CategoricalReport.
_TOP_CATEGORIES = 8


def _describe_categorical(col: str,
                          selected_df: pd.DataFrame,
                          population_df: pd.DataFrame,
                          is_list: bool) -> CategoricalReport:
    """Category-frequency description, selection vs. population, keyed on lift."""
    if col not in population_df.columns:
        raise KeyError(f"Column {col!r} is not in the data.")

    sel_series = selected_df[col] if col in selected_df.columns else pd.Series([], dtype=object)
    sel_counts = _value_counts(sel_series, is_list)
    pop_counts = _value_counts(population_df[col], is_list)
    sel_total = int(sel_counts.sum())
    pop_total = int(pop_counts.sum())
    if pop_total == 0:
        raise ValueError(f"Column {col!r} has no values to describe.")
    if sel_total == 0:
        raise ValueError(f"Selection has no values for {col!r} (empty selection?).")

    # Per-category shares and lift (selection share ÷ population share).
    rows = []
    for value, sel_c in sel_counts.items():
        pop_c = int(pop_counts.get(value, 0))
        sel_share = sel_c / sel_total
        pop_share = (pop_c / pop_total) if pop_total else 0.0
        lift = (sel_share / pop_share) if pop_share > 0 else None  # None ⇒ absent in pop
        rows.append({
            "value": _py_scalar(value),
            "sel_count": int(sel_c),
            "pop_count": pop_c,
            "sel_share": sel_share,
            "pop_share": pop_share,
            "lift": lift,
        })
    rows.sort(key=lambda r: r["sel_count"], reverse=True)

    # Distinctive categories: most over-represented among those with a real
    # presence in the selection (guard against tiny-count noise).
    min_count = max(2, int(0.01 * sel_total))
    over = sorted(
        (r for r in rows if r["lift"] is not None and r["lift"] > 1.5
         and r["sel_count"] >= min_count),
        key=lambda r: r["lift"], reverse=True)[:5]
    only_in_sel = [r["value"] for r in rows if r["pop_count"] == 0]

    return CategoricalReport({
        "column": col,
        "is_list": is_list,
        "n": sel_total,
        "pct_of_population": 100.0 * sel_total / pop_total,
        "n_unique": int(len(sel_counts)),
        "population_n_unique": int(len(pop_counts)),
        # Normalized entropy: 0 when the selection is one value, 1 when spread
        # evenly across all the values it occupies — a concentration read.
        "concentration": _normalized_entropy(sel_counts.to_numpy()),
        "top_categories": rows[:_TOP_CATEGORIES],
        "over_represented": over,
        "only_in_selection": only_in_sel,
    })


# --------------------------------------------------------------------------
# Selection
# --------------------------------------------------------------------------

class Selection:
    """A first-class selection: its rows, the predicate that defines it, and the
    tools to operationalize and describe it.

    Lazy by design — a `Selection` holds a *snapshot* of the selected ``gp_idx``
    plus a reference to the owning widget. The materialized DataFrame and derived
    predicate are computed on first access and cached, so recording one on every
    brush (for history) stays cheap.
    """

    def __init__(self, widget, selected_idx, timestamp=None, history_index=None):
        self._widget = widget
        self.selected_idx = list(selected_idx or [])
        self.timestamp = timestamp
        self.history_index = history_index
        self._dataframe = None
        self._predicate = None
        self._population = None

    # ---- lazy core ------------------------------------------------------
    @property
    def dataframe(self) -> pd.DataFrame:
        if self._dataframe is None:
            self._dataframe = self._materialize()
        return self._dataframe

    def _materialize(self) -> pd.DataFrame:
        cached = self._widget.cached_records_df
        if cached is None:
            raise ValueError("No data has been loaded yet. Please set widget.records = df first.")
        if not self.selected_idx:
            return cached.iloc[0:0].drop(columns=[c for c in _INTERNAL_COLS if c in cached.columns])
        df = cached[cached["gp_idx"].isin(self.selected_idx)]
        return df.drop(columns=[c for c in _INTERNAL_COLS if c in df.columns])

    @property
    def _population_df(self) -> pd.DataFrame:
        if self._population is None:
            cached = self._widget.cached_records_df
            self._population = cached.drop(columns=[c for c in _INTERNAL_COLS if c in cached.columns])
        return self._population

    @property
    def predicate(self) -> Predicate:
        if self._predicate is None:
            self._predicate = _derive_predicate(
                self.dataframe, self._population_df, self._widget._summary_stats)
        return self._predicate

    # ---- operationalizations -------------------------------------------
    def to_pandas(self) -> str:
        """A ``df.query`` string that reproduces this selection from the population."""
        return self.predicate.to_pandas()

    def to_sql_where(self) -> str:
        """A SQL ``WHERE`` clause body reproducing this selection."""
        return self.predicate.to_sql_where()

    def to_altair_filter(self) -> dict:
        """An Altair-style predicate dict (`{"and": [...]}`)."""
        return self.predicate.to_altair_filter()

    # ---- descriptions ---------------------------------------------------
    def describe_distribution(self, column):
        """Describe ``column`` in the selection against the population.

        Dispatches on the column's semantic type: numeric/temporal columns get a
        :class:`DistributionReport` (quantiles, skew, σ-shift, sparkline); a
        categorical, boolean, id-label, or list column gets a
        :class:`CategoricalReport` (per-category share, lift, concentration).
        """
        if column not in self._population_df.columns:
            raise KeyError(f"Column {column!r} is not in the data.")
        if self._is_categorical_column(column):
            info = (self._widget._summary_stats or {}).get(column, {})
            return _describe_categorical(
                column, self.dataframe, self._population_df, info.get("is_list", False))
        return _describe_distribution(column, self.dataframe, self._population_df)

    def _is_categorical_column(self, column) -> bool:
        """True when ``column`` should be described categorically. Trusts the
        widget's semantic type (so id-like numeric labels and bools count as
        categorical); falls back to dtype when summary stats are unavailable."""
        info = (self._widget._summary_stats or {}).get(column, {})
        semantic = info.get("semantic_type")
        if info.get("is_list") or semantic == "categorical":
            return True
        if semantic in ("continuous", "ordinal"):
            return False
        dtype = self._population_df[column].dtype
        return (not ptypes.is_numeric_dtype(dtype)
                and not ptypes.is_datetime64_any_dtype(dtype))

    def summary(self) -> str:
        """A short human-readable characterization of the selection."""
        n = len(self)
        n_pop = len(self._population_df)
        pct = (100.0 * n / n_pop) if n_pop else 0.0
        lines = [f"Selection: {n:,} of {n_pop:,} records ({pct:.1f}% of population)"]

        pred = self.predicate
        lines.append("Predicate:")
        lines.append(pred.describe())

        # A few headline facts across the constrained columns — median shift for
        # numeric clauses, the standout over-represented value for categorical ones.
        headlines = []
        for c in pred.clauses:
            try:
                rep = self.describe_distribution(c.column)
            except Exception:
                continue
            if c.kind == "numeric" and rep.get("median_ratio"):
                headlines.append(
                    f"{c.column}: median {rep['median_ratio']:.2f}× population "
                    f"({_fmt(rep['shift_in_sigma'])}σ shift)")
            elif c.kind == "categorical" and rep.get("over_represented"):
                top = rep["over_represented"][0]
                headlines.append(
                    f"{c.column}: {top['value']!r} is {top['lift']:.1f}× over-represented "
                    f"({top['sel_share']*100:.0f}% of selection vs {top['pop_share']*100:.0f}% of population)")
            if len(headlines) >= 3:
                break
        if headlines:
            lines.append("Notable:")
            lines.extend(f"  • {h}" for h in headlines)
        return "\n".join(lines)

    # ---- history --------------------------------------------------------
    @property
    def history(self):
        """The owning widget's list of past selections (oldest first)."""
        return getattr(self._widget, "_selection_history", [])

    # ---- dunders --------------------------------------------------------
    def __len__(self):
        return len(self.selected_idx)

    def __repr__(self) -> str:
        n_pop = len(self._population_df) if self._widget.cached_records_df is not None else 0
        pct = (100.0 * len(self) / n_pop) if n_pop else 0.0
        ts = f", at={self.timestamp:%H:%M:%S}" if self.timestamp else ""
        return f"Selection(n={len(self)}, {pct:.1f}% of population, clauses={len(self.predicate)}{ts})"


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

def _sql_ident(name: str) -> str:
    """Double-quote a SQL identifier, doubling embedded quotes. Mirrors
    AggregationEngine._qi so generated SQL matches the engine's dialect."""
    return '"' + str(name).replace('"', '""') + '"'


def _py_scalar(v):
    """Convert numpy scalars to native python for clean reprs / JSON."""
    if hasattr(v, "item"):
        try:
            return v.item()
        except Exception:
            return v
    return v


def _value_set(series: pd.Series, is_list: bool) -> set:
    if is_list:
        vals = series.explode().dropna()
        return set(_py_scalar(v) for v in vals.unique())
    return set(_py_scalar(v) for v in series.unique())


def _stable_order(series: pd.Series, is_list: bool):
    """Population value order by frequency (desc) — keeps categorical clauses
    deterministic and reads most-common-first."""
    s = series.explode().dropna() if is_list else series
    vc = s.astype(object).value_counts()
    return [_py_scalar(k) for k in vc.index]


def _value_counts(series: pd.Series, is_list: bool) -> pd.Series:
    """Frequency of each category (list columns are exploded first). NaN dropped."""
    s = series.explode().dropna() if is_list else series.dropna()
    return s.astype(object).value_counts()


def _normalized_entropy(counts) -> float:
    """Shannon entropy of a count vector, normalized to [0, 1]. 0 = all mass on one
    value; 1 = spread evenly across the values present. Reads as a concentration
    measure for a categorical selection."""
    counts = np.asarray(counts, dtype="float64")
    counts = counts[counts > 0]
    if counts.size <= 1:
        return 0.0
    p = counts / counts.sum()
    h = -np.sum(p * np.log(p))
    return float(h / math.log(counts.size))


_SHARE_BLOCKS = "▏▎▍▌▋▊▉█"


def _share_bar(share: float, width: int = 8) -> str:
    """A tiny proportional bar (0–1) for a category's selection share."""
    share = max(0.0, min(1.0, float(share)))
    full = int(share * width)
    rem = share * width - full
    bar = "█" * full
    if full < width and rem > 0:
        bar += _SHARE_BLOCKS[min(len(_SHARE_BLOCKS) - 1, int(rem * len(_SHARE_BLOCKS)))]
    return bar


def _fmt(v) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, (pd.Timestamp,)):
        return v.isoformat()
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    if not math.isfinite(f):
        return str(f)
    if f == 0:
        return "0"
    if abs(f) >= 1e6 or abs(f) < 1e-3:
        return f"{f:.3g}"
    return f"{f:,.3f}".rstrip("0").rstrip(".")


def _skew(arr: np.ndarray) -> float:
    if _HAVE_SCIPY:
        return float(_scipy_stats.skew(arr, bias=False)) if len(arr) > 2 else 0.0
    n = len(arr)
    if n < 3:
        return 0.0
    m = arr.mean()
    s = arr.std(ddof=1)
    if s == 0:
        return 0.0
    g1 = np.mean(((arr - m) / s) ** 3)
    return float(g1 * math.sqrt(n * (n - 1)) / (n - 2))  # bias-corrected


def _kurtosis(arr: np.ndarray) -> float:
    """Excess kurtosis (0 == normal)."""
    if _HAVE_SCIPY:
        return float(_scipy_stats.kurtosis(arr, fisher=True, bias=False)) if len(arr) > 3 else 0.0
    n = len(arr)
    if n < 4:
        return 0.0
    m = arr.mean()
    s = arr.std(ddof=1)
    if s == 0:
        return 0.0
    m4 = np.mean(((arr - m) / s) ** 4)
    # bias-corrected excess kurtosis
    return float((n - 1) / ((n - 2) * (n - 3)) * ((n + 1) * m4 - 3 * (n - 1)))


def _normality_hint(arr: np.ndarray) -> str:
    """A qualitative read on normality — drives parametric vs. non-parametric
    wording in `mentor`. Uses scipy's normaltest p-value when available; else a
    skew/kurtosis rule of thumb."""
    if len(arr) < 8:
        return "too few points to assess"
    if _HAVE_SCIPY:
        try:
            _, p = _scipy_stats.normaltest(arr)
            if p < 0.05:
                return f"likely non-normal (normaltest p={p:.3g})"
            return f"consistent with normal (normaltest p={p:.3g})"
        except Exception:
            pass
    sk, ku = abs(_skew(arr)), abs(_kurtosis(arr))
    if sk < 0.5 and ku < 1.0:
        return "roughly symmetric / bell-shaped (heuristic)"
    return f"skewed / heavy-tailed (|skew|={sk:.2f}, |kurt|={ku:.2f})"


_SPARK_BLOCKS = "▁▂▃▄▅▆▇█"


def _sparkline(arr: np.ndarray, bins: int = 16) -> str:
    """A tiny unicode-block histogram of the selection's values."""
    if len(arr) == 0:
        return ""
    lo, hi = float(np.min(arr)), float(np.max(arr))
    if hi <= lo:
        return _SPARK_BLOCKS[-1] * 1
    counts, _ = np.histogram(arr, bins=bins, range=(lo, hi))
    peak = counts.max()
    if peak == 0:
        return _SPARK_BLOCKS[0] * bins
    idx = (counts / peak * (len(_SPARK_BLOCKS) - 1)).round().astype(int)
    return "".join(_SPARK_BLOCKS[i] for i in idx)

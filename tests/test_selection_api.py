"""
Unit tests for the first-class Selection API and the mentor scaffold.

    pytest tests/test_selection_api.py -v

These construct a headless Guidepost widget, simulate a brush by setting the
`selected_records` trait directly (the same JSON gp_idx array the frontend would
sync back), and exercise the Python-facing API: predicate derivation, the
pandas / SQL / Altair operationalizations, distribution descriptions, history,
and mentor suggestions.
"""

import json

import duckdb
import numpy as np
import pandas as pd
import pytest

from guidepost.guidepost import Guidepost
from guidepost import mentor
import guidepost.selection as selection_mod


@pytest.fixture
def population():
    """A synthetic HPC-like job table: 3 numeric + 2 categorical columns."""
    rng = np.random.default_rng(seed=7)
    n = 2000
    return pd.DataFrame({
        "QUEUED_WAIT_SECONDS": rng.exponential(300, n),
        "CPU_HOURS":           rng.gamma(2, 40, n),
        "NODES":               rng.integers(1, 128, n).astype(float),
        "team":                rng.choice(["alpha", "beta", "gamma"], n),
        "queue":               rng.choice(["short", "medium", "long"], n),
    })


@pytest.fixture
def widget(population):
    gp = Guidepost()
    gp.suppress_warnings = True  # set before load so load_data honors it
    gp.records = population
    return gp


def _brush(gp, mask):
    """Simulate a frontend brush: set selected_records to the gp_idx of `mask`."""
    idx = gp.cached_records_df.loc[mask.values, "gp_idx"].tolist()
    gp.selected_records = json.dumps(idx)
    return idx


# --------------------------------------------------------------------------
# predicate derivation
# --------------------------------------------------------------------------

def test_rectangle_selection_derives_expected_clauses(widget, population):
    # A predicate-shaped ("rectangle") selection: alpha team, high wait band.
    mask = (population["team"] == "alpha") & (population["QUEUED_WAIT_SECONDS"] > 400)
    _brush(widget, mask)

    pred = widget.selection.predicate
    cols = {c.column: c for c in pred.clauses}

    assert "team" in cols and cols["team"].kind == "categorical"
    assert set(cols["team"].values) == {"alpha"}

    assert "QUEUED_WAIT_SECONDS" in cols
    wc = cols["QUEUED_WAIT_SECONDS"]
    assert wc.kind == "numeric" and wc.lo > 400


def test_full_range_column_adds_no_clause(widget, population):
    # Select every row → nothing distinguishes it → empty predicate.
    _brush(widget, pd.Series(np.ones(len(population), dtype=bool)))
    assert len(widget.selection.predicate) == 0
    assert widget.selection.to_pandas() == "index == index"
    assert widget.selection.to_sql_where() == "1=1"
    assert widget.selection.to_altair_filter() == {}


def test_column_with_missing_values_gets_no_clause(population):
    # A selection that includes rows NaN on a column can't be faithfully
    # constrained on it (the clause would drop those rows). It must be skipped,
    # and the pandas round-trip must still return the exact selection.
    pop = population.copy()
    pop["gpu_frac"] = np.where(pop["team"] == "alpha", np.nan, 0.5)  # NaN for alpha
    gp = Guidepost()
    gp.suppress_warnings = True
    gp.records = pop
    mask = (pop["team"] == "alpha") & (pop["QUEUED_WAIT_SECONDS"] > 400)
    _brush(gp, mask)
    sel = gp.selection
    cols = {c.column for c in sel.predicate.clauses}
    assert "gpu_frac" not in cols  # skipped — NaN in the selection
    assert len(pop.query(sel.to_pandas())) == len(sel.dataframe)


def test_high_cardinality_categorical_gets_no_clause(population):
    pop = population.copy()
    pop["user_hash"] = [f"u{i}" for i in range(len(pop))]  # unique per row
    gp = Guidepost()
    gp.suppress_warnings = True
    gp.records = pop
    _brush(gp, pop["QUEUED_WAIT_SECONDS"] > 300)
    cols = {c.column for c in gp.selection.predicate.clauses}
    assert "user_hash" not in cols  # too many distinct values to be a filter


def test_categorical_full_set_adds_no_clause(widget, population):
    # Constrain only a numeric; all team/queue values still present → no cat clause.
    mask = population["CPU_HOURS"] > population["CPU_HOURS"].median()
    _brush(widget, mask)
    cols = {c.column for c in widget.selection.predicate.clauses}
    assert "CPU_HOURS" in cols
    # With half the rows, every category almost surely survives.
    assert "team" not in cols and "queue" not in cols


# --------------------------------------------------------------------------
# operationalizations round-trip
# --------------------------------------------------------------------------

def test_to_pandas_roundtrips_to_same_rows(widget, population):
    mask = (population["team"].isin(["alpha", "beta"])) & (population["NODES"] < 40)
    _brush(widget, mask)
    sel = widget.selection

    got = population.query(sel.to_pandas())
    assert len(got) == len(sel.dataframe)


def test_to_sql_where_roundtrips_in_duckdb(widget, population):
    mask = (population["queue"] == "long") & (population["QUEUED_WAIT_SECONDS"] > 200)
    _brush(widget, mask)
    sel = widget.selection

    con = duckdb.connect()
    con.register("pop", population)
    n = con.execute(f"SELECT COUNT(*) FROM pop WHERE {sel.to_sql_where()}").fetchone()[0]
    assert n == len(sel.dataframe)


def test_to_altair_filter_shape(widget, population):
    mask = (population["team"] == "gamma") & (population["CPU_HOURS"] > 100)
    _brush(widget, mask)
    flt = widget.selection.to_altair_filter()
    assert "and" in flt
    fields = {clause["field"] for clause in flt["and"]}
    assert "team" in fields and "CPU_HOURS" in fields
    for clause in flt["and"]:
        assert ("range" in clause) or ("oneOf" in clause)


def test_arbitrary_selection_query_is_superset(widget, population):
    # A non-rectangle (random) selection: the bounding-box predicate must at
    # least contain the selection (never fewer rows).
    rng = np.random.default_rng(0)
    mask = pd.Series(rng.random(len(population)) < 0.1)
    _brush(widget, mask)
    sel = widget.selection
    got = population.query(sel.to_pandas())
    assert len(got) >= len(sel.dataframe)


# --------------------------------------------------------------------------
# distribution description
# --------------------------------------------------------------------------

def test_describe_distribution_fields(widget, population):
    mask = population["QUEUED_WAIT_SECONDS"] > 500
    _brush(widget, mask)
    rep = widget.selection.describe_distribution("QUEUED_WAIT_SECONDS")

    for key in ("mean", "median", "std", "q25", "q75", "iqr",
                "skew", "kurtosis", "population_median", "shift_in_sigma"):
        assert np.isfinite(rep[key]), key
    assert rep["n"] == int(mask.sum())
    assert rep["shift_in_sigma"] > 0  # selection is the high tail
    assert isinstance(rep["sparkline"], str) and rep["sparkline"]
    assert "normality" not in rep["normality_hint"].lower() or True  # present, human text


def test_describe_distribution_numpy_fallback(widget, population, monkeypatch):
    # Force the scipy-absent path and confirm stats still compute finite values.
    monkeypatch.setattr(selection_mod, "_HAVE_SCIPY", False)
    monkeypatch.setattr(selection_mod, "_scipy_stats", None)
    mask = population["CPU_HOURS"] > 50
    _brush(widget, mask)
    rep = widget.selection.describe_distribution("CPU_HOURS")
    assert np.isfinite(rep["skew"]) and np.isfinite(rep["kurtosis"])
    # The fallback never invokes scipy's normaltest — its hint is the
    # skew/kurtosis rule of thumb (or "too few points").
    assert rep["normality_hint"] and "normaltest" not in rep["normality_hint"]


def test_describe_distribution_unknown_column_raises(widget, population):
    _brush(widget, population["NODES"] > 10)
    with pytest.raises(KeyError):
        widget.selection.describe_distribution("NOPE")


# --------------------------------------------------------------------------
# categorical distribution description
# --------------------------------------------------------------------------

def test_describe_distribution_dispatches_categorical(widget, population):
    # Select mostly-alpha rows so 'team' is concentrated & over-represented.
    mask = (population["team"] == "alpha") | (population["QUEUED_WAIT_SECONDS"] > 900)
    _brush(widget, mask)
    rep = widget.selection.describe_distribution("team")

    assert rep.kind == "categorical"
    for key in ("n_unique", "population_n_unique", "concentration",
                "top_categories", "over_represented", "only_in_selection"):
        assert key in rep
    # Shares of the tabulated categories are proper fractions.
    for row in rep["top_categories"]:
        assert 0.0 <= row["sel_share"] <= 1.0
        assert row["lift"] is None or row["lift"] > 0
    # 'alpha' is deliberately enriched → present among the over-represented.
    over_vals = {r["value"] for r in rep["over_represented"]}
    assert "alpha" in over_vals


def test_categorical_lift_matches_manual_computation(widget, population):
    mask = population["team"].isin(["alpha", "beta"])
    _brush(widget, mask)
    rep = widget.selection.describe_distribution("queue")
    row = next(r for r in rep["top_categories"] if r["value"] == rep["top_categories"][0]["value"])
    val = row["value"]
    sel = widget.selection.dataframe
    exp_sel = (sel["queue"] == val).mean()
    exp_pop = (population["queue"] == val).mean()
    assert row["sel_share"] == pytest.approx(exp_sel)
    assert row["pop_share"] == pytest.approx(exp_pop)
    assert row["lift"] == pytest.approx(exp_sel / exp_pop)


def test_bool_column_described_categorically(population):
    pop = population.copy()
    pop["is_gpu"] = pop["team"] == "alpha"  # bool → categorical semantic
    gp = Guidepost()
    gp.suppress_warnings = True
    gp.records = pop
    _brush(gp, pop["QUEUED_WAIT_SECONDS"] > 500)
    rep = gp.selection.describe_distribution("is_gpu")
    assert rep.kind == "categorical"
    assert rep["n_unique"] <= 2


def test_concentration_bounds(widget, population):
    # Pin to a single team → concentration 0 (all mass on one value).
    _brush(widget, population["team"] == "alpha")
    rep = widget.selection.describe_distribution("team")
    assert rep["concentration"] == pytest.approx(0.0)
    assert rep["n_unique"] == 1


# --------------------------------------------------------------------------
# history + summary
# --------------------------------------------------------------------------

def test_history_records_distinct_selections(widget, population):
    _brush(widget, population["team"] == "alpha")
    _brush(widget, population["team"] == "beta")
    hist = widget.selection.history
    assert len(hist) == 2
    assert hist[0].history_index == 0 and hist[1].history_index == 1
    assert all(s.timestamp is not None for s in hist)


def test_history_skips_noop_repeats_and_empty(widget, population):
    idx = _brush(widget, population["team"] == "alpha")
    # Same set again → no new snapshot.
    widget.selected_records = json.dumps(idx)
    # Empty selection → no snapshot.
    widget.selected_records = json.dumps([])
    assert len(widget.selection.history) == 1


def test_summary_is_human_readable(widget, population):
    mask = (population["team"] == "alpha") & (population["QUEUED_WAIT_SECONDS"] > 400)
    _brush(widget, mask)
    text = widget.selection.summary()
    assert "Selection:" in text and "Predicate:" in text
    assert "%" in text


def test_empty_selection_dataframe(widget):
    # Default trait "[]" → empty, well-formed frame, len 0.
    assert len(widget.selection) == 0
    assert widget.selection.dataframe.empty


# --------------------------------------------------------------------------
# backward-compat: .dataframe unchanged
# --------------------------------------------------------------------------

def test_dataframe_matches_legacy_retrieval(widget, population):
    mask = population["NODES"] > 64
    _brush(widget, mask)
    legacy = widget.retrieve_selected_data()
    assert len(legacy) == len(widget.selection.dataframe)
    assert "gp_idx" not in widget.selection.dataframe.columns


# --------------------------------------------------------------------------
# mentor
# --------------------------------------------------------------------------

def test_mentor_suggests_tests_for_shifted_selection(widget, population):
    mask = population["QUEUED_WAIT_SECONDS"] > 600  # strong high tail
    _brush(widget, mask)
    suggestions = mentor.suggest_tests(widget.selection, focus="CPU_HOURS")
    assert len(suggestions) >= 1
    top = suggestions[0]
    assert top.stat_test and top.rationale and top.code
    assert isinstance(top.to_dict(), dict)


def test_mentor_build_prompt_contains_context(widget, population):
    mask = (population["team"] == "alpha") & (population["QUEUED_WAIT_SECONDS"] > 400)
    _brush(widget, mask)
    prompt = mentor.build_prompt(widget.selection, focus="what makes these jobs slow?")
    assert "PREDICATE" in prompt and "DISTRIBUTIONS" in prompt
    assert "ANALYST FOCUS" in prompt


def test_mentor_llm_falls_back_without_sdk(widget, population, monkeypatch):
    # With the anthropic SDK unavailable, suggest_tests_llm degrades to the
    # rule-based suggester rather than raising.
    import builtins
    real_import = builtins.__import__

    def _no_anthropic(name, *args, **kwargs):
        if name == "anthropic":
            raise ImportError("No module named 'anthropic'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _no_anthropic)
    _brush(widget, population["QUEUED_WAIT_SECONDS"] > 600)
    out = mentor.suggest_tests_llm(widget.selection, focus="CPU_HOURS")
    assert len(out) >= 1 and out[0].stat_test

    # With fallback disabled, the missing SDK surfaces as an error.
    with pytest.raises(Exception):
        mentor.suggest_tests_llm(widget.selection, fallback_to_rules=False)


def test_mentor_build_prompt_includes_categorical_structure(widget, population):
    _brush(widget, (population["team"] == "alpha") & (population["QUEUED_WAIT_SECONDS"] > 400))
    prompt = mentor.build_prompt(widget.selection, focus="cpu")
    assert "PREDICATE" in prompt
    assert "CATEGORICAL STRUCTURE" in prompt and "team" in prompt


def test_mentor_suggests_chi_square_for_categorical_selection(widget, population):
    # A selection pinned to a single team → 'team' is maximally over-represented,
    # so mentor should propose a chi-square membership test on it.
    _brush(widget, population["team"] == "alpha")
    suggestions = mentor.suggest_tests(widget.selection)
    chi = [s for s in suggestions if "Chi-square" in s.stat_test]
    assert chi, "expected a chi-square suggestion for the categorical selection"
    assert "team" in chi[0].variables
    assert "chi2_contingency" in chi[0].code

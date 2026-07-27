"""
Proof-of-concept demo: Selection as a first-class object + the `mentor` scaffold.

Run it headless (no Jupyter / browser needed):

    python demos/selection_api_poc.py

It builds a synthetic HPC job table, constructs a Guidepost widget, and then
*simulates a brush* by setting the `selected_records` trait directly — exactly the
JSON gp_idx array the JS frontend would sync back. From there it drives the whole
Python-facing selection API:

    selection.predicate
    selection.to_pandas() / .to_sql_where() / .to_altair_filter()
    selection.summary()
    selection.describe_distribution("QUEUED_WAIT_SECONDS")
    selection.history
    mentor.suggest_tests(selection, focus=...)
    mentor.build_prompt(selection, focus=...)
"""

import json

import numpy as np
import pandas as pd

from guidepost.guidepost import Guidepost
from guidepost import mentor


def make_data(n=3000, seed=11):
    rng = np.random.default_rng(seed)
    team = rng.choice(["alpha", "beta", "gamma"], n, p=[0.5, 0.3, 0.2])
    queue = rng.choice(["short", "medium", "long"], n)
    # Give team=alpha on the "long" queue a genuinely heavier wait tail, so the
    # selection below has a real story for mentor to find.
    base = rng.exponential(250, n)
    bump = np.where((team == "alpha") & (queue == "long"), rng.exponential(600, n), 0.0)
    return pd.DataFrame({
        "QUEUED_WAIT_SECONDS": base + bump,
        "CPU_HOURS":           rng.gamma(2, 40, n),
        "NODES":               rng.integers(1, 128, n).astype(float),
        "team":                team,
        "queue":               queue,
    })


def hr(title):
    print("\n" + "=" * 72)
    print(title)
    print("=" * 72)


def main():
    df = make_data()
    gp = Guidepost()
    gp.suppress_warnings = True  # set before load so load_data honors it
    gp.records = df

    # --- simulate a brush: "alpha team, long queue, slow jobs" ----------------
    mask = (df["team"] == "alpha") & (df["queue"] == "long") & (df["QUEUED_WAIT_SECONDS"] > 400)
    idx = gp.cached_records_df.loc[mask.values, "gp_idx"].tolist()
    gp.selected_records = json.dumps(idx)

    # ...and a second, different brush so history has something in it.
    mask2 = df["CPU_HOURS"] > df["CPU_HOURS"].quantile(0.9)
    gp.selected_records = json.dumps(
        gp.cached_records_df.loc[mask2.values, "gp_idx"].tolist())

    # Re-apply the first brush as the "current" selection to describe.
    gp.selected_records = json.dumps(idx)
    sel = gp.selection

    hr("selection")
    print(repr(sel))

    hr("selection.summary()")
    print(sel.summary())

    hr("selection.predicate")
    print(repr(sel.predicate))

    hr("operationalizations")
    print("to_pandas()      :", sel.to_pandas())
    print("to_sql_where()   :", sel.to_sql_where())
    print("to_altair_filter():", json.dumps(sel.to_altair_filter(), indent=2))

    # Sanity: the pandas predicate reproduces the selection from the population.
    roundtrip = df.query(sel.to_pandas())
    print(f"\nround-trip check: df.query(to_pandas()) -> {len(roundtrip)} rows "
          f"vs selection {len(sel.dataframe)} rows")

    hr('selection.describe_distribution("QUEUED_WAIT_SECONDS")  [numeric]')
    print(repr(sel.describe_distribution("QUEUED_WAIT_SECONDS")))

    hr('selection.describe_distribution("queue")  [categorical]')
    # Same method dispatches on semantic type: categorical columns get per-value
    # share, lift vs. the population, and a concentration read.
    print(repr(sel.describe_distribution("queue")))

    hr("selection.history")
    for s in sel.history:
        print(f"  [{s.history_index}] {s!r}")

    hr("mentor.suggest_tests(selection, focus='QUEUED_WAIT_SECONDS')")
    for i, s in enumerate(mentor.suggest_tests(sel, focus="QUEUED_WAIT_SECONDS"), 1):
        print(f"\n{i}. {s!r}")

    hr("mentor.build_prompt(...)  [the LLM seam — string only, no API call]")
    print(mentor.build_prompt(sel, focus="why are these alpha/long jobs slow?"))


if __name__ == "__main__":
    main()

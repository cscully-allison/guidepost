"""
mentor — LLM-guided visual statistical test suggestions (proof-of-concept scaffold).

The premise: once a selection is a first-class object carrying a *predicate* and
rich *distribution* descriptions, we can suggest the statistical tests and
visualizations an analyst should run next, guided by the focus of their inquiry.

This module is the scaffold for that extension. `suggest_tests` is a **working
rule-based stub** — it inspects `selection.predicate` and per-variable
distributions (selection vs. population) and proposes concrete tests with
rationale, a recommended visualization, and runnable code. No LLM is called.

`build_prompt` shows exactly where a real LLM would plug in: it assembles the
predicate + distribution context into a prompt string. Wiring it to the Claude API
(the `anthropic` SDK, model `claude-opus-4-8`) is the next step and is sketched in
that function's docstring.
"""

from __future__ import annotations

from typing import Optional

from pandas.api import types as ptypes


class TestSuggestion:
    """One suggested next step: a statistical test + how to see it.

    Attributes
    ----------
    name : str            Short human title, e.g. "Compare QUEUED_WAIT: selection vs. rest".
    stat_test : str       The statistical test to run, e.g. "Mann-Whitney U".
    variables : list[str] Columns involved.
    viz : str             Recommended visualization, e.g. "ecdf", "violin", "scatter".
    rationale : str       Why this test, grounded in the selection's predicate/distribution.
    code : str            A runnable snippet (scipy / pandas) to execute the test.
    """

    def __init__(self, name, stat_test, variables, viz, rationale, code):
        self.name = name
        self.stat_test = stat_test
        self.variables = list(variables)
        self.viz = viz
        self.rationale = rationale
        self.code = code

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "stat_test": self.stat_test,
            "variables": self.variables,
            "viz": self.viz,
            "rationale": self.rationale,
            "code": self.code,
        }

    def __repr__(self) -> str:
        return (
            f"▸ {self.name}\n"
            f"    test : {self.stat_test}   |   viz: {self.viz}   |   vars: {', '.join(self.variables)}\n"
            f"    why  : {self.rationale}\n"
            f"    code : {self.code}"
        )


# Thresholds for the heuristics below. Deliberately loose — this is a POC whose
# job is to surface *plausible* next steps, not to gatekeep.
_SHIFT_SIGMA = 0.35      # |mean shift| in population σ that counts as "shifted"
_STRONG_SKEW = 0.75      # |skew| above which we prefer non-parametric tests


def _measure_columns(selection):
    """Numeric *measure* columns worth analyzing. Uses the widget's semantic types
    so identifiers (job_id), booleans, and other non-measures the raw dtype would
    call numeric are excluded — on a wide table that's the difference between
    useful output and dozens of 'Compare job_id' lines. Falls back to dtype when
    summary stats are absent (e.g. bare unit tests)."""
    pop = selection._population_df
    summary = getattr(selection._widget, "_summary_stats", {}) or {}
    cols = []
    for c in pop.columns:
        info = summary.get(c)
        if info is not None:
            ok = (info.get("semantic_type") in ("continuous", "ordinal")
                  and not info.get("is_list"))
        else:
            ok = ptypes.is_numeric_dtype(pop[c].dtype)
        if ok:
            cols.append(c)
    return cols


def suggest_tests(selection, focus: Optional[str] = None, max_suggestions: int = 6):
    """Suggest statistical tests for a selection (rule-based POC).

    Parameters
    ----------
    selection : guidepost.selection.Selection
        The selection to analyze. Its `.predicate` and `.describe_distribution`
        drive the heuristics.
    focus : str, optional
        A column name the analyst is focused on. When given, its comparison is
        surfaced first. (In the LLM-backed version this becomes free-text intent.)
    max_suggestions : int
        Cap on how many suggestions to return — wide tables can otherwise yield
        one per column. Suggestions are ranked by effect size, so the cap keeps
        the most informative ones.

    Returns
    -------
    list[TestSuggestion]
    """
    pred = selection.predicate
    pop = selection._population_df  # population frame (no gp_idx)
    sel_df = selection.dataframe
    summary = getattr(selection._widget, "_summary_stats", {}) or {}
    list_cols = {c for c, info in summary.items() if info.get("is_list")}

    numeric_cols = [c for c in _measure_columns(selection) if c in sel_df.columns]
    constrained_numeric = [c.column for c in pred.clauses if c.kind == "numeric"]
    constrained_categorical = [c.column for c in pred.clauses if c.kind == "categorical"]

    # Cache one distribution report per measure; effect size = |median/mean shift|.
    reps = {}
    for c in numeric_cols:
        try:
            reps[c] = selection.describe_distribution(c)
        except Exception:
            pass

    def _effect(c):
        return abs(reps[c].get("shift_in_sigma") or 0.0) if c in reps else 0.0

    # Suggestions are collected into per-type buckets and then assembled with a
    # diversity guarantee, so a wide table full of shifted numerics can't crowd
    # out the (single) categorical or correlation test.
    vs_rest_suggestions, group_suggestions = [], []
    corr_suggestions, chi_suggestions, fallback = [], [], []

    # (1) Selection vs. rest — the canonical move, applied to *every* measure,
    # including the ones that define the selection (brushing the high tail then
    # confirming it really is higher is exactly the point). Keep a column if it's
    # the focus, a defining variable, or meaningfully shifted; then rank by effect
    # size (focus and defining variables first).
    vs_rest = [c for c in numeric_cols
               if c in reps and (c == focus or c in constrained_numeric
                                 or _effect(c) >= _SHIFT_SIGMA)]
    vs_rest.sort(key=lambda c: (c != focus, c not in constrained_numeric, -_effect(c)))
    for col in vs_rest:
        vs_rest_suggestions.append(_vs_rest_suggestion(
            col, reps[col], is_defining=col in constrained_numeric))

    # Highest-effect free (non-defining) measure — the natural response variable
    # for a group comparison. Prefer the focus when it qualifies.
    free_measures = sorted((c for c in numeric_cols if c not in constrained_numeric
                            and c in reps), key=lambda c: -_effect(c))
    if focus in free_measures:
        free_measures = [focus] + [c for c in free_measures if c != focus]
    response = free_measures[0] if free_measures else None

    # (2) A categorical with ≥2 groups *present in the selection* + that response →
    # group comparison. A clause pinned to a single value has nothing to compare
    # across (the degenerate case), so it's skipped. List columns can't be group
    # keys (unhashable cells), so they're excluded via the is_list flag.
    if response is not None:
        group_cats = [c for c in pop.columns
                      if not ptypes.is_numeric_dtype(pop[c].dtype)
                      and c not in list_cols and c in sel_df.columns
                      and sel_df[c].nunique(dropna=True) >= 2]
        # Prefer a categorical the selection is constrained on (a pointed cut).
        group_cats.sort(key=lambda c: (c not in constrained_categorical, c))
        if group_cats:
            cat = group_cats[0]
            n_groups = int(sel_df[cat].nunique(dropna=True))
            group_suggestions.append(TestSuggestion(
                name=f"Does {response} differ across {cat} groups within the selection?",
                stat_test="Kruskal-Wallis H-test",
                variables=[cat, response],
                viz="grouped box / violin",
                rationale=(
                    f"Within the selection, '{cat}' still splits into {n_groups} groups. Compare "
                    f"the '{response}' distribution across them to see whether the grouping — not "
                    f"just the brush — drives the effect."
                ),
                code=(
                    f"from scipy.stats import kruskal\n"
                    f"g = selection.dataframe.groupby('{cat}')['{response}']\n"
                    f"kruskal(*[v.dropna().values for _, v in g])"
                ),
            ))

    # (3) Two or more co-constrained measures → test their association. Pick the
    # two with the largest effect so the pair is the most interesting one.
    if len(constrained_numeric) >= 2:
        a, b = sorted(constrained_numeric, key=lambda c: -_effect(c))[:2]
        corr_suggestions.append(TestSuggestion(
            name=f"Is {a} associated with {b} inside the selection?",
            stat_test="Spearman rank correlation",
            variables=[a, b],
            viz="scatter + trend",
            rationale=(
                f"The selection jointly constrains {a} and {b}. A rank correlation checks whether "
                f"they co-vary within the selected region (robust to the skew typical of HPC metrics)."
            ),
            code=(
                f"from scipy.stats import spearmanr\n"
                f"d = selection.dataframe[['{a}', '{b}']].dropna()\n"
                f"spearmanr(d['{a}'], d['{b}'])"
            ),
        ))

    # (4) A categorical the selection concentrates on → test that membership
    # association. Scan the low-cardinality categoricals (constrained ones first)
    # and pick the one with the strongest over-representation; a chi-square test
    # of independence then asks whether that category split is real vs. the rest.
    cat_candidates = list(dict.fromkeys(
        constrained_categorical
        + [c for c in pop.columns
           if c not in list_cols and not ptypes.is_numeric_dtype(pop[c].dtype)
           and c in sel_df.columns and 2 <= sel_df[c].nunique(dropna=True) <= 25]))
    best = None
    for cat in cat_candidates:
        try:
            rep = selection.describe_distribution(cat)
        except Exception:
            continue
        if getattr(rep, "kind", None) != "categorical" or not rep.get("over_represented"):
            continue
        top = rep["over_represented"][0]
        if best is None or top["lift"] > best[1]["lift"]:
            best = (cat, top)
    if best:
        cat, top = best
        chi_suggestions.append(TestSuggestion(
            name=f"Is {cat} membership associated with the selection?",
            stat_test="Chi-square test of independence (selection vs. rest)",
            variables=[cat],
            viz="mosaic / grouped bar",
            rationale=(
                f"'{cat}={top['value']}' is {top['lift']:.1f}× over-represented in the selection "
                f"({top['sel_share']*100:.0f}% vs {top['pop_share']*100:.0f}% of the population). "
                f"A chi-square test checks whether the {cat} split genuinely differs from the rest."
            ),
            code=(
                "import pandas as pd\n"
                "from scipy.stats import chi2_contingency\n"
                "in_sel = population['gp_idx'].isin(selection.selected_idx)\n"
                f"table = pd.crosstab(in_sel, population['{cat}'])\n"
                "chi2_contingency(table)"
            ),
        ))

    # Assemble with a diversity guarantee: lead with the strongest numeric test,
    # then give the categorical, group, and correlation tests a reserved slot each
    # (when they exist) before filling the rest with more numeric comparisons — so
    # a table full of shifted measures can't shut out the other test types.
    suggestions = []
    if vs_rest_suggestions:
        suggestions.append(vs_rest_suggestions[0])
    for bucket in (chi_suggestions, group_suggestions, corr_suggestions):
        if bucket:
            suggestions.append(bucket[0])
    for s in vs_rest_suggestions[1:]:
        suggestions.append(s)

    # Fallback: nothing jumped out — suggest an overall shape check on the focus
    # (or first measure) so the analyst always gets a next step.
    if not suggestions and (focus in reps or numeric_cols):
        col = focus if focus in reps else numeric_cols[0]
        suggestions.append(TestSuggestion(
            name=f"Characterize {col} in the selection",
            stat_test="Kolmogorov-Smirnov (selection vs. population)",
            variables=[col],
            viz="ecdf overlay",
            rationale=(
                f"No single dimension stood out, so start by checking whether {col}'s overall "
                f"distribution in the selection departs from the population."
            ),
            code=(
                f"from scipy.stats import ks_2samp\n"
                f"sel = selection.dataframe['{col}']\n"
                f"rest = population.loc[~population['gp_idx'].isin(selection.selected_idx), '{col}']\n"
                f"ks_2samp(sel.dropna(), rest.dropna())"
            ),
        ))

    return suggestions[:max_suggestions]


def _vs_rest_suggestion(col, rep, is_defining):
    """Build a 'selection vs. rest of population' test suggestion for one measure,
    choosing a non-parametric or parametric test based on the distribution shape."""
    shift = rep.get("shift_in_sigma") or 0.0
    non_normal = "non-normal" in rep["normality_hint"] or abs(rep["skew"]) >= _STRONG_SKEW
    if non_normal:
        test, viz, fn = "Mann-Whitney U (two-sided)", "ecdf", "mannwhitneyu"
        call = f"{fn}(sel.dropna(), rest.dropna(), alternative='two-sided')"
        imp = "mannwhitneyu"
    else:
        test, viz, imp = "Welch's t-test", "violin", "ttest_ind"
        call = "ttest_ind(sel.dropna(), rest.dropna(), equal_var=False)"
    direction = "higher" if shift > 0 else "lower"
    ratio = rep.get("median_ratio")
    ratio_txt = f"median {ratio:.2f}× population; " if ratio else ""
    defining_txt = (
        "This variable defines the selection, so confirm the separation from the rest "
        "is statistically real (not just where you happened to brush). "
        if is_defining else ""
    )
    return TestSuggestion(
        name=f"Compare {col}: selection vs. rest of population",
        stat_test=test,
        variables=[col],
        viz=viz,
        rationale=(
            f"{defining_txt}The selection's {col} sits {abs(shift):.2f}σ {direction} than "
            f"the population ({ratio_txt}{rep['normality_hint']})."
        ),
        code=(
            f"from scipy.stats import {imp}\n"
            f"sel = selection.dataframe['{col}']\n"
            f"rest = population.loc[~population['gp_idx'].isin(selection.selected_idx), '{col}']\n"
            f"{call}"
        ),
    )


def build_prompt(selection, focus: Optional[str] = None) -> str:
    """Assemble the context prompt for the Claude-backed suggester.

    Serializes the selection's predicate + per-variable distribution context
    (selection vs. population) plus the analyst's focus into a prompt string. Used
    as the user message by :func:`suggest_tests_llm`; also useful to inspect on its
    own (`print(mentor.build_prompt(sel, focus))`). Does not call any model.
    """
    pred = selection.predicate
    pop = selection._population_df
    numeric_cols = _measure_columns(selection)
    constrained_categorical = [c.column for c in pred.clauses if c.kind == "categorical"]

    lines = [
        f"SELECTION SIZE: {len(selection)} of {len(pop)} records "
        f"({100.0 * len(selection) / max(len(pop), 1):.1f}% of population).",
        "",
        "PREDICATE (what defines the selection):",
        pred.describe(),
        "",
        "NUMERIC DISTRIBUTIONS (selection vs. population):",
    ]
    for col in numeric_cols:
        try:
            rep = selection.describe_distribution(col)
        except Exception:
            continue
        lines.append(
            f"  - {col}: n={rep['n']}, median {rep['median']:.4g} "
            f"(pop {rep['population_median']:.4g}), shift {rep['shift_in_sigma']:.2f}σ, "
            f"skew {rep['skew']:.2f}, {rep['normality_hint']}"
        )

    # Categorical structure for the columns the selection is constrained on —
    # gives the model the over-representation (lift) signal, not just the clause.
    cat_lines = []
    for col in constrained_categorical:
        try:
            rep = selection.describe_distribution(col)
        except Exception:
            continue
        top = ", ".join(
            f"{r['value']} ({r['lift']:.1f}× at {r['sel_share']*100:.0f}%)"
            for r in rep.get("over_represented", [])[:3])
        if top:
            cat_lines.append(f"  - {col}: over-represented → {top}")
    if cat_lines:
        lines += ["", "CATEGORICAL STRUCTURE (over-representation vs. population):", *cat_lines]

    if focus:
        lines += ["", f"ANALYST FOCUS: {focus}"]
    return "\n".join(lines)


# System prompt for the LLM-guided suggester — states the role and the shape of a
# good suggestion. Formatting is enforced by the structured-output schema, so this
# only needs to convey substance, not layout.
_MENTOR_SYSTEM = (
    "You are a statistical-analysis mentor embedded in an HPC (high-performance "
    "computing) job-data exploration tool. An analyst has brushed a subset of jobs; "
    "you are given the predicate that defines that selection and per-variable "
    "distribution summaries comparing the selection to the full population.\n\n"
    "Suggest the most informative *visual statistical tests* to run next, ranked by "
    "how much they would illuminate what makes this selection distinct. For each: name "
    "the statistical test, the variables involved, a concrete visualization, a "
    "one-sentence rationale grounded in the provided numbers (cite the shift, lift, or "
    "skew you are reacting to), and a short runnable Python snippet using scipy/pandas. "
    "Assume the snippet runs with a `selection` object (having `.dataframe` and "
    "`.selected_idx`) and a `population` DataFrame (with a `gp_idx` column) in scope.\n\n"
    "Prefer non-parametric tests (Mann-Whitney U, Kruskal-Wallis, Spearman, "
    "chi-square) for the skewed, heavy-tailed distributions typical of HPC metrics; "
    "use parametric tests only when a variable looks roughly normal. Focus on the "
    "analyst's stated focus when one is given. Do not restate the predicate back; "
    "propose next steps."
)


def suggest_tests_llm(selection, focus: Optional[str] = None, *,
                      model: str = "claude-opus-4-8", client=None, api_key=None,
                      max_tokens: int = 16000, max_suggestions: int = 5,
                      fallback_to_rules: bool = True):
    """LLM-guided test suggestions via the Claude API.

    Sends the selection's predicate + distribution context (from
    :func:`build_prompt`) to Claude and parses a structured list of
    :class:`TestSuggestion` back. This is the LLM-backed counterpart to the
    rule-based :func:`suggest_tests`.

    Parameters
    ----------
    selection : guidepost.selection.Selection
    focus : str, optional
        Free-text or column-name focus for the analyst's inquiry.
    model : str
        Claude model id. Defaults to ``claude-opus-4-8``.
    client : anthropic.Anthropic, optional
        Reuse an existing client; otherwise one is constructed (reads
        ``ANTHROPIC_API_KEY`` from the environment).
    api_key : str, optional
        Passed to a freshly constructed client when ``client`` is not given.
    max_tokens : int
        Response cap. 16000 is ample for a handful of suggestions with adaptive
        thinking, and stays under the SDK's non-streaming timeout guard.
    max_suggestions : int
        Requested number of suggestions.
    fallback_to_rules : bool
        On a missing SDK, missing key, API error, or a safety refusal, fall back
        to :func:`suggest_tests` (printing a short note) instead of raising. Set
        ``False`` to surface the error.

    Returns
    -------
    list[TestSuggestion]
    """
    def _fallback(reason):
        if not fallback_to_rules:
            raise reason if isinstance(reason, Exception) else RuntimeError(reason)
        print(f"[mentor] {reason}; using rule-based suggest_tests() instead.")
        return suggest_tests(selection, focus=focus, max_suggestions=max_suggestions)

    try:
        import anthropic
        from pydantic import BaseModel
    except ImportError as e:
        return _fallback(f"anthropic SDK not installed (`pip install anthropic`) [{e}]")

    # Structured-output schema — the model is constrained to return exactly this
    # shape, so parsing is validation-free.
    class _LLMSuggestion(BaseModel):
        name: str
        stat_test: str
        variables: list[str]
        viz: str
        rationale: str
        code: str

    class _LLMResponse(BaseModel):
        suggestions: list[_LLMSuggestion]

    try:
        client = client or anthropic.Anthropic(api_key=api_key)
    except Exception as e:  # e.g. missing ANTHROPIC_API_KEY
        return _fallback(f"could not construct Anthropic client ({type(e).__name__}: {e})")

    user_prompt = (
        build_prompt(selection, focus)
        + f"\n\nReturn up to {max_suggestions} suggestions, most informative first."
    )
    try:
        response = client.messages.parse(
            model=model,
            max_tokens=max_tokens,
            thinking={"type": "adaptive"},  # statistical reasoning benefits from it
            system=_MENTOR_SYSTEM,
            messages=[{"role": "user", "content": user_prompt}],
            output_format=_LLMResponse,
        )
    except Exception as e:
        return _fallback(f"Claude API call failed ({type(e).__name__}: {e})")

    if getattr(response, "stop_reason", None) == "refusal":
        return _fallback("Claude declined the request (safety refusal)")
    parsed = getattr(response, "parsed_output", None)
    if parsed is None:
        return _fallback("Claude returned no structured output")

    return [
        TestSuggestion(
            name=s.name, stat_test=s.stat_test, variables=list(s.variables),
            viz=s.viz, rationale=s.rationale, code=s.code,
        )
        for s in parsed.suggestions
    ][:max_suggestions]

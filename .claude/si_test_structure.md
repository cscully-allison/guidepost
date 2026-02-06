# Guidance on semantic invariance tests

# Table of invariants and means to extract them from different outputs from our AI pipeline

Here follows a table of elements (canoncial fields) in any hypothesis specification that we want to test as semantic invariants:

| Canonical Field Evaluated   | Definition (Semantic Invariant)                                                                          | NL Extractor                                                         | IR Extractor                                      | Artifact Extractor                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| event.comparator            | Directional relation defining the hypothesis (>, <, =, etc.)                                             | Comparator cue extraction ( e.g. “greater than”, “difference”, “non-zero”) | Comparator token in event                         | Visual polarity: annotation / shading                              |
| event.reference             | Reference or threshold value defining the event boundary                                                 | Explicit numeric / symbolic reference in NL (e.g., “0”, “baseline”)  | Reference node in event                           | Reference line, annotation, or implicit null                       |
| event.form                  | What kind of claim is being made about the quantity (comparison, conditional comparison, underspecified) | Hypothesis structure cues (e.g. “overall”, “by group”, “differs across”)  | Event structure (simple, conditioned, ill-formed) | Faceting / grouping / multi-panel structure                        |
| quantity.signature          | What kind of quantity is being evaluated (level, contrast, trend, association)                           | Lexical + syntactic cues (e.g. “difference”, “slope”, “correlation”)      | Quantity/estimand type                            | Depicted quantity: declared or parsed from code                    |
| quantity.conditioning       | Explicit predicates restricting the hypothesis domain                                                    | examples: “for X”, “among Y”, subgroup language                                | Predicate attachment to event/estimand            | Encodings represent conditions                                     |
| quantity.estimand_shape     | Algebraic structure of the estimand (difference, ratio, nested contrast)                                 | Algebraic cues (e.g. “A − B”, “ratio”, “percent change”)                  | Estimand operator tree                            | Visual composition (difference plot, ratio axis)                   |
| quantity.uncertainty_shown  | Whether the quantity is treated as a point or a distribution                                             | Language cues: e.g. “uncertainty”, “CI”, “probability”, “distribution”    | Distribution node utilized                        | Mark type: Error bars, bands, densities (controlled with contract) |
| quantity.uncertainty_target | What object uncertainty is attached to (quantity vs other components)                                    | Language cues: e.g. “uncertainty of the effect/difference”                | Uncertainty attachment in IR                      | Uncertainty mark encodes what quantity?                            |


Each "extractor" column provides guidance on what indicators of a particular field may be extractable and testable from a specific represeentation of the hypotheis. The first column is a natural language expression of the hypothesis. The second column is a structured representation (Intermediate Representation (IR)) of the same hypothesis represented as an AST produced from the grammar and parser in campsite_lib. In the third column, the "artifact" is a visualization specification that will be created from the structured IR that describes the hypothesis. The visualization specification will confrm to vega-lite syntax.

# Testing Architecture

Well formed tests for these elements should first validate that the relevant indicator of the canconcial field exists on each representation. After that it should make pairwise checks between each successive representation that evaluates if the canonical field remained the same.

Each test should report back a violation object that reports a typed violation informative of what canonical field failed to maintain semantic invariance. It should also indicate if a test failed a pariwise check between two representations or failed due to some other issue. Violations of pairwise checks should also report what the expected and observed values are.

For simplicity, you may add code that calls out to the llm (in the utils.py file) to extract relevant cues from Natural Language representations of hypotheses that can be compared against other representaions of the hypothesis.
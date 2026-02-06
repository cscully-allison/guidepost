"""Semantic Invariant Checkers for hypothesis validation.

Organized around 8 canonical fields that must be preserved across
three representations: NL (Natural Language), IR (Intermediate Representation),
and Artifact (vega-lite visualization specification).

Each field checker extracts its canonical field from each representation,
validates existence, and performs pairwise checks between successive
representations (NL→IR, IR→Artifact).
"""

import asyncio
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from .utils import llm, log
from .ir_ast import VALID_COMPARATORS


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class ViolationType(str, Enum):
    """Types of semantic violations."""

    MISSING_IN_NL = "missing_in_nl"
    MISSING_IN_IR = "missing_in_ir"
    MISSING_IN_ARTIFACT = "missing_in_artifact"
    NL_IR_MISMATCH = "nl_ir_mismatch"
    IR_ARTIFACT_MISMATCH = "ir_artifact_mismatch"
    MALFORMED = "malformed"


class Criticality(str, Enum):
    """Criticality levels for violations."""

    WARN = "warn"
    FAIL = "fail"


# Representation mapping constants
NLIR = "NL->IR"
IRARTIFACT = "IR->Artifact"
NLARTIFACT = "NL->Artifact"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Violation:
    """Represents a semantic invariant violation."""

    invariantID: str
    violationType: ViolationType
    message: str
    criticality: Criticality
    expected: Optional[Any] = None
    observed: Any = None

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "invariantID": self.invariantID,
            "violationType": self.violationType.value,
            "message": self.message,
            "criticality": self.criticality.value,
            "expected": self.expected,
            "observed": self.observed,
        }


@dataclass
class ExtractedValue:
    """Result of extracting a canonical field from a representation."""

    value: Any = None
    exists: bool = False
    confidence: float = 1.0
    metadata: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_VIOLATION_TYPE_MAP = {
    "NL": ViolationType.MISSING_IN_NL,
    "IR": ViolationType.MISSING_IN_IR,
    "ART": ViolationType.MISSING_IN_ARTIFACT,
}

_PAIRWISE_VIOLATION_TYPE_MAP = {
    "PW-NLIR": ViolationType.NL_IR_MISMATCH,
    "PW-IRART": ViolationType.IR_ARTIFACT_MISMATCH,
}


def _dataclass_to_dict(obj) -> dict:
    """Convert dataclass to dictionary recursively."""
    if hasattr(obj, "__dataclass_fields__"):
        result = {}
        for field_name in obj.__dataclass_fields__:
            value = getattr(obj, field_name)
            result[field_name] = _dataclass_to_dict(value)
        return result
    elif isinstance(obj, list):
        return [_dataclass_to_dict(item) for item in obj]
    elif isinstance(obj, tuple):
        return list(obj)
    else:
        return obj


def _ensure_dict(ir: Any) -> dict:
    """Ensure IR is a plain dict (convert from dataclass if needed)."""
    if ir is None:
        return {}
    if hasattr(ir, "to_dict"):
        return ir.to_dict()
    if hasattr(ir, "__dataclass_fields__"):
        return _dataclass_to_dict(ir)
    return ir


def _collect_predicates(node: dict) -> list[dict]:
    """Walk a quantity subtree and collect all predicates as flat dicts."""
    predicates = []
    if not isinstance(node, dict):
        return predicates

    # Direct predicate on this node
    pred = node.get("predicate")
    if pred and isinstance(pred, dict):
        predicates.extend(_flatten_predicate(pred))

    # recur into the quantity
    quantity = node.get("quantity")
    if isinstance(quantity, dict):
        predicates.extend(_collect_predicates(quantity))
    
    # recur into the quantity
    referent = node.get("referent")
    if isinstance(referent, dict):
        predicates.extend(_collect_predicates(referent))

    # Recurse into estimand (for rv nodes)
    estimand = node.get("estimand")
    if isinstance(estimand, dict):
        predicates.extend(_collect_predicates(estimand))

    # Recurse into lhs/rhs (for contrast nodes)
    for side in ("lhs", "rhs"):
        child = node.get(side)
        if isinstance(child, dict):
            predicates.extend(_collect_predicates(child))

    return predicates


def _flatten_predicate(pred: dict) -> list[dict]:
    """Flatten a possibly-conjunctive predicate into a list of simple predicates."""
    if pred.get("kind") == "conjunction":
        parts = []
        if pred.get("lhs"):
            parts.extend(_flatten_predicate(pred["lhs"]))
        if pred.get("rhs"):
            parts.extend(_flatten_predicate(pred["rhs"]))
        return parts
    return [{"attr": pred.get("attr"), "comparator": pred.get("comparator"), "value": pred.get("value")}]


def _has_conditioning(quantity: dict) -> bool:
    """Check if a quantity subtree has any predicates."""
    return len(_collect_predicates(quantity)) > 0


# ---------------------------------------------------------------------------
# Base class
# ---------------------------------------------------------------------------

class CanonicalFieldChecker(ABC):
    """Base class for canonical field semantic invariant checkers.

    Each subclass checks one canonical field across NL, IR, and Artifact
    representations.
    """

    field_id: str = ""
    required_in: list[str] = []  # Which representations MUST contain this field
    nl_prompt_template: str = ""  # LLM prompt template for NL extraction

    def __init__(self):
        self._nl_override: Optional[ExtractedValue] = None

    # -- Override support for NL extraction (testing without LLM) --

    def set_nl_override(self, value: ExtractedValue):
        """Set an override value for NL extraction, bypassing LLM calls."""
        self._nl_override = value

    def clear_nl_override(self):
        """Remove the NL override."""
        self._nl_override = None

    # -- Extractors --

    def extract_from_nl(self, nl: str) -> ExtractedValue:
        """Extract this canonical field from a natural language hypothesis.

        Uses the LLM by default, but returns the override if set.
        Normalization is applied in both paths for consistency.
        """
        if self._nl_override is not None:
            normalized = self._normalize_nl_value(self._nl_override.value)
            return ExtractedValue(
                value=normalized,
                exists=self._nl_override.exists,
                confidence=self._nl_override.confidence,
                metadata=self._nl_override.metadata,
            )
        if not nl:
            return ExtractedValue(value=None, exists=False)
        return self._extract_from_nl_llm(nl)

    def _extract_from_nl_llm(self, nl: str) -> ExtractedValue:
        """Call the LLM to extract the canonical field from NL.

        Override in subclasses to provide field-specific prompts.
        Falls back to a no-op if LLM is unavailable.
        """
        if not self.nl_prompt_template:
            return ExtractedValue(value=None, exists=False)

        prompt = self.nl_prompt_template.format(nl=nl)
        try:
            response = llm.invoke(prompt)
            resp = json.loads(response.content)
            print(self.field_id, f":{resp}" )
            raw_value = resp.get("value")
            normalized = self._normalize_nl_value(raw_value)
            print(normalized)
            return ExtractedValue(
                value=normalized,
                exists=normalized is not None,
                confidence=resp.get("confidence", 0.8),
                metadata=resp,
            )
        except Exception as e:
            log(f"NL extraction failed for {self.field_id}: {e}\n")
            return ExtractedValue(value=None, exists=False)

    def _normalize_nl_value(self, raw_value: Any) -> Any:
        """Normalize a raw NL-extracted value to canonical form.

        Override in subclasses to map LLM phrasings to the canonical vocabulary
        used by IR extraction.
        """
        return raw_value

    @abstractmethod
    def extract_from_ir(self, ir: dict) -> ExtractedValue:
        """Extract this canonical field from the IR dict. Must be implemented."""
        ...

    def extract_from_artifact(self, artifact: dict) -> ExtractedValue:
        """Extract this canonical field from a vega-lite artifact spec.

        Stub — returns not-found. Override when artifact extraction is implemented.
        """
        # TODO: Implement artifact extraction for this canonical field
        return ExtractedValue(value=None, exists=False)

    # -- Checks --

    def check_existence(self, representation: str, extracted: ExtractedValue) -> Optional[Violation]:
        """Check whether the canonical field exists in the given representation."""
        if representation not in self.required_in:
            return None
        if not extracted.exists:
            return Violation(
                invariantID=f"{self.field_id}-EX-{representation}",
                violationType=_VIOLATION_TYPE_MAP.get(representation, ViolationType.MALFORMED),
                message=f"Canonical field '{self.field_id}' not found in {representation}",
                criticality=Criticality.WARN,
                expected="present",
                observed=extracted.value,
            )
        return None

    def check_pairwise(
        self,
        source: ExtractedValue,
        target: ExtractedValue,
        pair_label: str,
    ) -> Optional[Violation]:
        """Compare the canonical field between two representations.

        Default implementation does equality comparison.
        Subclasses can override for fuzzy / semantic matching.
        """
        if not source.exists or not target.exists:
            return None  # Can't compare if one side is missing

        if not self._values_match(source.value, target.value):
            return Violation(
                invariantID=f"{self.field_id}-{pair_label}",
                violationType=_PAIRWISE_VIOLATION_TYPE_MAP.get(
                    pair_label, ViolationType.NL_IR_MISMATCH
                ),
                message=f"Canonical field '{self.field_id}' differs between representations",
                criticality=Criticality.FAIL,
                expected=source.value,
                observed=target.value,
            )
        return None

    def _values_match(self, source_value: Any, target_value: Any) -> bool:
        """Compare two extracted values. Override for custom matching logic."""
        return source_value == target_value

    # -- Orchestrator --

    def check(
        self,
        nl: Optional[str] = None,
        ir: Any = None,
        artifact: Optional[dict] = None,
    ) -> list[Violation]:
        """Run all checks for this canonical field.

        1. Extract from each available representation
        2. Run existence checks
        3. Run pairwise checks between successive representations
        """
        violations = []
        ir_dict = _ensure_dict(ir)

        # Extract from each representation
        nl_val = self.extract_from_nl(nl) if nl else ExtractedValue()
        ir_val = self.extract_from_ir(ir_dict) if ir_dict else ExtractedValue()
        art_val = self.extract_from_artifact(artifact) if artifact else ExtractedValue()

        # Existence checks
        if nl:
            v = self.check_existence("NL", nl_val)
            if v:
                violations.append(v)

        if ir_dict:
            v = self.check_existence("IR", ir_val)
            if v:
                violations.append(v)

        if artifact:
            v = self.check_existence("ART", art_val)
            if v:
                violations.append(v)

        # Pairwise checks
        if nl and ir_dict:
            v = self.check_pairwise(nl_val, ir_val, "PW-NLIR")
            if v:
                violations.append(v)

        if ir_dict and artifact:
            v = self.check_pairwise(ir_val, art_val, "PW-IRART")
            if v:
                violations.append(v)

        return violations


# ---------------------------------------------------------------------------
# Concrete field checkers
# ---------------------------------------------------------------------------

class ComparatorChecker(CanonicalFieldChecker):
    """event.comparator — Directional relation defining the hypothesis."""

    field_id = "event.comparator"
    required_in = ["IR"]
    nl_prompt_template = (
        "You will be provided with a natural language hypothesis.\n"
        "Extract the comparator that describes the relationship between "
        "a quantity of interest and a reference value.\n"
        "Natural Language Hypothesis: {nl}\n\n"
        "Return a JSON object:\n"
        '{{"value": "<comparator symbol: >, <, =, >=, <=, !=, BETWEEN, or null>", '
        '"confidence": <0.0-1.0>, '
        '"rationale": "<short explanation>"}}'
    )

    _NL_ALIASES = {
        "greater than": ">", "more than": ">", "exceeds": ">", "above": ">",
        "less than": "<", "fewer than": "<", "below": "<", "under": "<",
        "equal to": "=", "equals": "=", "equal": "=",
        "at least": ">=", "greater than or equal to": ">=",
        "at most": "<=", "less than or equal to": "<=",
        "not equal": "!=", "not equal to": "!=", "differs from": "!=",
        "between": "BETWEEN",
    }

    def _normalize_nl_value(self, raw_value: Any) -> Any:
        if isinstance(raw_value, str):
            return self._NL_ALIASES.get(raw_value.lower().strip(), raw_value)
        return raw_value

    def extract_from_ir(self, ir: dict) -> ExtractedValue:
        comparator = ir.get("event", {}).get("comparator")
        exists = comparator is not None and comparator in VALID_COMPARATORS
        return ExtractedValue(value=comparator, exists=exists)


class ReferenceChecker(CanonicalFieldChecker):
    """event.reference — Reference or threshold value defining the event boundary."""

    field_id = "event.reference"
    required_in = ["IR"]
    nl_prompt_template = (
        "You will be provided with a natural language hypothesis.\n"
        "Extract the reference or threshold value that the quantity is being compared against.\n"
        "Natural Language Hypothesis: {nl}\n\n"
        "Return a JSON object:\n"
        '{{"value": "<the reference value: a number, string, or null if implicit>", '
        '"confidence": <0.0-1.0>, '
        '"rationale": "<short explanation>"}}'
    )

    _QUANTITY_TYPE_SYNONYMS = {
        "expectation": {"mean", "average", "expected value", "expected"},
        "contrast": {"difference", "comparison", "gap"},
    }

    def _values_match(self, source_value: Any, target_value: Any) -> bool:
        # Numeric coercion: both sides numeric or numeric-string
        try:
            return float(source_value) == float(target_value)
        except (TypeError, ValueError):
            pass

        # String identity (case-insensitive)
        if isinstance(source_value, str) and isinstance(target_value, str):
            return source_value.strip().lower() == target_value.strip().lower()

        # Quantity referent: one side is a dict (IR), other is a string (NL)
        dict_side, str_side = None, None
        if isinstance(source_value, dict) and isinstance(target_value, str):
            dict_side, str_side = source_value, target_value
        elif isinstance(target_value, dict) and isinstance(source_value, str):
            dict_side, str_side = target_value, source_value

        if dict_side and str_side and dict_side.get("type"):
            nl_lower = str_side.lower()
            # Check attr name appears in NL description
            attr = dict_side.get("attr", "")
            attr_match = attr and attr.lower() in nl_lower
            # Check type or synonym appears in NL description
            qtype = dict_side.get("type", "")
            synonyms = self._QUANTITY_TYPE_SYNONYMS.get(qtype, set())
            type_match = (
                qtype.lower() in nl_lower
                or any(syn in nl_lower for syn in synonyms)
            )
            return attr_match and type_match

        # Fallback: strict equality
        return source_value == target_value

    def extract_from_ir(self, ir: dict) -> ExtractedValue:
        referent = ir.get("event", {}).get("referent")
        if referent is None:
            return ExtractedValue(value=None, exists=False)
        if isinstance(referent, dict) and referent.get("type") == "unspecified":
            return ExtractedValue(
                value="unspecified", exists=True, metadata={"unspecified": True}
            )
        if isinstance(referent, dict):
            # Could be a const or a quantity-type referent (expectation, etc.)
            if referent.get("type") == "const":
                return ExtractedValue(value=referent.get("value"), exists=True)
            else:
                # Quantity referent (e.g., another expectation)
                return ExtractedValue(value=referent, exists=True)
        return ExtractedValue(value=referent, exists=True)


class EventFormChecker(CanonicalFieldChecker):
    """event.form — What kind of claim is being made (simple, conditioned, underspecified)."""

    field_id = "event.form"
    required_in = ["IR"]
    nl_prompt_template = (
        "You will be provided with a natural language hypothesis.\n"
        "Classify the form of the claim:\n"
        '- "simple" — a straightforward comparison (e.g., "X is greater than Y")\n'
        '- "conditioned" — involves subgroups or conditions (e.g., "for engineers", "among women")\n'
        '- "underspecified" — missing key components (e.g., no clear direction or reference)\n'
        "Natural Language Hypothesis: {nl}\n\n"
        "Return a JSON object:\n"
        '{{"value": "simple"|"conditioned"|"underspecified", '
        '"confidence": <0.0-1.0>, '
        '"rationale": "<short explanation>"}}'
    )

    _NL_ALIASES = {
        "conditional": "conditioned", "unconditional": "simple",
        "unclear": "underspecified", "incomplete": "underspecified",
        "marginal": "simple", "unconditoned": "simple",
    }

    def _normalize_nl_value(self, raw_value: Any) -> Any:
        if isinstance(raw_value, str):
            return self._NL_ALIASES.get(raw_value.lower().strip(), raw_value)
        return raw_value

    def extract_from_ir(self, ir: dict) -> ExtractedValue:
        event = ir.get("event", {})
        if not event:
            return ExtractedValue(value=None, exists=False)

        quantity = event.get("quantity", {}) or {}
        has_event_pred = event.get("predicate") is not None
        referent = event.get("referent") or {}
        has_unspecified = (
            event.get("comparator") == "\u16A6"
            or (isinstance(referent, dict) and referent.get("type") == "unspecified")
        )

        if has_unspecified:
            form = "underspecified"
        elif has_event_pred or _has_conditioning(quantity):
            form = "conditioned"
        else:
            form = "simple"

        return ExtractedValue(value=form, exists=True)


class QuantitySignatureChecker(CanonicalFieldChecker):
    """quantity.signature — What kind of quantity is being evaluated."""

    field_id = "quantity.signature"
    required_in = ["IR"]
    nl_prompt_template = (
        "You will be provided with a natural language hypothesis.\n"
        "Classify what kind of quantity is being evaluated:\n"
        '- "level" — a simple mean or aggregate (e.g., "the average salary")\n'
        '- "contrast" — a difference or comparison between groups (e.g., "difference in salary")\n'
        '- "distribution" — uncertainty or distributional claim (e.g., "CI for the mean")\n'
        '- "trend" — slope, change over time (e.g., "increasing trend")\n'
        '- "association" — correlation or relationship (e.g., "correlated with")\n'
        "Natural Language Hypothesis: {nl}\n\n"
        "Return a JSON object:\n"
        '{{"value": "level"|"contrast"|"distribution"|"trend"|"association", '
        '"confidence": <0.0-1.0>, '
        '"rationale": "<short explanation>"}}'
    )

    _SIGNATURE_MAP = {
        "expectation": "level",
        "contrast": "contrast",
        "rv": "distribution",
        "extract": "trend",
    }

    _NL_ALIASES = {
        "mean": "level", "average": "level", "aggregate": "level",
        "difference": "contrast", "comparison": "contrast", "gap": "contrast",
        "correlation": "association", "relationship": "association",
        "slope": "trend", "change": "trend",
        "uncertainty": "distribution", "ci": "distribution",
        "confidence interval": "distribution",
    }

    def _normalize_nl_value(self, raw_value: Any) -> Any:
        if isinstance(raw_value, str):
            return self._NL_ALIASES.get(raw_value.lower().strip(), raw_value)
        return raw_value

    def extract_from_ir(self, ir: dict) -> ExtractedValue:
        quantity = ir.get("event", {}).get("quantity", {}) or {}
        qtype = quantity.get("type")

        # Special case: func node with CORR → association
        if qtype == "func" and quantity.get("name") == "CORR":
            return ExtractedValue(value="association", exists=True)

        sig = self._SIGNATURE_MAP.get(qtype, "unknown")
        return ExtractedValue(value=sig, exists=(sig != "unknown"))


class ConditioningChecker(CanonicalFieldChecker):
    """quantity.conditioning — Explicit predicates restricting the hypothesis domain."""

    field_id = "quantity.conditioning"
    required_in = []  # Conditioning is optional
    nl_prompt_template = (
        "You will be provided with a natural language hypothesis.\n"
        "Extract any conditioning predicates — subgroup restrictions like "
        '"for engineers", "among women", "when X > 5".\n'
        "Natural Language Hypothesis: {nl}\n\n"
        "Return a JSON object:\n"
        '{{"value": [<list of condition descriptions, or empty list>], '
        '"confidence": <0.0-1.0>, '
        '"rationale": "<short explanation>"}}'
    )

    _JUDGE_PROMPT_TEMPLATE = (
        "You are comparing conditioning predicates from two representations "
        "of the same hypothesis.\n\n"
        "Natural language conditions:\n{nl_json}\n\n"
        "Structured IR predicates:\n{ir_json}\n\n"
        "For each NL condition, determine if there is a corresponding IR predicate "
        "that captures the same semantic intent — including the attribute being "
        "conditioned on, the direction of comparison, and the approximate value "
        "threshold.\n\n"
        "Return JSON:\n"
        '{{"match": true or false, "rationale": "<explanation>", '
        '"pairings": [{{"nl": "...", "ir": {{}}, "matches": true or false}}, ...]}}'
    )

    def __init__(self):
        super().__init__()
        self._judge_override: Optional[bool] = None

    def set_judge_override(self, result: bool):
        """Set an override for the LLM judge result, bypassing LLM calls in tests."""
        self._judge_override = result

    def clear_judge_override(self):
        """Remove the judge override."""
        self._judge_override = None

    def extract_from_ir(self, ir: dict) -> ExtractedValue:
        event = ir.get("event", {})
        predicates = _collect_predicates(event)

        return ExtractedValue(value=predicates, exists=len(predicates) > 0)

    def _values_match(self, source_value: Any, target_value: Any) -> bool:
        """Compare conditioning between NL and IR representations.

        Fast path for dict-vs-dict (attr name comparison).
        LLM judge for mixed types (NL strings vs IR dicts).
        """
        if not isinstance(source_value, list) or not isinstance(target_value, list):
            return source_value == target_value

        has_dicts = any(isinstance(p, dict) for p in source_value + target_value)
        has_strings = any(isinstance(p, str) for p in source_value + target_value)

        if has_dicts and not has_strings:
            # Both sides are dicts — fast deterministic comparison by attr names
            source_attrs = sorted(p.get("attr", "") for p in source_value if isinstance(p, dict))
            target_attrs = sorted(p.get("attr", "") for p in target_value if isinstance(p, dict))
            return source_attrs == target_attrs

        # Mixed types — quick count check before LLM
        if len(source_value) != len(target_value):
            return False

        return self._llm_judge_conditions(source_value, target_value)

    def _llm_judge_conditions(self, source: list, target: list) -> bool:
        """Use LLM to judge semantic equivalence of NL vs IR conditions."""
        if self._judge_override is not None:
            return self._judge_override

        # Determine which side is NL strings and which is IR dicts
        if any(isinstance(p, str) for p in source):
            nl_conditions, ir_predicates = source, target
        else:
            nl_conditions, ir_predicates = target, source

        prompt = self._JUDGE_PROMPT_TEMPLATE.format(
            nl_json=json.dumps(nl_conditions, indent=2),
            ir_json=json.dumps(ir_predicates, indent=2),
        )
        try:
            response = llm.invoke(prompt)
            resp = json.loads(response.content)
            return resp.get("match", False)
        except Exception as e:
            log(f"LLM judge failed for conditioning: {e}\n")
            return False


class EstimandShapeChecker(CanonicalFieldChecker):
    """quantity.estimand_shape — Algebraic structure of the estimand."""

    field_id = "quantity.estimand_shape"
    required_in = ["IR"]
    nl_prompt_template = (
        "You will be provided with a natural language hypothesis.\n"
        "Classify the algebraic structure of the quantity:\n"
        '- "simple" — a plain aggregate (e.g., "the average of X")\n'
        '- "difference" — a subtraction between groups (e.g., "A minus B")\n'
        '- "ratio" — a ratio between groups (e.g., "ratio of A to B")\n'
        '- "nested_difference" — difference with uncertainty wrapping\n'
        '- "nested_ratio" — ratio with uncertainty wrapping\n'
        "Natural Language Hypothesis: {nl}\n\n"
        "Return a JSON object:\n"
        '{{"value": "simple"|"difference"|"ratio"|"nested_difference"|"nested_ratio", '
        '"confidence": <0.0-1.0>, '
        '"rationale": "<short explanation>"}}'
    )

    _OP_SHAPE_MAP = {
        "-": "difference",
        "\u2212": "difference",  # −
        "/": "ratio",
        "+": "sum",
        "*": "product",
    }

    _NL_ALIASES = {
        "subtraction": "difference", "division": "ratio",
        "addition": "sum", "multiplication": "product",
    }

    def _normalize_nl_value(self, raw_value: Any) -> Any:
        if isinstance(raw_value, str):
            return self._NL_ALIASES.get(raw_value.lower().strip(), raw_value)
        return raw_value

    def extract_from_ir(self, ir: dict) -> ExtractedValue:
        quantity = ir.get("event", {}).get("quantity", {}) or {}
        qtype = quantity.get("type")

        if qtype == "expectation":
            return ExtractedValue(value="simple", exists=True)

        if qtype == "contrast":
            op = quantity.get("op", "-")
            shape = self._OP_SHAPE_MAP.get(op, "difference")
            return ExtractedValue(value=shape, exists=True)

        if qtype == "rv":
            estimand = quantity.get("estimand", {}) or {}
            if estimand.get("type") == "contrast":
                op = estimand.get("op", "-")
                inner = self._OP_SHAPE_MAP.get(op, "contrast")
                return ExtractedValue(value=f"nested_{inner}", exists=True)
            return ExtractedValue(value="simple", exists=True)

        return ExtractedValue(value="unknown", exists=False)


class UncertaintyShownChecker(CanonicalFieldChecker):
    """quantity.uncertainty_shown — Whether quantity is point or distribution."""

    field_id = "quantity.uncertainty_shown"
    required_in = ["IR"]
    nl_prompt_template = (
        "You will be provided with a natural language hypothesis.\n"
        "Determine whether the hypothesis treats the quantity as a fixed point "
        "or as a distribution with uncertainty.\n"
        'Look for cues like "CI", "confidence interval", "probability", '
        '"distribution", "uncertainty", "bootstrap".\n'
        "Natural Language Hypothesis: {nl}\n\n"
        "Return a JSON object:\n"
        '{{"value": "point"|"distribution", '
        '"confidence": <0.0-1.0>, '
        '"rationale": "<short explanation>"}}'
    )

    _NL_ALIASES = {
        "yes": "distribution", "no": "point", "none": "point",
        "confidence interval": "distribution", "ci": "distribution",
        "bootstrap": "distribution", "interval": "distribution",
    }

    def _normalize_nl_value(self, raw_value: Any) -> Any:
        if isinstance(raw_value, str):
            return self._NL_ALIASES.get(raw_value.lower().strip(), raw_value)
        return raw_value

    def extract_from_ir(self, ir: dict) -> ExtractedValue:
        quantity = ir.get("event", {}).get("quantity", {}) or {}
        is_rv = quantity.get("type") == "rv"
        return ExtractedValue(
            value="distribution" if is_rv else "point", exists=True
        )


class UncertaintyTargetChecker(CanonicalFieldChecker):
    """quantity.uncertainty_target — What object uncertainty is attached to."""

    field_id = "quantity.uncertainty_target"
    required_in = []  # Only relevant when uncertainty IS present
    nl_prompt_template = (
        "You will be provided with a natural language hypothesis.\n"
        "If the hypothesis mentions uncertainty, identify what the uncertainty "
        "is attached to (e.g., the mean, the difference, a ratio).\n"
        "If no uncertainty is mentioned, return null.\n"
        "Natural Language Hypothesis: {nl}\n\n"
        "Return a JSON object:\n"
        '{{"value": "<target of uncertainty or null>", '
        '"confidence": <0.0-1.0>, '
        '"rationale": "<short explanation>"}}'
    )

    _NL_ALIASES = {
        "the mean": "expectation", "mean": "expectation",
        "average": "expectation", "the average": "expectation",
        "expected value": "expectation",
        "the difference": "contrast", "difference": "contrast",
        "the ratio": "contrast",
    }

    def _normalize_nl_value(self, raw_value: Any) -> Any:
        if isinstance(raw_value, str):
            return self._NL_ALIASES.get(raw_value.lower().strip(), raw_value)
        return raw_value

    def extract_from_ir(self, ir: dict) -> ExtractedValue:
        quantity = ir.get("event", {}).get("quantity", {}) or {}
        if quantity.get("type") != "rv":
            return ExtractedValue(value=None, exists=False)
        estimand = quantity.get("estimand", {}) or {}
        target = estimand.get("type", "unknown")
        return ExtractedValue(value=target, exists=True)


# ---------------------------------------------------------------------------
# Runner / Orchestrator
# ---------------------------------------------------------------------------

class SICheckRunner:
    """Orchestrates all canonical field checks."""

    def __init__(self):
        self.checkers: list[CanonicalFieldChecker] = [
            ComparatorChecker(),
            ReferenceChecker(),
            EventFormChecker(),
            QuantitySignatureChecker(),
            ConditioningChecker(),
            EstimandShapeChecker(),
            UncertaintyShownChecker(),
            UncertaintyTargetChecker(),
        ]

    def run_all(
        self,
        nl: Optional[str] = None,
        ir: Any = None,
        artifact: Optional[dict] = None,
    ) -> list[Violation]:
        """Run all canonical field checks with the available representations."""
        violations = []
        for checker in self.checkers:
            violations.extend(checker.check(nl=nl, ir=ir, artifact=artifact))
        return violations

    def run_ir_only(self, ir: Any) -> list[Violation]:
        """Run checks using only the IR representation."""
        return self.run_all(ir=ir)

    def run_field(
        self,
        field_id: str,
        nl: Optional[str] = None,
        ir: Any = None,
        artifact: Optional[dict] = None,
    ) -> list[Violation]:
        """Run checks for a specific canonical field."""
        for checker in self.checkers:
            if checker.field_id == field_id:
                return checker.check(nl=nl, ir=ir, artifact=artifact)
        return []

    def get_checker(self, field_id: str) -> Optional[CanonicalFieldChecker]:
        """Get a specific checker by field ID."""
        for checker in self.checkers:
            if checker.field_id == field_id:
                return checker
        return None

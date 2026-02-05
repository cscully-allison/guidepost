"""Semantic Invariant Checkers for hypothesis validation."""

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional

from .utils import llm, log
from .ir_ast import VALID_COMPARATORS


class ViolationType(str, Enum):
    """Types of semantic violations."""

    MALFORMED_HYPOTHESIS = "malformed_hypothesis"
    INTENT_VIOLATION = "intent_violation"
    STRUCTURE_VIOLATION = "structure_violation"
    UNCERTAINTY_SEMANTICS_VIOLATION = "uncertainty_semantics_violation"
    CROSS_REPRESENTATION_VIOLATION = "cross_representation_violation"


class Criticality(str, Enum):
    """Criticality levels for violations."""

    WARN = "warn"
    FAIL = "fail"


# Representation mapping constants
NLARTIFACT = "NL->Artifact"
NLIR = "NL->IR"
IRARTIFACT = "IR->Artifact"


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


class Invariant(ABC):
    """Base class for semantic invariants."""

    def __init__(self, id: str, appliesTo: str):
        self.id = id
        self.appliesTo = appliesTo  # ["NL"], ["IR"], ["ARTIFACT"] or pairwise

    @abstractmethod
    def check(
        self,
        ir: Any = None,
        artifact: Any = None,
        nl: str = None,
    ) -> list[Violation]:
        """Check the invariant and return violations."""
        pass


class HypWellFormed(Invariant):
    """Check that hypothesis IR is well-formed."""

    VALID_COMPARATORS = list(VALID_COMPARATORS)

    def __init__(self, id: str, appliesTo: str):
        super().__init__(id, appliesTo)

    def _is_reference_incompatible(self, ir: dict) -> bool:
        """Check if reference value type is incompatible with quantity."""
        if not ir.get("event", {}).get("reference"):
            return True

        quantity = ir.get("event", {}).get("quantity", {})
        reference = ir.get("event", {}).get("reference", {})
        quantity_type = quantity.get("type")

        # If event is a contrast or expectation, reference should be a number
        if quantity_type in ("contrast", "expectation"):
            if not isinstance(reference.get("value"), (int, float)):
                return True

        # If quantity is an RV, reference should be a list/tuple (interval)
        if quantity_type == "rv":
            ref_value = reference.get("value")
            if not isinstance(ref_value, (list, tuple)):
                return True

        return False

    def check(
        self,
        ir: Any = None,
        artifact: Any = None,
        nl: str = None,
    ) -> list[Violation]:
        """Check well-formedness of hypothesis IR."""
        violations = []

        # Convert to dict if needed
        if hasattr(ir, "to_dict"):
            ir = ir.to_dict()
        elif hasattr(ir, "__dataclass_fields__"):
            ir = _dataclass_to_dict(ir)

        log(f"IN VIOLATIONS CHECK: {json.dumps(ir)}\n")

        event = ir.get("event", {})

        # WF-1: Check fundamental event structure
        if (
            not event
            or not event.get("quantity")
            or not event.get("comparator")
            or not event.get("reference")
        ):
            violations.append(
                Violation(
                    invariantID="WF-1",
                    violationType=ViolationType.MALFORMED_HYPOTHESIS,
                    message="Formal hypothesis representation missing one or more fundamental event.",
                    criticality=Criticality.WARN,
                    observed=ir,
                )
            )

        # WF-2: Comparator check
        comparator = event.get("comparator", "")
        if comparator not in self.VALID_COMPARATORS:
            violations.append(
                Violation(
                    invariantID="WF-2",
                    violationType=ViolationType.MALFORMED_HYPOTHESIS,
                    message=f'Invalid comparator: "{comparator}".',
                    criticality=Criticality.WARN,
                    observed=ir,
                )
            )

        # WF-3: Reference compatibility check
        if self._is_reference_incompatible(ir):
            violations.append(
                Violation(
                    invariantID="WF-3",
                    violationType=ViolationType.MALFORMED_HYPOTHESIS,
                    message="Reference value type is incompatible with quantity of interest.",
                    criticality=Criticality.WARN,
                    observed=ir,
                )
            )

        return violations


class IntentPreserved(Invariant):
    """Check that intent is preserved between NL and IR."""

    def __init__(self, id: str, appliesTo: str):
        super().__init__(id, appliesTo)

    async def check_async(
        self,
        ir: Any = None,
        artifact: Any = None,
        nl: str = None,
    ) -> list[Violation]:
        """Async version of check for LLM calls."""
        violations = []

        if self.appliesTo == NLIR:
            # INT-1: Comparator polarity preservation
            response = await llm.ainvoke(
                f"""You will be provided with a natural language hypothesis.
                Please extract a comparator that describes the relationship between a quantity of interest and a reference value that the hypothesis is attempting to capture.
                Natural Language Hypothesis: {nl}

                Return a json object with the following fields:
                {{
                    "comparator": "<the comparator implied by the natural language hypothesis>",
                    "rationale": "<a short statement explaining your rationale for choosing this comparator>"
                }}
                """
            )

            log(f"\nRESPONSE: {response.content}\n")

            try:
                resp = json.loads(response.content)
            except json.JSONDecodeError:
                return violations

            # Convert to dict if needed
            if hasattr(ir, "__dataclass_fields__"):
                ir = _dataclass_to_dict(ir)

            ir_comparator = ir.get("event", {}).get("comparator", "")

            if resp.get("comparator") != ir_comparator:
                violations.append(
                    Violation(
                        invariantID="INT-1",
                        violationType=ViolationType.INTENT_VIOLATION,
                        message=f"Comparator polarity not maintained. LLM Rationale for NL comparator choice: {resp.get('rationale', '')}",
                        expected=resp.get("comparator"),
                        observed=ir_comparator,
                        criticality=Criticality.WARN,
                    )
                )

        return violations

    def check(
        self,
        ir: Any = None,
        artifact: Any = None,
        nl: str = None,
    ) -> list[Violation]:
        """Synchronous check - runs async version in event loop."""
        import asyncio

        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        return loop.run_until_complete(self.check_async(ir=ir, artifact=artifact, nl=nl))


class StructurePreserved(Invariant):
    """Check that algebraic structure is preserved in IR."""

    def __init__(self, id: str, appliesTo: str):
        super().__init__(id, appliesTo)

    def _is_predicate_missing(self, ir: dict) -> bool:
        """Check if conditioning predicates are missing."""
        quantity = ir.get("event", {}).get("quantity", {})
        quantity_type = quantity.get("type")

        if quantity_type == "expectation" and not quantity.get("predicate"):
            return True
        elif quantity_type == "contrast":
            if not quantity.get("left", {}).get("predicate") or not quantity.get(
                "right", {}
            ).get("predicate"):
                return True
        elif quantity_type == "rv":
            estimand = quantity.get("estimand", {})
            estimand_type = estimand.get("type")
            if estimand_type == "expectation" and not estimand.get("predicate"):
                return True
            elif estimand_type == "contrast" and (
                not estimand.get("left", {}).get("predicate")
                or not estimand.get("right", {}).get("predicate")
            ):
                return True

        return False

    def _is_algebraic_structure_not_preserved(self, ir: dict) -> bool:
        """Check if algebraic structure is not preserved."""
        quantity = ir.get("event", {}).get("quantity", {})
        quantity_type = quantity.get("type")

        if quantity_type == "contrast":
            if (
                not quantity.get("op")
                or not quantity.get("left")
                or not quantity.get("right")
            ):
                return True
        elif quantity_type == "rv":
            estimand = quantity.get("estimand", {})
            if (
                not estimand.get("op")
                or not estimand.get("left")
                or not estimand.get("right")
            ):
                return True

        return False

    def check(
        self,
        ir: Any = None,
        artifact: Any = None,
        nl: str = None,
    ) -> list[Violation]:
        """Check structural preservation of IR."""
        violations = []

        # Convert to dict if needed
        if hasattr(ir, "__dataclass_fields__"):
            ir = _dataclass_to_dict(ir)

        quantity = ir.get("event", {}).get("quantity", {})
        quantity_type = quantity.get("type")

        # STR-1: Explicit estimand check
        if quantity_type not in ("contrast", "expectation", "rv") or (
            quantity_type == "rv" and not quantity.get("estimand")
        ):
            violations.append(
                Violation(
                    invariantID="STR-1",
                    violationType=ViolationType.STRUCTURE_VIOLATION,
                    message="Estimand not explicitly present.",
                    criticality=Criticality.FAIL,
                    observed=ir,
                )
            )

        # STR-2: Explicit conditioning
        if self._is_predicate_missing(ir):
            violations.append(
                Violation(
                    invariantID="STR-2",
                    violationType=ViolationType.STRUCTURE_VIOLATION,
                    message="Conditioning predicates are not attached to estimand.",
                    criticality=Criticality.FAIL,
                    observed=ir,
                )
            )

        # STR-3: Algebraic structure explicitness
        if self._is_algebraic_structure_not_preserved(ir):
            violations.append(
                Violation(
                    invariantID="STR-3",
                    violationType=ViolationType.STRUCTURE_VIOLATION,
                    message="Algebraic structure not explicitly preserved.",
                    criticality=Criticality.FAIL,
                    observed=ir,
                )
            )

        return violations


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

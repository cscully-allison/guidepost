"""Tests for the Campsite Python backend."""

import pytest
import json


class TestIRParser:
    """Tests for the hypothesis IR parser."""

    def test_parse_simple_expectation(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | y = 1] > 0")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["type"] == "hypothesis"
        assert d["event"]["type"] == "comparison"
        assert d["event"]["quantity"]["type"] == "expectation"
        assert d["event"]["quantity"]["attr"] == "x"
        assert d["event"]["quantity"]["predicate"]["attr"] == "y"
        assert d["event"]["quantity"]["predicate"]["comparator"] == "="
        assert d["event"]["quantity"]["predicate"]["value"] == 1.0
        assert d["event"]["comparator"] == ">"
        assert d["event"]["referent"]["value"] == 0.0

    def test_parse_contrast(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | g = 1] - E[x | g = 0] > 0")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["type"] == "hypothesis"
        assert d["event"]["quantity"]["type"] == "contrast"
        assert d["event"]["quantity"]["lhs"]["type"] == "expectation"
        assert d["event"]["quantity"]["rhs"]["type"] == "expectation"
        assert d["event"]["quantity"]["op"] == "-"

    def test_parse_rv(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("bootstrap(E[x | y = 1]) BETWEEN (0, 1)")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["type"] == "hypothesis"
        assert d["event"]["quantity"]["type"] == "rv"
        assert d["event"]["quantity"]["distribution"] == "bootstrap"
        assert d["event"]["quantity"]["estimand"]["type"] == "expectation"
        assert d["event"]["comparator"] == "BETWEEN"
        assert d["event"]["referent"]["value"] == [0.0, 1.0]

    def test_parse_string_predicate(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis('E[salary | dept = "Engineering"] > 50000')
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["event"]["quantity"]["predicate"]["value"] == "Engineering"
        assert d["event"]["referent"]["value"] == 50000.0

    def test_parse_boolean_predicate(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[failure | flag = true] / E[failure | flag = false] > 1")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["type"] == "hypothesis"
        assert d["event"]["quantity"]["type"] == "contrast"
        assert d["event"]["quantity"]["lhs"]["predicate"]["value"] is True
        assert d["event"]["quantity"]["rhs"]["predicate"]["value"] is False
        assert d["event"]["quantity"]["op"] == "/"

    def test_parse_quantity_vs_quantity(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | a = 1] > E[x | a = 0]")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["type"] == "hypothesis"
        assert d["event"]["type"] == "comparison"
        assert d["event"]["quantity"]["type"] == "expectation"
        assert d["event"]["quantity"]["attr"] == "x"
        assert d["event"]["quantity"]["predicate"]["value"] == 1.0
        assert d["event"]["comparator"] == ">"
        assert d["event"]["referent"]["type"] == "expectation"
        assert d["event"]["referent"]["attr"] == "x"
        assert d["event"]["referent"]["predicate"]["value"] == 0.0

    def test_parse_conjunction_predicate(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | a = 1 ^ b = 2] > 0")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        pred = d["event"]["quantity"]["predicate"]
        assert pred["type"] == "predicate"
        assert pred["kind"] == "conjunction"
        assert pred["lhs"]["attr"] == "a"
        assert pred["lhs"]["value"] == 1.0
        assert pred["rhs"]["attr"] == "b"
        assert pred["rhs"]["value"] == 2.0

    def test_parse_triple_conjunction_predicate(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | a = 1 ^ b = 2 ^ c = 3] > 0")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        pred = d["event"]["quantity"]["predicate"]
        assert pred["kind"] == "conjunction"
        # Left-associative: (a=1 ^ b=2) ^ c=3
        assert pred["lhs"]["kind"] == "conjunction"
        assert pred["lhs"]["lhs"]["attr"] == "a"
        assert pred["lhs"]["rhs"]["attr"] == "b"
        assert pred["rhs"]["attr"] == "c"

    def test_parse_extract(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("Extract(linear_model, E[y | x = 1]) > 0")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["type"] == "hypothesis"
        assert d["event"]["quantity"]["type"] == "extract"
        assert d["event"]["quantity"]["model"] == "linear_model"
        assert d["event"]["quantity"]["estimand"]["type"] == "expectation"
        assert d["event"]["quantity"]["estimand"]["attr"] == "y"

    def test_parse_event_with_predicate(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | a = 1] > 5 (b = 2)")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["type"] == "hypothesis"
        assert d["event"]["type"] == "comparison"
        assert d["event"]["quantity"]["type"] == "expectation"
        assert d["event"]["comparator"] == ">"
        assert d["event"]["referent"]["value"] == 5.0
        assert d["event"]["predicate"]["attr"] == "b"
        assert d["event"]["predicate"]["comparator"] == "="
        assert d["event"]["predicate"]["value"] == 2.0

    def test_parse_event_without_predicate_has_none(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | a = 1] > 5")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["event"]["predicate"] is None

    def test_parse_thorn_unspecified_comparator(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | a = 1] ᚦ 5")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["type"] == "hypothesis"
        assert d["event"]["type"] == "comparison"
        assert d["event"]["quantity"]["type"] == "expectation"
        assert d["event"]["comparator"] == "ᚦ"
        assert d["event"]["referent"]["value"] == 5.0

    def test_parse_thorn_unspecified_referent(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | a = 1] > ᚦ")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["type"] == "hypothesis"
        assert d["event"]["type"] == "comparison"
        assert d["event"]["quantity"]["type"] == "expectation"
        assert d["event"]["comparator"] == ">"
        assert d["event"]["referent"]["type"] == "unspecified"

    def test_parse_thorn_unspecified_comparator_quantity_referent(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | a = 1] ᚦ E[x | a = 0]")
        assert parse_result.errors == []
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["event"]["comparator"] == "ᚦ"
        assert d["event"]["referent"]["type"] == "expectation"
        assert d["event"]["referent"]["attr"] == "x"

    def test_parse_error_returns_error_node(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("invalid hypothesis string without structure")
        assert parse_result.is_partial
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["type"] == "hypothesis"
        assert d["event"]["type"] == "error"
        assert "Parse error" in d["event"]["message"]


class TestSICheckers:
    """Tests for the canonical field semantic invariant checkers."""

    # -- IR Fixtures --

    SIMPLE_EXPECTATION_IR = {
        "type": "hypothesis",
        "event": {
            "type": "comparison",
            "quantity": {
                "type": "expectation",
                "attr": "x",
                "predicate": {"type": "predicate", "kind": "comparison", "attr": "y", "comparator": "=", "value": 1},
            },
            "comparator": ">",
            "referent": {"type": "const", "value": 0},
            "predicate": None,
        },
    }

    CONTRAST_IR = {
        "type": "hypothesis",
        "event": {
            "type": "comparison",
            "quantity": {
                "type": "contrast",
                "lhs": {"type": "expectation", "attr": "x", "predicate": {"type": "predicate", "kind": "comparison", "attr": "g", "comparator": "=", "value": 1}},
                "op": "-",
                "rhs": {"type": "expectation", "attr": "x", "predicate": {"type": "predicate", "kind": "comparison", "attr": "g", "comparator": "=", "value": 0}},
            },
            "comparator": ">",
            "referent": {"type": "const", "value": 0},
            "predicate": None,
        },
    }

    RV_IR = {
        "type": "hypothesis",
        "event": {
            "type": "comparison",
            "quantity": {
                "type": "rv",
                "distribution": "bootstrap",
                "estimand": {
                    "type": "expectation",
                    "attr": "x",
                    "predicate": {"type": "predicate", "kind": "comparison", "attr": "y", "comparator": "=", "value": 1},
                },
            },
            "comparator": "BETWEEN",
            "referent": {"type": "const", "value": [0, 1]},
            "predicate": None,
        },
    }

    UNDERSPECIFIED_IR = {
        "type": "hypothesis",
        "event": {
            "type": "comparison",
            "quantity": {"type": "expectation", "attr": "x", "predicate": None},
            "comparator": "\u16A6",
            "referent": {"type": "const", "value": 5},
            "predicate": None,
        },
    }

    EMPTY_EVENT_IR = {"type": "hypothesis", "event": {}}

    CONDITIONED_EVENT_IR = {
        "type": "hypothesis",
        "event": {
            "type": "comparison",
            "quantity": {"type": "expectation", "attr": "x", "predicate": {"type": "predicate", "kind": "comparison", "attr": "a", "comparator": "=", "value": 1}},
            "comparator": ">",
            "referent": {"type": "const", "value": 5},
            "predicate": {"type": "predicate", "kind": "comparison", "attr": "b", "comparator": "=", "value": 2},
        },
    }

    # -- ComparatorChecker tests --

    def test_comparator_extracts_valid(self):
        from guidepost.campsite_lib.si_checkers import ComparatorChecker

        checker = ComparatorChecker()
        result = checker.extract_from_ir(self.SIMPLE_EXPECTATION_IR)
        assert result.value == ">"
        assert result.exists is True

    def test_comparator_missing_in_empty_event(self):
        from guidepost.campsite_lib.si_checkers import ComparatorChecker

        checker = ComparatorChecker()
        result = checker.extract_from_ir(self.EMPTY_EVENT_IR)
        assert result.exists is False

    def test_comparator_invalid_not_in_valid_set(self):
        from guidepost.campsite_lib.si_checkers import ComparatorChecker

        ir = {
            "type": "hypothesis",
            "event": {"type": "comparison", "quantity": {}, "comparator": "~~", "referent": {"value": 0}},
        }
        checker = ComparatorChecker()
        result = checker.extract_from_ir(ir)
        assert result.value == "~~"
        assert result.exists is False

    def test_comparator_existence_violation_on_missing(self):
        from guidepost.campsite_lib.si_checkers import ComparatorChecker

        checker = ComparatorChecker()
        violations = checker.check(ir=self.EMPTY_EVENT_IR)
        ids = [v.invariantID for v in violations]
        assert "event.comparator-EX-IR" in ids

    def test_comparator_no_violation_on_valid(self):
        from guidepost.campsite_lib.si_checkers import ComparatorChecker

        checker = ComparatorChecker()
        violations = checker.check(ir=self.SIMPLE_EXPECTATION_IR)
        ex_violations = [v for v in violations if "EX-IR" in v.invariantID and "comparator" in v.invariantID]
        assert len(ex_violations) == 0

    # -- ReferenceChecker tests --

    def test_reference_extracts_const(self):
        from guidepost.campsite_lib.si_checkers import ReferenceChecker

        checker = ReferenceChecker()
        result = checker.extract_from_ir(self.SIMPLE_EXPECTATION_IR)
        assert result.value == 0
        assert result.exists is True

    def test_reference_extracts_unspecified(self):
        from guidepost.campsite_lib.si_checkers import ReferenceChecker

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x"},
                "comparator": ">",
                "referent": {"type": "unspecified"},
            },
        }
        checker = ReferenceChecker()
        result = checker.extract_from_ir(ir)
        assert result.value == "unspecified"
        assert result.exists is True
        assert result.metadata.get("unspecified") is True

    def test_reference_missing(self):
        from guidepost.campsite_lib.si_checkers import ReferenceChecker

        checker = ReferenceChecker()
        result = checker.extract_from_ir(self.EMPTY_EVENT_IR)
        assert result.exists is False

    def test_reference_extracts_quantity_referent(self):
        from guidepost.campsite_lib.si_checkers import ReferenceChecker

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x", "predicate": {"attr": "a", "comparator": "=", "value": 1}},
                "comparator": ">",
                "referent": {"type": "expectation", "attr": "x", "predicate": {"attr": "a", "comparator": "=", "value": 0}},
            },
        }
        checker = ReferenceChecker()
        result = checker.extract_from_ir(ir)
        assert result.exists is True
        assert result.value["type"] == "expectation"

    # -- EventFormChecker tests --

    def test_event_form_simple(self):
        from guidepost.campsite_lib.si_checkers import EventFormChecker

        checker = EventFormChecker()
        result = checker.extract_from_ir(self.SIMPLE_EXPECTATION_IR)
        assert result.value == "conditioned"  # Has predicate on quantity
        assert result.exists is True

    def test_event_form_underspecified(self):
        from guidepost.campsite_lib.si_checkers import EventFormChecker

        checker = EventFormChecker()
        result = checker.extract_from_ir(self.UNDERSPECIFIED_IR)
        assert result.value == "underspecified"

    def test_event_form_conditioned_event_predicate(self):
        from guidepost.campsite_lib.si_checkers import EventFormChecker

        checker = EventFormChecker()
        result = checker.extract_from_ir(self.CONDITIONED_EVENT_IR)
        assert result.value == "conditioned"

    def test_event_form_truly_simple(self):
        from guidepost.campsite_lib.si_checkers import EventFormChecker

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x", "predicate": None},
                "comparator": ">",
                "referent": {"type": "const", "value": 0},
                "predicate": None,
            },
        }
        checker = EventFormChecker()
        result = checker.extract_from_ir(ir)
        assert result.value == "simple"

    # -- QuantitySignatureChecker tests --

    def test_quantity_signature_level(self):
        from guidepost.campsite_lib.si_checkers import QuantitySignatureChecker

        checker = QuantitySignatureChecker()
        result = checker.extract_from_ir(self.SIMPLE_EXPECTATION_IR)
        assert result.value == "level"

    def test_quantity_signature_contrast(self):
        from guidepost.campsite_lib.si_checkers import QuantitySignatureChecker

        checker = QuantitySignatureChecker()
        result = checker.extract_from_ir(self.CONTRAST_IR)
        assert result.value == "contrast"

    def test_quantity_signature_distribution(self):
        from guidepost.campsite_lib.si_checkers import QuantitySignatureChecker

        checker = QuantitySignatureChecker()
        result = checker.extract_from_ir(self.RV_IR)
        assert result.value == "distribution"

    def test_quantity_signature_unknown(self):
        from guidepost.campsite_lib.si_checkers import QuantitySignatureChecker

        checker = QuantitySignatureChecker()
        result = checker.extract_from_ir(self.EMPTY_EVENT_IR)
        assert result.exists is False

    # -- ConditioningChecker tests --

    def test_conditioning_extracts_predicates(self):
        from guidepost.campsite_lib.si_checkers import ConditioningChecker

        checker = ConditioningChecker()
        result = checker.extract_from_ir(self.SIMPLE_EXPECTATION_IR)
        assert result.exists is True
        assert len(result.value) == 1
        assert result.value[0]["attr"] == "y"

    def test_conditioning_contrast_predicates(self):
        from guidepost.campsite_lib.si_checkers import ConditioningChecker

        checker = ConditioningChecker()
        result = checker.extract_from_ir(self.CONTRAST_IR)
        assert result.exists is True
        assert len(result.value) == 2

    def test_conditioning_no_predicates(self):
        from guidepost.campsite_lib.si_checkers import ConditioningChecker

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x", "predicate": None},
                "comparator": ">",
                "referent": {"type": "const", "value": 0},
                "predicate": None,
            },
        }
        checker = ConditioningChecker()
        result = checker.extract_from_ir(ir)
        assert result.exists is False
        assert result.value == []

    def test_conditioning_no_existence_violation(self):
        """Conditioning is optional — absence should not generate a violation."""
        from guidepost.campsite_lib.si_checkers import ConditioningChecker

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x", "predicate": None},
                "comparator": ">",
                "referent": {"type": "const", "value": 0},
                "predicate": None,
            },
        }
        checker = ConditioningChecker()
        violations = checker.check(ir=ir)
        ex_violations = [v for v in violations if "EX-" in v.invariantID]
        assert len(ex_violations) == 0

    def test_conditioning_includes_event_predicate(self):
        from guidepost.campsite_lib.si_checkers import ConditioningChecker

        checker = ConditioningChecker()
        result = checker.extract_from_ir(self.CONDITIONED_EVENT_IR)
        attrs = [p["attr"] for p in result.value]
        assert "a" in attrs
        assert "b" in attrs

    # -- EstimandShapeChecker tests --

    def test_estimand_shape_simple(self):
        from guidepost.campsite_lib.si_checkers import EstimandShapeChecker

        checker = EstimandShapeChecker()
        result = checker.extract_from_ir(self.SIMPLE_EXPECTATION_IR)
        assert result.value == "simple"

    def test_estimand_shape_difference(self):
        from guidepost.campsite_lib.si_checkers import EstimandShapeChecker

        checker = EstimandShapeChecker()
        result = checker.extract_from_ir(self.CONTRAST_IR)
        assert result.value == "difference"

    def test_estimand_shape_ratio(self):
        from guidepost.campsite_lib.si_checkers import EstimandShapeChecker

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {
                    "type": "contrast",
                    "lhs": {"type": "expectation", "attr": "x"},
                    "op": "/",
                    "rhs": {"type": "expectation", "attr": "x"},
                },
                "comparator": ">",
                "referent": {"type": "const", "value": 1},
            },
        }
        checker = EstimandShapeChecker()
        result = checker.extract_from_ir(ir)
        assert result.value == "ratio"

    def test_estimand_shape_nested_difference(self):
        from guidepost.campsite_lib.si_checkers import EstimandShapeChecker

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {
                    "type": "rv",
                    "distribution": "bootstrap",
                    "estimand": {
                        "type": "contrast",
                        "lhs": {"type": "expectation", "attr": "x"},
                        "op": "-",
                        "rhs": {"type": "expectation", "attr": "x"},
                    },
                },
                "comparator": "BETWEEN",
                "referent": {"type": "const", "value": [0, 1]},
            },
        }
        checker = EstimandShapeChecker()
        result = checker.extract_from_ir(ir)
        assert result.value == "nested_difference"

    # -- UncertaintyShownChecker tests --

    def test_uncertainty_shown_point(self):
        from guidepost.campsite_lib.si_checkers import UncertaintyShownChecker

        checker = UncertaintyShownChecker()
        result = checker.extract_from_ir(self.SIMPLE_EXPECTATION_IR)
        assert result.value == "point"

    def test_uncertainty_shown_distribution(self):
        from guidepost.campsite_lib.si_checkers import UncertaintyShownChecker

        checker = UncertaintyShownChecker()
        result = checker.extract_from_ir(self.RV_IR)
        assert result.value == "distribution"

    # -- UncertaintyTargetChecker tests --

    def test_uncertainty_target_expectation(self):
        from guidepost.campsite_lib.si_checkers import UncertaintyTargetChecker

        checker = UncertaintyTargetChecker()
        result = checker.extract_from_ir(self.RV_IR)
        assert result.value == "expectation"
        assert result.exists is True

    def test_uncertainty_target_none_when_no_rv(self):
        from guidepost.campsite_lib.si_checkers import UncertaintyTargetChecker

        checker = UncertaintyTargetChecker()
        result = checker.extract_from_ir(self.SIMPLE_EXPECTATION_IR)
        assert result.exists is False

    def test_uncertainty_target_no_existence_violation(self):
        """No uncertainty is valid — should not generate existence violation."""
        from guidepost.campsite_lib.si_checkers import UncertaintyTargetChecker

        checker = UncertaintyTargetChecker()
        violations = checker.check(ir=self.SIMPLE_EXPECTATION_IR)
        ex_violations = [v for v in violations if "EX-" in v.invariantID]
        assert len(ex_violations) == 0

    # -- Pairwise check tests (using NL overrides) --

    def test_pairwise_comparator_match(self):
        from guidepost.campsite_lib.si_checkers import ComparatorChecker, ExtractedValue

        checker = ComparatorChecker()
        checker.set_nl_override(ExtractedValue(value=">", exists=True))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    def test_pairwise_comparator_mismatch(self):
        from guidepost.campsite_lib.si_checkers import ComparatorChecker, ExtractedValue

        checker = ComparatorChecker()
        checker.set_nl_override(ExtractedValue(value="<", exists=True))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 1
        assert pw_violations[0].expected == "<"
        assert pw_violations[0].observed == ">"

    def test_pairwise_skipped_when_source_missing(self):
        from guidepost.campsite_lib.si_checkers import ComparatorChecker, ExtractedValue

        checker = ComparatorChecker()
        checker.set_nl_override(ExtractedValue(value=None, exists=False))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-" in v.invariantID]
        assert len(pw_violations) == 0

    # -- Semantic normalization pairwise tests --

    # ComparatorChecker normalization

    def test_pairwise_comparator_nl_alias_greater_than(self):
        """NL 'greater than' should match IR '>'."""
        from guidepost.campsite_lib.si_checkers import ComparatorChecker, ExtractedValue

        checker = ComparatorChecker()
        checker.set_nl_override(ExtractedValue(value="greater than", exists=True))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    def test_pairwise_comparator_nl_alias_between(self):
        """NL 'between' (lowercase) should match IR 'BETWEEN'."""
        from guidepost.campsite_lib.si_checkers import ComparatorChecker, ExtractedValue

        checker = ComparatorChecker()
        checker.set_nl_override(ExtractedValue(value="between", exists=True))
        violations = checker.check(nl="dummy", ir=self.RV_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    # ReferenceChecker normalization

    def test_pairwise_reference_string_number_match(self):
        """NL '0' (string) should match IR 0 (number)."""
        from guidepost.campsite_lib.si_checkers import ReferenceChecker, ExtractedValue

        checker = ReferenceChecker()
        checker.set_nl_override(ExtractedValue(value="0", exists=True))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    def test_pairwise_reference_unspecified_match(self):
        """NL 'unspecified' should match IR 'unspecified'."""
        from guidepost.campsite_lib.si_checkers import ReferenceChecker, ExtractedValue

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x"},
                "comparator": ">",
                "referent": {"type": "unspecified"},
            },
        }
        checker = ReferenceChecker()
        checker.set_nl_override(ExtractedValue(value="unspecified", exists=True))
        violations = checker.check(nl="dummy", ir=ir)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    def test_pairwise_reference_quantity_referent_match(self):
        """NL description mentioning attr and type should match IR quantity referent."""
        from guidepost.campsite_lib.si_checkers import ReferenceChecker, ExtractedValue

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x", "predicate": {"attr": "a", "comparator": "=", "value": 1}},
                "comparator": ">",
                "referent": {"type": "expectation", "attr": "x", "predicate": {"attr": "a", "comparator": "=", "value": 0}},
            },
        }
        checker = ReferenceChecker()
        checker.set_nl_override(ExtractedValue(value="the average x for group a=0", exists=True))
        violations = checker.check(nl="dummy", ir=ir)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    def test_pairwise_reference_quantity_referent_mismatch(self):
        """NL description with wrong attr should NOT match IR quantity referent."""
        from guidepost.campsite_lib.si_checkers import ReferenceChecker, ExtractedValue

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x", "predicate": {"attr": "a", "comparator": "=", "value": 1}},
                "comparator": ">",
                "referent": {"type": "expectation", "attr": "x", "predicate": {"attr": "a", "comparator": "=", "value": 0}},
            },
        }
        checker = ReferenceChecker()
        checker.set_nl_override(ExtractedValue(value="the average z for group b=1", exists=True))
        violations = checker.check(nl="dummy", ir=ir)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 1

    def test_pairwise_reference_numeric_mismatch(self):
        """NL 5 should NOT match IR 0."""
        from guidepost.campsite_lib.si_checkers import ReferenceChecker, ExtractedValue

        checker = ReferenceChecker()
        checker.set_nl_override(ExtractedValue(value=5, exists=True))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 1

    # EventFormChecker normalization

    def test_pairwise_event_form_conditional_alias(self):
        """NL 'conditional' should match IR 'conditioned'."""
        from guidepost.campsite_lib.si_checkers import EventFormChecker, ExtractedValue

        checker = EventFormChecker()
        checker.set_nl_override(ExtractedValue(value="conditional", exists=True))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    # QuantitySignatureChecker normalization

    def test_pairwise_quantity_sig_mean_alias(self):
        """NL 'mean' should match IR 'level'."""
        from guidepost.campsite_lib.si_checkers import QuantitySignatureChecker, ExtractedValue

        checker = QuantitySignatureChecker()
        checker.set_nl_override(ExtractedValue(value="mean", exists=True))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    def test_pairwise_quantity_sig_correlation_alias(self):
        """NL 'correlation' should match IR 'association'."""
        from guidepost.campsite_lib.si_checkers import QuantitySignatureChecker, ExtractedValue

        checker = QuantitySignatureChecker()
        # Need an IR that produces "association"
        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "func", "name": "CORR"},
                "comparator": ">",
                "referent": {"type": "const", "value": 0},
            },
        }
        checker.set_nl_override(ExtractedValue(value="correlation", exists=True))
        violations = checker.check(nl="dummy", ir=ir)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    # ConditioningChecker — fast path (both dicts)

    def test_pairwise_conditioning_both_dicts_match(self):
        """Two dict lists with same attrs in different order should match."""
        from guidepost.campsite_lib.si_checkers import ConditioningChecker, ExtractedValue

        checker = ConditioningChecker()
        checker.set_nl_override(ExtractedValue(
            value=[{"attr": "b", "comparator": "=", "value": 2}, {"attr": "a", "comparator": "=", "value": 1}],
            exists=True,
        ))
        violations = checker.check(nl="dummy", ir=self.CONDITIONED_EVENT_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    def test_pairwise_conditioning_both_dicts_mismatch(self):
        """Two dict lists with different attrs should NOT match."""
        from guidepost.campsite_lib.si_checkers import ConditioningChecker, ExtractedValue

        checker = ConditioningChecker()
        checker.set_nl_override(ExtractedValue(
            value=[{"attr": "z", "comparator": "=", "value": 9}],
            exists=True,
        ))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 1

    # ConditioningChecker — count mismatch (no LLM needed)

    def test_pairwise_conditioning_count_mismatch(self):
        """Different number of conditions should NOT match without LLM."""
        from guidepost.campsite_lib.si_checkers import ConditioningChecker, ExtractedValue

        checker = ConditioningChecker()
        checker.set_nl_override(ExtractedValue(
            value=["y = 1"],
            exists=True,
        ))
        # CONDITIONED_EVENT_IR has 2 predicates (a and b)
        violations = checker.check(nl="dummy", ir=self.CONDITIONED_EVENT_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 1

    # ConditioningChecker — LLM judge path (using override)

    def test_pairwise_conditioning_judge_override_match(self):
        """Mixed types with judge override True should match."""
        from guidepost.campsite_lib.si_checkers import ConditioningChecker, ExtractedValue

        checker = ConditioningChecker()
        checker.set_judge_override(True)
        checker.set_nl_override(ExtractedValue(
            value=["for jobs that request GPUs", "for jobs with low GPU utilization", "for high-GPU-utilization jobs"],
            exists=True,
        ))
        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {
                    "type": "expectation", "attr": "x",
                    "predicate": {
                        "type": "predicate", "kind": "conjunction",
                        "lhs": {
                            "type": "predicate", "kind": "conjunction",
                            "lhs": {"type": "predicate", "kind": "comparison", "attr": "gpu", "comparator": "=", "value": True},
                            "rhs": {"type": "predicate", "kind": "comparison", "attr": "utilization", "comparator": "<", "value": 0.5},
                        },
                        "rhs": {"type": "predicate", "kind": "comparison", "attr": "utilization", "comparator": ">", "value": 0.8},
                    },
                },
                "comparator": ">",
                "referent": {"type": "const", "value": 0},
                "predicate": None,
            },
        }
        violations = checker.check(nl="dummy", ir=ir)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    def test_pairwise_conditioning_judge_override_no_match(self):
        """Mixed types with judge override False should NOT match."""
        from guidepost.campsite_lib.si_checkers import ConditioningChecker, ExtractedValue

        checker = ConditioningChecker()
        checker.set_judge_override(False)
        checker.set_nl_override(ExtractedValue(
            value=["for jobs that request GPUs", "for jobs with low GPU utilization", "for high-GPU-utilization jobs"],
            exists=True,
        ))
        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {
                    "type": "expectation", "attr": "x",
                    "predicate": {
                        "type": "predicate", "kind": "conjunction",
                        "lhs": {
                            "type": "predicate", "kind": "conjunction",
                            "lhs": {"type": "predicate", "kind": "comparison", "attr": "gpu", "comparator": "=", "value": True},
                            "rhs": {"type": "predicate", "kind": "comparison", "attr": "utilization", "comparator": "<", "value": 0.5},
                        },
                        "rhs": {"type": "predicate", "kind": "comparison", "attr": "utilization", "comparator": ">", "value": 0.8},
                    },
                },
                "comparator": ">",
                "referent": {"type": "const", "value": 0},
                "predicate": None,
            },
        }
        violations = checker.check(nl="dummy", ir=ir)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 1

    # EstimandShapeChecker normalization

    def test_pairwise_estimand_shape_subtraction_alias(self):
        """NL 'subtraction' should match IR 'difference'."""
        from guidepost.campsite_lib.si_checkers import EstimandShapeChecker, ExtractedValue

        checker = EstimandShapeChecker()
        checker.set_nl_override(ExtractedValue(value="subtraction", exists=True))
        violations = checker.check(nl="dummy", ir=self.CONTRAST_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    # UncertaintyShownChecker normalization

    def test_pairwise_uncertainty_shown_ci_alias(self):
        """NL 'confidence interval' should match IR 'distribution'."""
        from guidepost.campsite_lib.si_checkers import UncertaintyShownChecker, ExtractedValue

        checker = UncertaintyShownChecker()
        checker.set_nl_override(ExtractedValue(value="confidence interval", exists=True))
        violations = checker.check(nl="dummy", ir=self.RV_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    # UncertaintyTargetChecker normalization

    def test_pairwise_uncertainty_target_mean_alias(self):
        """NL 'the mean' should match IR 'expectation'."""
        from guidepost.campsite_lib.si_checkers import UncertaintyTargetChecker, ExtractedValue

        checker = UncertaintyTargetChecker()
        checker.set_nl_override(ExtractedValue(value="the mean", exists=True))
        violations = checker.check(nl="dummy", ir=self.RV_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    def test_pairwise_uncertainty_target_difference_alias(self):
        """NL 'the difference' should match IR 'contrast'."""
        from guidepost.campsite_lib.si_checkers import UncertaintyTargetChecker, ExtractedValue

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {
                    "type": "rv",
                    "distribution": "bootstrap",
                    "estimand": {
                        "type": "contrast",
                        "lhs": {"type": "expectation", "attr": "x"},
                        "op": "-",
                        "rhs": {"type": "expectation", "attr": "x"},
                    },
                },
                "comparator": "BETWEEN",
                "referent": {"type": "const", "value": [0, 1]},
                "predicate": None,
            },
        }
        checker = UncertaintyTargetChecker()
        checker.set_nl_override(ExtractedValue(value="the difference", exists=True))
        violations = checker.check(nl="dummy", ir=ir)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    # -- SICheckRunner tests --

    def test_runner_ir_only_no_violations_on_valid(self):
        from guidepost.campsite_lib.si_checkers import SICheckRunner

        runner = SICheckRunner()
        violations = runner.run_ir_only(ir=self.SIMPLE_EXPECTATION_IR)
        # Valid IR should have no existence violations for required fields
        # (comparator, reference, event form, quantity sig, estimand shape, uncertainty shown are all present)
        ex_ir_violations = [v for v in violations if "EX-IR" in v.invariantID]
        assert len(ex_ir_violations) == 0

    def test_runner_ir_only_violations_on_empty(self):
        from guidepost.campsite_lib.si_checkers import SICheckRunner

        runner = SICheckRunner()
        violations = runner.run_ir_only(ir=self.EMPTY_EVENT_IR)
        # Should have multiple existence violations
        assert len(violations) > 0
        ids = [v.invariantID for v in violations]
        assert "event.comparator-EX-IR" in ids
        assert "event.reference-EX-IR" in ids

    def test_runner_run_field(self):
        from guidepost.campsite_lib.si_checkers import SICheckRunner

        runner = SICheckRunner()
        violations = runner.run_field("event.comparator", ir=self.SIMPLE_EXPECTATION_IR)
        # Should only return violations for that field
        for v in violations:
            assert "event.comparator" in v.invariantID

    def test_runner_get_checker(self):
        from guidepost.campsite_lib.si_checkers import SICheckRunner, ComparatorChecker

        runner = SICheckRunner()
        checker = runner.get_checker("event.comparator")
        assert isinstance(checker, ComparatorChecker)

    # -- Violation serialization --

    def test_violation_to_dict(self):
        from guidepost.campsite_lib.si_checkers import Violation, ViolationType, Criticality

        v = Violation(
            invariantID="event.comparator-EX-IR",
            violationType=ViolationType.MISSING_IN_IR,
            message="test",
            criticality=Criticality.WARN,
            expected="present",
            observed=None,
        )
        d = v.to_dict()
        assert d["invariantID"] == "event.comparator-EX-IR"
        assert d["violationType"] == "missing_in_ir"
        assert d["criticality"] == "warn"

    # -- Integration test: parser + runner --

    def test_parsed_hypothesis_through_runner(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict
        from guidepost.campsite_lib.si_checkers import SICheckRunner

        parse_result = parse_hypothesis("E[x | y = 1] > 0")
        assert parse_result.errors == []
        ir_dict = hypothesis_to_dict(parse_result.hypothesis)
        runner = SICheckRunner()
        violations = runner.run_ir_only(ir=ir_dict)
        ex_ir_violations = [v for v in violations if "EX-IR" in v.invariantID]
        assert len(ex_ir_violations) == 0

    def test_parsed_contrast_through_runner(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict
        from guidepost.campsite_lib.si_checkers import SICheckRunner

        parse_result = parse_hypothesis("E[x | g = 1] - E[x | g = 0] > 0")
        assert parse_result.errors == []
        ir_dict = hypothesis_to_dict(parse_result.hypothesis)
        runner = SICheckRunner()
        violations = runner.run_ir_only(ir=ir_dict)
        ex_ir_violations = [v for v in violations if "EX-IR" in v.invariantID]
        assert len(ex_ir_violations) == 0

    # -- Fix 3: EventFormChecker referent predicate --

    def test_event_form_conditioned_by_referent_predicate(self):
        """EventFormChecker should detect conditioning in referent subtree."""
        from guidepost.campsite_lib.si_checkers import EventFormChecker

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x", "predicate": None},
                "comparator": ">",
                "referent": {
                    "type": "expectation", "attr": "x",
                    "predicate": {"type": "predicate", "kind": "comparison", "attr": "g", "comparator": "=", "value": 0},
                },
                "predicate": None,
            },
        }
        checker = EventFormChecker()
        result = checker.extract_from_ir(ir)
        assert result.value == "conditioned"

    # -- Fix 5: ErrorNode produces MALFORMED violations --

    def test_error_node_event_produces_malformed(self):
        """ErrorNode at event level should produce MALFORMED violations."""
        from guidepost.campsite_lib.si_checkers import ComparatorChecker, ViolationType

        ir = {
            "type": "hypothesis",
            "event": {"type": "error", "boundary": "event", "message": "bad parse"},
        }
        checker = ComparatorChecker()
        violations = checker.check(ir=ir)
        malformed = [v for v in violations if v.violationType == ViolationType.MALFORMED]
        assert len(malformed) == 1
        assert "malformed" in malformed[0].message.lower()
        assert "event" in malformed[0].message.lower()

    def test_error_node_quantity_only_affects_quantity_checkers(self):
        """ErrorNode in quantity should not affect ComparatorChecker."""
        from guidepost.campsite_lib.si_checkers import (
            ComparatorChecker, QuantitySignatureChecker, ViolationType,
        )

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "error", "boundary": "quantity", "message": "bad qty"},
                "comparator": ">",
                "referent": {"type": "const", "value": 0},
                "predicate": None,
            },
        }
        # ComparatorChecker should work fine (event is not an error)
        comp_checker = ComparatorChecker()
        comp_violations = comp_checker.check(ir=ir)
        comp_malformed = [v for v in comp_violations if v.violationType == ViolationType.MALFORMED]
        assert len(comp_malformed) == 0

        # QuantitySignatureChecker should report MALFORMED
        qty_checker = QuantitySignatureChecker()
        qty_violations = qty_checker.check(ir=ir)
        qty_malformed = [v for v in qty_violations if v.violationType == ViolationType.MALFORMED]
        assert len(qty_malformed) == 1

    def test_error_node_referent_affects_reference_checker(self):
        """ErrorNode in referent should produce MALFORMED from ReferenceChecker."""
        from guidepost.campsite_lib.si_checkers import ReferenceChecker, ViolationType

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x", "predicate": None},
                "comparator": ">",
                "referent": {"type": "error", "boundary": "referent", "message": "bad ref"},
                "predicate": None,
            },
        }
        checker = ReferenceChecker()
        violations = checker.check(ir=ir)
        malformed = [v for v in violations if v.violationType == ViolationType.MALFORMED]
        assert len(malformed) == 1

    # -- Fix 6: Float near-equality --

    def test_reference_float_near_equality(self):
        """Float values that are nearly equal should match."""
        from guidepost.campsite_lib.si_checkers import ReferenceChecker, ExtractedValue

        checker = ReferenceChecker()
        # 0.1 + 0.2 != 0.3 in IEEE 754, but should match via math.isclose
        checker.set_nl_override(ExtractedValue(value=0.1 + 0.2, exists=True))
        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x", "predicate": None},
                "comparator": ">",
                "referent": {"type": "const", "value": 0.3},
                "predicate": None,
            },
        }
        violations = checker.check(nl="dummy", ir=ir)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    # -- Fix 7: Confidence threshold --

    def test_low_confidence_downgrades_to_warn(self):
        """Low-confidence NL extraction should produce WARN, not FAIL, on mismatch."""
        from guidepost.campsite_lib.si_checkers import ComparatorChecker, ExtractedValue, Criticality

        checker = ComparatorChecker()
        checker.set_nl_override(ExtractedValue(value="<", exists=True, confidence=0.2))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 1
        assert pw_violations[0].criticality == Criticality.WARN

    def test_high_confidence_stays_fail(self):
        """High-confidence NL extraction should keep FAIL on mismatch."""
        from guidepost.campsite_lib.si_checkers import ComparatorChecker, ExtractedValue, Criticality

        checker = ComparatorChecker()
        checker.set_nl_override(ExtractedValue(value="<", exists=True, confidence=0.9))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 1
        assert pw_violations[0].criticality == Criticality.FAIL

    # -- Fix 8: NL alias additions --

    def test_comparator_higher_than_alias(self):
        """NL 'higher than' should normalize to '>'."""
        from guidepost.campsite_lib.si_checkers import ComparatorChecker, ExtractedValue

        checker = ComparatorChecker()
        checker.set_nl_override(ExtractedValue(value="higher than", exists=True))
        violations = checker.check(nl="dummy", ir=self.SIMPLE_EXPECTATION_IR)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        assert len(pw_violations) == 0

    def test_comparator_no_more_than_alias(self):
        """NL 'no more than' should normalize to '<='."""
        from guidepost.campsite_lib.si_checkers import ComparatorChecker

        checker = ComparatorChecker()
        assert checker._normalize_nl_value("no more than") == "<="

    def test_event_form_unconditioned_typo_fix(self):
        """'unconditioned' (correctly spelled) should normalize to 'simple'."""
        from guidepost.campsite_lib.si_checkers import EventFormChecker

        checker = EventFormChecker()
        assert checker._normalize_nl_value("unconditioned") == "simple"

    # -- Fix 11: Numeric string guard in ReferenceChecker --

    def test_reference_numeric_string_does_not_hit_dict_path(self):
        """NL numeric string '50000' should not match a quantity-type referent via substring."""
        from guidepost.campsite_lib.si_checkers import ReferenceChecker, ExtractedValue

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "salary", "predicate": None},
                "comparator": ">",
                "referent": {"type": "expectation", "attr": "salary", "predicate": {"attr": "dept", "comparator": "=", "value": "eng"}},
                "predicate": None,
            },
        }
        checker = ReferenceChecker()
        checker.set_nl_override(ExtractedValue(value="50000", exists=True))
        violations = checker.check(nl="dummy", ir=ir)
        pw_violations = [v for v in violations if "PW-NLIR" in v.invariantID]
        # Should produce a mismatch — "50000" is not a description of the quantity referent
        assert len(pw_violations) == 1


class TestComparatorScanner:
    """Tests for the bracket-aware comparator scanner."""

    def test_simple_greater_than(self):
        from guidepost.campsite_lib.ir_parser import _find_event_comparator

        result = _find_event_comparator("x > 5")
        assert result is not None
        assert result[0] == ">"

    def test_skips_bracket_depth(self):
        from guidepost.campsite_lib.ir_parser import _find_event_comparator

        result = _find_event_comparator("E[x | y = 1] > 5")
        assert result is not None
        comp, start, end = result
        assert comp == ">"
        # ">" should be after the "]", not the "=" inside brackets
        assert start > 12

    def test_longest_match_first(self):
        from guidepost.campsite_lib.ir_parser import _find_event_comparator

        result = _find_event_comparator("x >= 5")
        assert result is not None
        assert result[0] == ">="

    def test_between(self):
        from guidepost.campsite_lib.ir_parser import _find_event_comparator

        result = _find_event_comparator("x BETWEEN (0, 1)")
        assert result is not None
        assert result[0] == "BETWEEN"

    def test_no_comparator(self):
        from guidepost.campsite_lib.ir_parser import _find_event_comparator

        result = _find_event_comparator("just some text")
        assert result is None

    def test_nested_parens(self):
        from guidepost.campsite_lib.ir_parser import _find_event_comparator

        result = _find_event_comparator("bootstrap(E[x | y = 1]) BETWEEN (0, 1)")
        assert result is not None
        assert result[0] == "BETWEEN"

    def test_thorn(self):
        from guidepost.campsite_lib.ir_parser import _find_event_comparator

        result = _find_event_comparator("E[x | a = 1] \u16A6 5")
        assert result is not None
        assert result[0] == "\u16A6"

    def test_contrast_inner_ops_skipped(self):
        from guidepost.campsite_lib.ir_parser import _find_event_comparator

        result = _find_event_comparator("E[x | g = 1] - E[x | g = 0] > 0")
        assert result is not None
        assert result[0] == ">"


class TestPartialRecovery:
    """Tests for partial parse recovery."""

    def test_recovery_bad_quantity_good_referent(self):
        """Malformed quantity but valid comparator and referent."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        # "E[x]" is not a valid expectation (missing "| predicate"); "> 5" is valid
        parse_result = parse_hypothesis("E[x] > 5")
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert parse_result.is_partial
        assert d["event"]["type"] == "comparison"
        assert d["event"]["comparator"] == ">"
        assert d["event"]["quantity"]["type"] == "error"
        assert d["event"]["quantity"]["boundary"] == "quantity"
        assert d["event"]["referent"]["value"] == 5.0

    def test_recovery_good_quantity_bad_referent(self):
        """Valid quantity and comparator but malformed referent."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | y = 1] > E[z |")
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert parse_result.is_partial
        assert d["event"]["type"] == "comparison"
        assert d["event"]["quantity"]["type"] == "expectation"
        assert d["event"]["quantity"]["attr"] == "x"
        assert d["event"]["comparator"] == ">"
        assert d["event"]["referent"]["type"] == "error"
        assert d["event"]["referent"]["boundary"] == "referent"

    def test_recovery_both_sides_bad(self):
        """Both quantity and referent are malformed, but comparator found."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("$$$ > ???")
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert len(parse_result.errors) == 2
        assert d["event"]["type"] == "comparison"
        assert d["event"]["comparator"] == ">"
        assert d["event"]["quantity"]["type"] == "error"
        assert d["event"]["referent"]["type"] == "error"

    def test_recovery_no_comparator_falls_back(self):
        """No comparator at depth 0 — falls back to full event ErrorNode."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("just random words")
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert parse_result.is_partial
        assert d["event"]["type"] == "error"
        assert d["event"]["boundary"] == "event"

    def test_recovery_missing_referent(self):
        """Comparator found but nothing after — quantity OK, referent error."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | y = 1] >")
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert parse_result.is_partial
        assert d["event"]["type"] == "comparison"
        assert d["event"]["quantity"]["type"] == "expectation"
        assert d["event"]["comparator"] == ">"
        assert d["event"]["referent"]["type"] == "error"

    def test_recovery_between_comparator(self):
        """Recovery works with multi-character comparators like BETWEEN."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("$$$ BETWEEN (0, 1)")
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["event"]["type"] == "comparison"
        assert d["event"]["comparator"] == "BETWEEN"
        assert d["event"]["quantity"]["type"] == "error"

    def test_recovery_thorn_comparator(self):
        """Recovery works with thorn comparator."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("$$$ \u16A6 5")
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["event"]["type"] == "comparison"
        assert d["event"]["comparator"] == "\u16A6"
        assert d["event"]["quantity"]["type"] == "error"

    def test_recovery_errors_have_positions(self):
        """ErrorNodes from recovery should have start/end positions."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis

        parse_result = parse_hypothesis("$$$ > ???")
        for err in parse_result.errors:
            assert isinstance(err.start, int)
            assert isinstance(err.end, int)

    def test_recovery_preserves_quantity_with_bad_referent(self):
        """When quantity parses but referent fails, quantity is preserved."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        parse_result = parse_hypothesis("E[x | y = 1] >= E[z |")
        d = hypothesis_to_dict(parse_result.hypothesis)

        assert d["event"]["type"] == "comparison"
        assert d["event"]["comparator"] == ">="
        assert d["event"]["quantity"]["type"] == "expectation"
        assert d["event"]["referent"]["type"] == "error"

    def test_successful_parse_returns_empty_errors(self):
        """Successful full parse returns ParseResult with empty errors."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis

        parse_result = parse_hypothesis("E[x | y = 1] > 0")
        assert not parse_result.is_partial
        assert parse_result.errors == []
        assert parse_result.hypothesis.type == "hypothesis"
        assert parse_result.hypothesis.event.type == "comparison"

    def test_parse_result_to_dict(self):
        """parse_result_to_dict serializes both hypothesis and errors."""
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, parse_result_to_dict

        parse_result = parse_hypothesis("$$$ > 5")
        d = parse_result_to_dict(parse_result)

        assert "hypothesis" in d
        assert "errors" in d
        assert isinstance(d["errors"], list)
        assert len(d["errors"]) > 0


class TestAnalysisState:
    """Tests for the AnalysisState model."""

    def test_default_state(self):
        from guidepost.campsite_lib.utils import AnalysisState

        state = AnalysisState()

        assert state.stage == "conversation"
        assert state.initialUserQuestion == ""
        assert state.clarifications == []
        assert state.turns == 0
        assert state.waitingForUser == False
        assert state.substage == "none"

    def test_state_with_values(self):
        from guidepost.campsite_lib.utils import AnalysisState

        state = AnalysisState(
            stage="hypothesis",
            initialUserQuestion="Is X > Y?",
            clarifications=["Yes", "No"],
            turns=3,
        )

        assert state.stage == "hypothesis"
        assert state.initialUserQuestion == "Is X > Y?"
        assert len(state.clarifications) == 2
        assert state.turns == 3

    def test_state_serialization(self):
        from guidepost.campsite_lib.utils import AnalysisState

        state = AnalysisState(
            stage="artifactgen",
            hypothesis="E[x] > 0",
        )

        # Should serialize to JSON
        json_str = state.model_dump_json()
        data = json.loads(json_str)

        assert data["stage"] == "artifactgen"
        assert data["hypothesis"] == "E[x] > 0"


class TestContracts:
    """Tests for artifact contracts."""

    def test_code_artifact_contract(self):
        from guidepost.campsite_lib.contracts import code_artifact_contract

        assert code_artifact_contract["uncertainty_estimator"] == "bootstrap"
        assert code_artifact_contract["n_draws"] == 1000

    def test_vis_artifact_contract(self):
        from guidepost.campsite_lib.contracts import vis_artifact_contract

        assert vis_artifact_contract["output_format"] == "vega_lite"
        assert "density_plot" in vis_artifact_contract["allowed_chart_types"]
        assert "axes" in vis_artifact_contract["required_visual_elements"]


class TestIRAst:
    """Tests for IR AST dataclasses."""

    def test_comparison_const_referent_dataclass(self):
        from guidepost.campsite_lib.ir_ast import Hypothesis, Comparison, Expectation, Predicate, Const

        pred = Predicate(type="predicate", kind="comparison", attr="y", comparator="=", value=1)
        exp = Expectation(type="expectation", attr="x", predicate=pred)
        ref = Const(type="const", value=0)
        comp = Comparison(type="comparison", quantity=exp, comparator=">", referent=ref)
        hyp = Hypothesis(type="hypothesis", event=comp)

        assert hyp.type == "hypothesis"
        assert hyp.event.type == "comparison"
        assert hyp.event.quantity.attr == "x"
        assert hyp.event.referent.value == 0

    def test_comparison_quantity_referent_dataclass(self):
        from guidepost.campsite_lib.ir_ast import Hypothesis, Comparison, Expectation, Predicate

        pred1 = Predicate(type="predicate", kind="comparison", attr="g", comparator="=", value=1)
        pred2 = Predicate(type="predicate", kind="comparison", attr="g", comparator="=", value=0)
        lhs = Expectation(type="expectation", attr="x", predicate=pred1)
        rhs = Expectation(type="expectation", attr="x", predicate=pred2)
        comp = Comparison(type="comparison", quantity=lhs, comparator=">", referent=rhs)
        hyp = Hypothesis(type="hypothesis", event=comp)

        assert hyp.type == "hypothesis"
        assert hyp.event.type == "comparison"
        assert hyp.event.quantity.attr == "x"
        assert hyp.event.referent.attr == "x"

    def test_comparison_with_predicate_dataclass(self):
        from guidepost.campsite_lib.ir_ast import Comparison, Expectation, Predicate, Const

        pred = Predicate(type="predicate", kind="comparison", attr="a", comparator="=", value=1)
        exp = Expectation(type="expectation", attr="x", predicate=pred)
        event_pred = Predicate(type="predicate", kind="comparison", attr="b", comparator="=", value=2)
        comp = Comparison(type="comparison", quantity=exp, comparator=">", referent=Const(value=0), predicate=event_pred)

        assert comp.predicate.attr == "b"
        assert comp.predicate.value == 2

    def test_unspecified_dataclass(self):
        from guidepost.campsite_lib.ir_ast import Comparison, Expectation, Predicate, Unspecified

        pred = Predicate(type="predicate", kind="comparison", attr="a", comparator="=", value=1)
        exp = Expectation(type="expectation", attr="x", predicate=pred)
        comp = Comparison(type="comparison", quantity=exp, comparator=">", referent=Unspecified())

        assert comp.referent.type == "unspecified"

    def test_conjunction_predicate_dataclass(self):
        from guidepost.campsite_lib.ir_ast import Predicate

        p1 = Predicate(type="predicate", kind="comparison", attr="a", comparator="=", value=1)
        p2 = Predicate(type="predicate", kind="comparison", attr="b", comparator="=", value=2)
        conj = Predicate(type="predicate", kind="conjunction", lhs=p1, rhs=p2)

        assert conj.kind == "conjunction"
        assert conj.lhs.attr == "a"
        assert conj.rhs.attr == "b"

    def test_error_node(self):
        from guidepost.campsite_lib.ir_ast import ErrorNode

        err = ErrorNode(
            type="error",
            boundary="event",
            message="Test error",
            text="bad input",
            start=0,
            end=9,
        )

        assert err.type == "error"
        assert err.boundary == "event"
        assert err.message == "Test error"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

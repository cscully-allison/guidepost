"""Tests for the Campsite Python backend."""

import pytest
import json


class TestIRParser:
    """Tests for the hypothesis IR parser."""

    def test_parse_simple_expectation(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        result = parse_hypothesis("E[x | y = 1] > 0")
        d = hypothesis_to_dict(result)

        assert d["type"] == "hypothesis"
        assert d["event"]["type"] == "comparison"
        assert d["event"]["quantity"]["type"] == "expectation"
        assert d["event"]["quantity"]["attr"] == "x"
        assert d["event"]["quantity"]["predicate"]["attr"] == "y"
        assert d["event"]["quantity"]["predicate"]["comparator"] == "="
        assert d["event"]["quantity"]["predicate"]["value"] == 1.0
        assert d["event"]["comparator"] == ">"
        assert d["event"]["reference"]["value"] == 0.0

    def test_parse_contrast(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        result = parse_hypothesis("E[x | g = 1] - E[x | g = 0] > 0")
        d = hypothesis_to_dict(result)

        assert d["type"] == "hypothesis"
        assert d["event"]["quantity"]["type"] == "contrast"
        assert d["event"]["quantity"]["left"]["type"] == "expectation"
        assert d["event"]["quantity"]["right"]["type"] == "expectation"
        assert d["event"]["quantity"]["op"] == "-"

    def test_parse_rv(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        result = parse_hypothesis("bootstrap(E[x | y = 1]) BETWEEN (0, 1)")
        d = hypothesis_to_dict(result)

        assert d["type"] == "hypothesis"
        assert d["event"]["quantity"]["type"] == "rv"
        assert d["event"]["quantity"]["distribution"] == "bootstrap"
        assert d["event"]["quantity"]["estimand"]["type"] == "expectation"
        assert d["event"]["comparator"] == "BETWEEN"
        assert d["event"]["reference"]["value"] == [0.0, 1.0]

    def test_parse_string_predicate(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        result = parse_hypothesis('E[salary | dept = "Engineering"] > 50000')
        d = hypothesis_to_dict(result)

        assert d["event"]["quantity"]["predicate"]["value"] == "Engineering"
        assert d["event"]["reference"]["value"] == 50000.0

    def test_parse_boolean_predicate(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        result = parse_hypothesis("E[failure | flag = true] / E[failure | flag = false] > 1")
        d = hypothesis_to_dict(result)

        assert d["type"] == "hypothesis"
        assert d["event"]["quantity"]["type"] == "contrast"
        assert d["event"]["quantity"]["left"]["predicate"]["value"] is True
        assert d["event"]["quantity"]["right"]["predicate"]["value"] is False
        assert d["event"]["quantity"]["op"] == "/"

    def test_parse_error_returns_error_node(self):
        from guidepost.campsite_lib.ir_parser import parse_hypothesis, hypothesis_to_dict

        result = parse_hypothesis("invalid hypothesis string without structure")
        d = hypothesis_to_dict(result)

        assert d["type"] == "hypothesis"
        assert d["event"]["type"] == "error"
        assert "Parse error" in d["event"]["message"]


class TestSICheckers:
    """Tests for semantic invariant checkers."""

    def test_well_formed_valid(self):
        from guidepost.campsite_lib.si_checkers import HypWellFormed

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation", "attr": "x", "predicate": {}},
                "comparator": ">",
                "reference": {"type": "const", "value": 0},
            },
        }

        checker = HypWellFormed(id="WF", appliesTo="IR")
        violations = checker.check(ir=ir)

        # Should have no WF-1 or WF-2 violations
        wf1_violations = [v for v in violations if v.invariantID == "WF-1"]
        wf2_violations = [v for v in violations if v.invariantID == "WF-2"]
        assert len(wf1_violations) == 0
        assert len(wf2_violations) == 0

    def test_well_formed_missing_event(self):
        from guidepost.campsite_lib.si_checkers import HypWellFormed

        ir = {"type": "hypothesis", "event": {}}

        checker = HypWellFormed(id="WF", appliesTo="IR")
        violations = checker.check(ir=ir)

        # Should have WF-1 violation
        wf1_violations = [v for v in violations if v.invariantID == "WF-1"]
        assert len(wf1_violations) == 1

    def test_well_formed_invalid_comparator(self):
        from guidepost.campsite_lib.si_checkers import HypWellFormed

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "expectation"},
                "comparator": "~~",  # Invalid
                "reference": {"type": "const", "value": 0},
            },
        }

        checker = HypWellFormed(id="WF", appliesTo="IR")
        violations = checker.check(ir=ir)

        # Should have WF-2 violation
        wf2_violations = [v for v in violations if v.invariantID == "WF-2"]
        assert len(wf2_violations) == 1

    def test_structure_preserved_missing_estimand(self):
        from guidepost.campsite_lib.si_checkers import StructurePreserved

        ir = {
            "type": "hypothesis",
            "event": {
                "type": "comparison",
                "quantity": {"type": "rv", "distribution": "bootstrap"},  # Missing estimand
                "comparator": ">",
                "reference": {"type": "const", "value": 0},
            },
        }

        checker = StructurePreserved(id="STR", appliesTo="IR")
        violations = checker.check(ir=ir)

        # Should have STR-1 violation
        str1_violations = [v for v in violations if v.invariantID == "STR-1"]
        assert len(str1_violations) == 1


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

    def test_hypothesis_dataclass(self):
        from guidepost.campsite_lib.ir_ast import Hypothesis, Comparison, Expectation, Predicate, Const

        pred = Predicate(type="predicate", kind="comparison", attr="y", comparator="=", value=1)
        exp = Expectation(type="expectation", attr="x", predicate=pred)
        ref = Const(type="const", value=0)
        comp = Comparison(type="comparison", quantity=exp, comparator=">", reference=ref)
        hyp = Hypothesis(type="hypothesis", event=comp)

        assert hyp.type == "hypothesis"
        assert hyp.event.type == "comparison"
        assert hyp.event.quantity.attr == "x"

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

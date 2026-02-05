"""AST dataclasses for the hypothesis intermediate representation."""

from dataclasses import dataclass, field
from typing import Union, Literal, Optional


# ---------- Constants ----------
@dataclass
class Const:
    """Constant value node."""

    type: Literal["const"] = "const"
    value: Union[int, float, str, tuple[float, float]] = 0


ConstValue = Union[int, float, str, tuple[float, float]]


# ---------- Error Handling ----------
@dataclass
class ErrorNode:
    """Error node for malformed input."""

    type: Literal["error"] = "error"
    boundary: Literal["quantity", "estimand", "predicate", "expr", "const", "event", "comparator"] = "event"
    message: str = ""
    text: str = ""
    start: int = 0
    end: int = 0


# ---------- Predicates ----------
@dataclass
class Predicate:
    """Predicate for conditional expressions."""

    type: Literal["predicate"] = "predicate"
    kind: Literal["comparison"] = "comparison"
    attr: str = ""
    comparator: str = "="
    value: ConstValue = 0


# ---------- Variables ----------
@dataclass
class AttrVar:
    """Attribute variable reference."""

    type: Literal["attr"] = "attr"
    name: str = ""


@dataclass
class ConstVar:
    """Constant variable."""

    type: Literal["const"] = "const"
    value: ConstValue = 0


Var = Union[AttrVar, ConstVar]


# ---------- Expressions ----------
@dataclass
class FuncCall:
    """Function call expression."""

    type: Literal["func"] = "func"
    name: str = ""
    args: list = field(default_factory=list)


@dataclass
class BinaryExpr:
    """Binary expression."""

    type: Literal["binary"] = "binary"
    left: "Expr" = None
    op: Literal["+", "-", "*", "/"] = "+"
    right: "Expr" = None


Expr = Union[AttrVar, ConstVar, FuncCall, BinaryExpr, ErrorNode]


# ---------- Estimands ----------
@dataclass
class Expectation:
    """Expectation estimand E[attr | predicate]."""

    type: Literal["expectation"] = "expectation"
    attr: str = ""
    predicate: Union[Predicate, ErrorNode] = None


@dataclass
class Contrast:
    """Contrast between two expectations."""

    type: Literal["contrast"] = "contrast"
    left: Union[Expectation, ErrorNode] = None
    op: Literal["+", "-", "*", "/"] = "-"
    right: Union[Expectation, ErrorNode] = None


Estimand = Union[Contrast, Expectation, ErrorNode]


# ---------- Uncertainty ----------
@dataclass
class RV:
    """Random variable wrapping an estimand."""

    type: Literal["rv"] = "rv"
    distribution: str = ""
    estimand: Estimand = None


# ---------- Quantities ----------
Quantity = Union[RV, Estimand, Expr, ErrorNode]


# ---------- Events ----------
@dataclass
class Comparison:
    """Comparison event."""

    type: Literal["comparison"] = "comparison"
    quantity: Quantity = None
    comparator: str = "="
    reference: Union[Const, ErrorNode] = None


Event = Union[Comparison, ErrorNode]


# ---------- Core ----------
@dataclass
class Hypothesis:
    """Top-level hypothesis node."""

    type: Literal["hypothesis"] = "hypothesis"
    event: Event = None


# ---------- Model extraction ----------
@dataclass
class Extract:
    """Model extraction node."""

    type: Literal["extract"] = "extract"
    model: str = ""
    estimand: Estimand = None


# Valid comparators
VALID_COMPARATORS = frozenset(["=", ">", "<", ">=", "<=", "!=", "BETWEEN", "IN"])

# Function names
FUNC_NAMES = frozenset([
    "AVG", "MAX", "MIN", "SUM", "COUNT",
    "MEDIAN", "VARIANCE", "STDDEV",
    "CORR", "PERCENTILE"
])

# Field operators
FIELD_OPS = frozenset(["+", "-", "*", "/"])

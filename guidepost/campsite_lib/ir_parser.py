"""IR Parser using Lark - converts hypothesis strings to AST."""

from lark import Lark, Transformer, v_args, UnexpectedInput
from .ir_ast import (
    Hypothesis,
    Comparison,
    RV,
    Expectation,
    Contrast,
    Predicate,
    Const,
    AttrVar,
    ConstVar,
    BinaryExpr,
    FuncCall,
    ErrorNode,
)

# Lark grammar translated from Peggy grammar
# Note: Using %import common.WS and %ignore to handle whitespace
GRAMMAR = r"""
    start: event

    event: quantity comparator_or_error const_val -> event_comparison

    quantity: rv
            | estimand
            | expr

    rv: IDENTIFIER "(" estimand ")" -> rv_node

    estimand: contrast
            | expectation

    expectation: "E" "[" IDENTIFIER "|" predicate "]" -> expectation_node

    contrast: expectation fop expectation -> contrast_node

    predicate: comparison_predicate

    comparison_predicate: IDENTIFIER comparator_or_error const_value -> predicate_comparison

    expr: binary_expr
        | func_call
        | var

    binary_expr: var fop expr -> binary_node

    func_call: IDENTIFIER "(" expr_list? ")" -> func_node

    expr_list: expr ("," expr)* -> expr_list_node

    var: IDENTIFIER -> attr_var
       | const_value -> const_var

    const_val: const_value -> const_node

    const_value: BOOLEAN -> boolean
              | NUMBER -> number
              | STRING -> string
              | "(" NUMBER "," NUMBER ")" -> tuple_val

    BOOLEAN: "true" | "false"

    comparator_or_error: COMPARATOR -> comparator

    COMPARATOR: ">=" | "<=" | "!=" | ">" | "<" | "=" | "BETWEEN" | "IN"

    fop: FOP
    FOP: "+" | "-" | "*" | "/"

    IDENTIFIER: /[a-zA-Z_][a-zA-Z0-9_]*/
    NUMBER: /[0-9]+(\.[0-9]+)?/
    STRING: /"[^"]*"/

    %import common.WS
    %ignore WS
"""


@v_args(inline=True)
class HypothesisTransformer(Transformer):
    """Transform Lark parse tree to AST dataclasses."""

    def start(self, event):
        return Hypothesis(type="hypothesis", event=event)

    def event_comparison(self, quantity, comparator, reference):
        return Comparison(
            type="comparison",
            quantity=quantity,
            comparator=comparator,
            reference=reference,
        )

    # Pass-through rules for intermediate non-terminals
    def quantity(self, item):
        return item

    def estimand(self, item):
        return item

    def predicate(self, item):
        return item

    def expr(self, item):
        return item

    def rv_node(self, dist, estimand):
        return RV(type="rv", distribution=str(dist), estimand=estimand)

    def expectation_node(self, attr, predicate):
        return Expectation(type="expectation", attr=str(attr), predicate=predicate)

    def contrast_node(self, left, op, right):
        return Contrast(type="contrast", left=left, op=str(op), right=right)

    def predicate_comparison(self, attr, comparator, value):
        return Predicate(
            type="predicate",
            kind="comparison",
            attr=str(attr),
            comparator=comparator,
            value=value,
        )

    def binary_node(self, left, op, right):
        return BinaryExpr(type="binary", left=left, op=str(op), right=right)

    def func_node(self, name, *args):
        arg_list = args[0] if args else []
        return FuncCall(type="func", name=str(name), args=arg_list)

    def expr_list_node(self, *exprs):
        return list(exprs)

    def attr_var(self, name):
        return AttrVar(type="attr", name=str(name))

    def const_var(self, value):
        return ConstVar(type="const", value=value)

    def const_node(self, value):
        return Const(type="const", value=value)

    def boolean(self, b):
        return str(b) == "true"

    def number(self, n):
        return float(n)

    def string(self, s):
        # Remove quotes from string
        s_str = str(s)
        if s_str.startswith('"') and s_str.endswith('"'):
            return s_str[1:-1]
        return s_str

    def tuple_val(self, a, b):
        return (float(a), float(b))

    def comparator(self, c):
        return str(c)

    def fop(self, op):
        return str(op)

    def FOP(self, token):
        return str(token)

    def IDENTIFIER(self, token):
        return str(token)

    def NUMBER(self, token):
        return float(token)

    def STRING(self, token):
        return str(token)


# Create parser instance
_parser = None


def get_parser():
    """Get or create the Lark parser instance."""
    global _parser
    if _parser is None:
        _parser = Lark(GRAMMAR, start="start", parser="lalr")
    return _parser


def parse_hypothesis(text: str) -> Hypothesis:
    """
    Parse a hypothesis string into an AST.

    Args:
        text: The hypothesis string to parse

    Returns:
        Hypothesis AST node (may contain ErrorNodes for malformed parts)
    """
    parser = get_parser()
    transformer = HypothesisTransformer()

    try:
        tree = parser.parse(text)
        return transformer.transform(tree)
    except UnexpectedInput as e:
        # Return a hypothesis with error event
        return Hypothesis(
            type="hypothesis",
            event=ErrorNode(
                type="error",
                boundary="event",
                message=f"Parse error: {str(e)}",
                text=text,
                start=e.pos_in_stream if hasattr(e, "pos_in_stream") else 0,
                end=len(text),
            ),
        )
    except Exception as e:
        # Fallback for other errors
        return Hypothesis(
            type="hypothesis",
            event=ErrorNode(
                type="error",
                boundary="event",
                message=f"Parse error: {str(e)}",
                text=text,
            ),
        )


def hypothesis_to_dict(h) -> dict:
    """Convert a hypothesis AST to a dictionary for JSON serialization."""
    if hasattr(h, "__dataclass_fields__"):
        result = {}
        for field_name in h.__dataclass_fields__:
            value = getattr(h, field_name)
            result[field_name] = hypothesis_to_dict(value)
        return result
    elif isinstance(h, list):
        return [hypothesis_to_dict(item) for item in h]
    elif isinstance(h, tuple):
        return list(h)
    else:
        return h

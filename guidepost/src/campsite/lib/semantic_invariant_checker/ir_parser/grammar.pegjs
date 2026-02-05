{
  function loc(node) { return node; }

  function errorNode(boundary, message, start, end, text) {
    return {
      type: "error",
      boundary,
      message,
      text,
      start,
      end
    };
  }
}

Hypothesis
  = _ e:Event _ {
      return { type: "hypothesis", event: e };
    }

Event
  = q:Quantity _ c:ComparatorOrError _ r:Const {
      return {
        type: "comparison",
        quantity: q,
        comparator: c,
        reference: r
      };
    }
  / s:$(.+) {
      const loc = location();
      return errorNode(
        "event",
        "Invalid event structure",
        loc.start.offset,
        loc.end.offset,
        s
      );
    }

Quantity
  = RV
  / Estimand
  / Expr
  / q:$(!Comparator .)+ {
      const loc = location();
      return errorNode(
        "quantity",
        "Invalid quantity",
        loc.start.offset,
        loc.end.offset,
        q.trim()
      );
    }

RV
  = d:Identifier "(" _ e:Estimand _ ")" {
      return {
        type: "rv",
        distribution: d,
        estimand: e
      };
    }

Estimand
  = Contrast
  / Expectation
  / e:$(!(")" / Comparator) .)+ {
      const loc = location();
      return errorNode(
        "estimand",
        "Invalid estimand",
        loc.start.offset,
        loc.end.offset,
        e.trim()
      );
    }

Expectation
  = "E" "[" _ a:Identifier _ "|" _ p:Predicate _ "]" {
      return {
        type: "expectation",
        attr: a,
        predicate: p
      };
    }
  / e:$(!")" .)+ {
      const loc = location();
      return errorNode(
        "expectation",
        "Expectatiton error",
        loc.start.offset,
        loc.end.offset,
        e.trim()
      );
    }

Contrast
  = l:Expectation _ op:FOp _ r:Expectation {
      return {
        type: "contrast",
        left: l,
        op,
        right: r
      };
    }

Predicate
  = ComparisonPredicate
  / InvalidPredicate
  

ComparisonPredicate 
  = &CompleteComparison
    a:Identifier _ c:ComparatorOrError _ v:ConstValue {
      return {
        type: "predicate",
        kind: "comparison",
        attr: a,
        comparator: c,
        value: v
      };
    }

CompleteComparison
  = Identifier _ ComparatorOrError _ ConstValue

InvalidPredicate
  = p:$(!"]" .)+ {
      const loc = location();
      return errorNode(
        "predicate",
        "Invalid predicate",
        loc.start.offset,
        loc.end.offset,
        p.trim()
      );
    }

Expr
  = BinaryExpr
  / FuncCall
  / Var
  / e:$(!("]" / Comparator) .)+ {
      const loc = location();
      return errorNode(
        "expr",
        "Invalid expression",
        loc.start.offset,
        loc.end.offset,
        e.trim()
      );
    }

BinaryExpr
  = l:Var _ op:FOp _ r:Expr {
      return { type: "binary", left: l, op, right: r };
    }

FuncCall
  = f:Identifier "(" _ args:ExprList? _ ")" {
      return {
        type: "func",
        name: f,
        args: args ?? []
      };
    }

ExprList
  = h:Expr t:(_ "," _ Expr)* {
      return [h, ...t.map(x => x[3])];
    }

Var
  = Identifier {
      return { type: "attr", name: text() };
    }
  / ConstValue {
      return { type: "const", value: $1 };
    }

Const
  = v:ConstValue {
      return { type: "const", value: v };
    }
  / c:$(!("]" / Comparator) .)+ {
      const loc = location();
      return errorNode(
        "const",
        "Invalid constant",
        loc.start.offset,
        loc.end.offset,
        c.trim()
      );
    }

ConstValue
  = n:Number { return n; }
  / s:String { return s; }
  / "(" _ a:Number _ "," _ b:Number _ ")" {
      return [a, b];
    }

ComparatorOrError
  = Comparator /
    InvalidComparator

Comparator
  = ">=" / "<=" / "!=" / ">" / "<" / "=" / "BETWEEN" / "IN" 

InvalidComparator
  = op:$(
      !Comparator
      [<>=!~]+
    ) {
      const loc = location();
      return errorNode(
        "comparator",
        "Invalid comparator",
        loc.start.offset,
        loc.end.offset,
        op
      );
    }

FOp
  = "+" / "-" / "*" / "/"

Identifier
  = $([a-zA-Z_][a-zA-Z0-9_]*)

Number
  = $([0-9]+ ("." [0-9]+)?) {
      return parseFloat(text());
    }

String
  = "\"" chars:([^"]*) "\"" {
      return chars.join("");
    }

_ = [ \t\n\r]*
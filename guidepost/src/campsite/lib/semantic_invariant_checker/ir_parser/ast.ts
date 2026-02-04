// ---------- ERROR Handling ---------

export type ErrorNode = {
  type: "error";
  boundary:
    | "quantity"
    | "estimand"
    | "predicate"
    | "expr"
    | "const"
    | "event";
  message: string;
  text: string;
  start: number;
  end: number;
};


// ---------- Core ----------
export type Hypothesis = {
  type: "hypothesis";
  event: Event;
};

export type Event = Comparison;

export type Comparison = {
  type: "comparison";
  quantity: Quantity;
  comparator: Comparator;
  reference: Const;
};

export type Comparator =
  | ">" | "<" | "=" | ">=" | "<=" | "!="
  | "BETWEEN" | "IN";

// ---------- Quantities ----------
export type Quantity =
  | RV
  | Estimand
  | Expr;

// ---------- Uncertainty ----------
export type RV = {
  type: "rv";
  distribution: string;
  estimand: Estimand;
};

// ---------- Estimands ----------
export type Estimand =
  | Contrast
  | Expectation;


export type Expectation = {
  type: "expectation";
  attr: string;
  predicate: Predicate;
} | Var;

export type Contrast = {
  type: "contrast";
  left: Expectation;
  op: FOp;
  right: Expectation;
};

// ---------- Expressions ----------
export type Expr =
  | Var
  | FuncCall
  | BinaryExpr
  | Extract;

export type Var =
  | { type: "attr"; name: string }
  | { type: "const"; value: ConstValue };

export type FuncCall = {
  type: "func";
  name: FuncName;
  args: Expr[];
};

export type BinaryExpr = {
  type: "binary";
  left: Expr;
  op: FOp;
  right: Expr;
};

export type FOp = "+" | "-" | "*" | "/";

export type FuncName =
  | "AVG" | "MAX" | "MIN" | "SUM" | "COUNT"
  | "MEDIAN" | "VARIANCE" | "STDDEV"
  | "CORR" | "PERCENTILE";

// ---------- Predicates ----------
export type Predicate = {
  type: "predicate";
  attr: string;
  comparator: Comparator;
  value: ConstValue;
};

// ---------- Constants ----------
export type Const = {
  type: "const";
  value: ConstValue;
};

export type ConstValue =
  | number
  | string
  | [number, number];


// ---------- Model extraction ----------
export type Extract = {
  type: "extract";
  model: string;
  estimand: Estimand;
};
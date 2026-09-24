import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  analyzeFormulaTypes,
  blank,
  bool,
  configureFunctions,
  error,
  FunctionRegistry,
  number,
  parseSync,
  scalar,
  toNumber,
  toText,
} from "../src/index.js";

const analyze = (formula: string, types: Parameters<typeof analyzeFormulaTypes>[1] = {}) =>
  Effect.runSync(analyzeFormulaTypes(parseSync(formula), types));

describe("AST type analysis", () => {
  it("infers numeric arithmetic and comparison results", () => {
    expect(
      analyze("=[price]*[quantity]", { "field:price": "Number", "field:quantity": "Number" }),
    ).toEqual({
      types: ["Number"],
      diagnostics: [],
    });
    expect(analyze("=[price]>0", { "field:price": "Number" })).toEqual({
      types: ["Boolean"],
      diagnostics: [],
    });
  });

  it("separates possible text coercion from a definitely invalid literal", () => {
    expect(analyze("=[price]*2", { "field:price": "Text" })).toEqual({
      types: ["Error", "Number"],
      diagnostics: [
        {
          path: "root.left",
          severity: "possible",
          message: "Cannot guarantee conversion to Number",
        },
      ],
    });
    expect(analyze('="12"*2')).toEqual({ types: ["Number"], diagnostics: [] });
    expect(analyze('="bad"*2')).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root.left",
          severity: "definite",
          message: "Cannot guarantee conversion to Number",
        },
      ],
    });
  });

  it("unions IF branches and diagnoses an invalid condition", () => {
    expect(analyze('=IF([flag];1;"no")', { "field:flag": "Boolean" })).toEqual({
      types: ["Number", "Text"],
      diagnostics: [],
    });
    expect(analyze('=IF([flag];1;"no")', { "field:flag": "Text" })).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root.args[0]",
          severity: "definite",
          message: "Cannot guarantee conversion to Boolean",
        },
      ],
    });
    expect(analyze("=IF([flag];1)", { "field:flag": "Boolean" })).toEqual({
      types: ["Number", "Boolean"],
      diagnostics: [],
    });
    expect(analyze("=IF(FALSE();[missing];42)")).toEqual({
      types: ["Number"],
      diagnostics: [],
    });
  });

  it("tracks IFERROR's fallback without assuming arithmetic cannot fail", () => {
    expect(analyze("=IFERROR(#N/A;9)")).toEqual({ types: ["Number"], diagnostics: [] });
    expect(analyze("=IFERROR(1;[missing])")).toEqual({ types: ["Number"], diagnostics: [] });
    expect(analyze('=IFERROR(1/0;"fallback")')).toEqual({
      types: ["Number", "Text"],
      diagnostics: [],
    });
    expect(analyze('=IFERROR([maybe];"fallback")', { "field:maybe": ["Number", "Error"] })).toEqual(
      {
        types: ["Number", "Text"],
        diagnostics: [],
      },
    );
    expect(analyze("=IFERROR(1)")).toEqual({
      types: ["Error"],
      diagnostics: [{ path: "root", severity: "definite", message: "IFERROR expects 2 arguments" }],
    });
  });

  it("narrows CHOOSE for a literal index and unions dynamic choices", () => {
    expect(analyze("=CHOOSE(2;[missing];42)")).toEqual({
      types: ["Number"],
      diagnostics: [],
    });
    expect(analyze('=CHOOSE([index];1;"x")', { "field:index": "Number" })).toEqual({
      types: ["Error", "Number", "Text"],
      diagnostics: [],
    });
    expect(analyze("=CHOOSE(3;1;2)")).toEqual({
      types: ["Error"],
      diagnostics: [
        { path: "root.args[0]", severity: "definite", message: "CHOOSE index is out of range" },
      ],
    });
  });

  it("keeps missing declarations and unsupported functions unknown", () => {
    expect(analyze("=[price]+1")).toEqual({
      types: ["Unknown"],
      diagnostics: [
        { path: "root.left", severity: "possible", message: "No declared type for field:price" },
      ],
    });
    expect(analyze("=CUSTOM([price])", { "field:price": "Number" })).toEqual({
      types: ["Unknown"],
      diagnostics: [],
    });
  });

  it("identifies a range used as a scalar", () => {
    expect(analyze("=A1:A2+1")).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root.left",
          severity: "definite",
          message: "Cannot guarantee conversion to Number",
        },
      ],
    });
  });

  it("checks the signatures of selected built-in functions", () => {
    expect(analyze("=ABS([amount])", { "field:amount": "Number" })).toEqual({
      types: ["Number"],
      diagnostics: [],
    });
    expect(analyze("=LEN(42)")).toEqual({ types: ["Number"], diagnostics: [] });
    expect(analyze('=NOT("yes")')).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root.args[0]",
          severity: "definite",
          message: "Cannot guarantee conversion to Boolean",
        },
      ],
    });
    expect(analyze("=ABS(1;2)")).toEqual({
      types: ["Error"],
      diagnostics: [{ path: "root", severity: "definite", message: "ABS expects 1 argument" }],
    });
  });

  it("analyzes fixed-arity math and text functions", () => {
    expect(analyze("=SQRT(POWER(3;2))")).toEqual({ types: ["Number"], diagnostics: [] });
    expect(analyze('=EXACT(TRIM(" a ");MID("abc";1;1))')).toEqual({
      types: ["Boolean"],
      diagnostics: [],
    });
    expect(analyze('=MOD("bad";2)')).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root.args[0]",
          severity: "definite",
          message: "Cannot guarantee conversion to Number",
        },
      ],
    });
    expect(analyze('=MID("abc";1)')).toEqual({
      types: ["Error"],
      diagnostics: [{ path: "root", severity: "definite", message: "MID expects 3 arguments" }],
    });
  });

  it("keeps error-inspection results Boolean", () => {
    expect(analyze("=ISERROR(NA())")).toEqual({ types: ["Boolean"], diagnostics: [] });
    expect(analyze("=ISNA(#N/A)")).toEqual({ types: ["Boolean"], diagnostics: [] });
    expect(analyze("=ISNUMBER([value])", { "field:value": ["Number", "Error"] })).toEqual({
      types: ["Boolean"],
      diagnostics: [],
    });
    expect(analyze("=PI()")).toEqual({ types: ["Number"], diagnostics: [] });
    expect(analyze("=PI(1)")).toEqual({
      types: ["Error"],
      diagnostics: [{ path: "root", severity: "definite", message: "PI expects 0 arguments" }],
    });
  });

  it("analyzes built-ins with optional trailing arguments", () => {
    expect(analyze('=LEFT("hello")')).toEqual({ types: ["Text"], diagnostics: [] });
    expect(analyze('=RIGHT("hello";2)')).toEqual({ types: ["Text"], diagnostics: [] });
    expect(analyze('=FIND("e";"hello";2)')).toEqual({ types: ["Number"], diagnostics: [] });
    expect(analyze("=ROUND(LOG(100);1)+TRUNC(2.5;0)")).toEqual({
      types: ["Number"],
      diagnostics: [],
    });
    expect(analyze('=LEFT("hello";"bad")')).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root.args[1]",
          severity: "definite",
          message: "Cannot guarantee conversion to Number",
        },
      ],
    });
    expect(analyze('=FIND("e")')).toEqual({
      types: ["Error"],
      diagnostics: [
        { path: "root", severity: "definite", message: "FIND expects 2 to 3 arguments" },
      ],
    });
    expect(analyze("=ROUND(1;2;3)")).toEqual({
      types: ["Error"],
      diagnostics: [
        { path: "root", severity: "definite", message: "ROUND expects 1 to 2 arguments" },
      ],
    });
  });

  it("analyzes numeric aggregates with direct and referenced conversion rules", () => {
    expect(analyze('=SUM(1;"2";TRUE())')).toEqual({ types: ["Number"], diagnostics: [] });
    expect(analyze('=SUM("bad")')).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root.args[0]",
          severity: "definite",
          message: "Cannot guarantee conversion to Number",
        },
      ],
    });
    expect(analyze("=SUM([amount])", { "field:amount": "Text" })).toEqual({
      types: ["Number"],
      diagnostics: [],
    });
    expect(analyze("=SUM(A1:A2)", { "cell:A1": "Number", "cell:A2": "Error" })).toEqual({
      types: ["Error"],
      diagnostics: [],
    });
    expect(analyze("=SUM(A1:A2)", { "cell:A1": "Number", "cell:A2": "Text" })).toEqual({
      types: ["Number"],
      diagnostics: [],
    });
    expect(analyze("=SUM(A1:A2)", { "cell:A1": "Range", "cell:A2": "Number" })).toEqual({
      types: ["Error"],
      diagnostics: [],
    });
    expect(analyze("=SUM([values])", { "field:values": "Range" })).toEqual({
      types: ["Number", "Unknown"],
      diagnostics: [],
    });
    expect(analyze("=AVERAGE(A1:A2)", { "cell:A1": "Text", "cell:A2": "Boolean" })).toEqual({
      types: ["Error"],
      diagnostics: [],
    });
    expect(analyze('=COUNT(#N/A;"bad")')).toEqual({ types: ["Number"], diagnostics: [] });
    expect(analyze("=COUNTA(A1:A2)")).toEqual({ types: ["Number"], diagnostics: [] });
    expect(
      Effect.runSync(
        analyzeFormulaTypes(
          parseSync("=SUM([.A:.A])"),
          { "cell:A1": "Number", "cell:A2": "Number" },
          { grid: { rows: 2, columns: 1 } },
        ),
      ),
    ).toEqual({ types: ["Number"], diagnostics: [] });
  });

  it("uses signatures and removals from the runtime function profile", () => {
    const profile = configureFunctions({
      register: {
        DOUBLE: ([value]) => {
          const converted = toNumber(scalar(value ?? blank));
          return Effect.succeed(
            converted._tag === "Error" ? converted : number(converted.value * 2),
          );
        },
        ABS: ([value]) => Effect.succeed(toText(scalar(value ?? blank))),
        OPTIONAL: (args) =>
          Effect.succeed(args.length >= 1 && args.length <= 2 ? bool(true) : error("#VALUE!")),
      },
      signatures: {
        double: { parameters: ["Number"], returns: "Number" },
        abs: { parameters: ["Text"], returns: "Text" },
        optional: { parameters: ["Number"], optionalParameters: ["Text"], returns: "Boolean" },
      },
      remove: ["LEN"],
    });
    const results = Effect.gen(function* () {
      const registry = yield* FunctionRegistry;
      return [
        yield* analyzeFormulaTypes(
          parseSync("=DOUBLE([amount])"),
          { "field:amount": "Text" },
          registry,
        ),
        yield* analyzeFormulaTypes(parseSync("=ABS(1)"), {}, registry),
        yield* analyzeFormulaTypes(parseSync("=LEN(1)"), {}, registry),
        yield* analyzeFormulaTypes(parseSync('=OPTIONAL(1;"x")'), {}, registry),
        yield* analyzeFormulaTypes(parseSync("=OPTIONAL(1)"), {}, registry),
        yield* analyzeFormulaTypes(parseSync("=OPTIONAL()"), {}, registry),
      ];
    }).pipe(Effect.provide(profile));
    expect(Effect.runSync(results)).toEqual([
      {
        types: ["Error", "Number"],
        diagnostics: [
          {
            path: "root.args[0]",
            severity: "possible",
            message: "Cannot guarantee conversion to Number",
          },
        ],
      },
      { types: ["Text"], diagnostics: [] },
      { types: ["Error"], diagnostics: [] },
      { types: ["Boolean"], diagnostics: [] },
      { types: ["Boolean"], diagnostics: [] },
      {
        types: ["Error"],
        diagnostics: [
          { path: "root", severity: "definite", message: "OPTIONAL expects 1 to 2 arguments" },
        ],
      },
    ]);
  });
});

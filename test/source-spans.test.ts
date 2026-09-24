import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  analyzeFormulaTypes,
  emptyFunctions,
  evaluate,
  memory,
  number,
  parseSync,
} from "../src/index.js";

describe("opt-in AST source spans", () => {
  it("points to literals, references, ranges, calls, and operators", () => {
    const formula = '=SUM(A1:B2;[.C3];"a""b")*2';
    const ast = parseSync(formula, { captureSpans: true });
    expect(ast.span).toEqual({ start: 1, end: formula.length });
    if (ast._tag !== "Binary" || ast.left._tag !== "Call") throw new Error("Unexpected AST");
    const call = ast.left;
    expect(formula.slice(call.span!.start, call.span!.end)).toBe('SUM(A1:B2;[.C3];"a""b")');
    expect(call.args.map((arg) => formula.slice(arg.span!.start, arg.span!.end))).toEqual([
      "A1:B2",
      "[.C3]",
      '"a""b"',
    ]);
    expect(formula.slice(ast.right.span!.start, ast.right.span!.end)).toBe("2");
  });

  it("accounts for formula prefixes, parentheses, and missing arguments", () => {
    const formula = "==IF(TRUE();;(-2))";
    const ast = parseSync(formula, { captureSpans: true });
    if (ast._tag !== "Call") throw new Error("Unexpected AST");
    expect(ast.span).toEqual({ start: 2, end: formula.length });
    expect(ast.args[1]?.span).toEqual({ start: 12, end: 12 });
    expect(formula.slice(ast.args[2]!.span!.start, ast.args[2]!.span!.end)).toBe("(-2)");
    expect(parseSync("=[price]")).toEqual({ _tag: "Reference", key: "field:price" });
  });

  it("puts type diagnostics at the offending expression", () => {
    const formula = '="bad"*2';
    const ast = parseSync(formula, { captureSpans: true });
    const result = Effect.runSync(analyzeFormulaTypes(ast, {}));
    expect(result.diagnostics).toEqual([
      {
        path: "root.left",
        severity: "definite",
        message: "Cannot guarantee conversion to Number",
        span: { start: 1, end: 6 },
      },
    ]);
    const arity = Effect.runSync(
      analyzeFormulaTypes(parseSync("=ABS(1;2)", { captureSpans: true }), {}),
    );
    expect(arity.diagnostics[0]?.span).toEqual({ start: 1, end: 9 });
  });

  it("evaluates an AST with spans", async () => {
    const ast = parseSync("=2+3*4", { captureSpans: true });
    const result = await Effect.runPromise(
      evaluate(ast).pipe(Effect.provide(Layer.merge(memory(new Map()), emptyFunctions))),
    );
    expect(result).toEqual(number(14));
  });
});

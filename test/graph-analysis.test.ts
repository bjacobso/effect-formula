import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  analyzeFormulaGraph,
  configureFunctions,
  FunctionRegistry,
  number,
  parseSync,
} from "../src/index.js";

describe("formula graph type analysis", () => {
  it("propagates possible result types through forward references", async () => {
    const formulas = new Map([
      ["field:total", parseSync("=[subtotal]+[tax]")],
      ["field:message", parseSync('=IF([flag];[total];"none")')],
      ["field:subtotal", parseSync("=[price]*[quantity]")],
    ]);
    const graph = await Effect.runPromise(
      analyzeFormulaGraph(formulas, {
        "field:price": "Number",
        "field:quantity": "Number",
        "field:tax": "Number",
        "field:flag": "Boolean",
      }),
    );
    expect(graph.formulas.get("field:subtotal")).toEqual({ types: ["Number"], diagnostics: [] });
    expect(graph.formulas.get("field:total")).toEqual({ types: ["Number"], diagnostics: [] });
    expect(graph.formulas.get("field:message")).toEqual({
      types: ["Number", "Text"],
      diagnostics: [],
    });
    expect(graph.dependencies.get("field:total")).toEqual(["field:subtotal", "field:tax"]);
    expect(graph.cycles).toEqual([]);
  });

  it("passes possible conversion errors to dependent formulas", async () => {
    const formulas = new Map([
      ["field:subtotal", parseSync("=[price]*2")],
      ["field:total", parseSync("=[subtotal]+1")],
    ]);
    const graph = await Effect.runPromise(analyzeFormulaGraph(formulas, { "field:price": "Text" }));
    expect(graph.formulas.get("field:subtotal")?.types).toEqual(["Error", "Number"]);
    expect(graph.formulas.get("field:total")?.types).toEqual(["Error", "Number"]);
  });

  it("uses a registered function signature across formula dependencies", async () => {
    const profile = configureFunctions({
      register: { DOUBLE: () => Effect.succeed(number(2)) },
      signatures: { DOUBLE: { parameters: ["Value"], returns: "Number" } },
    });
    const graph = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* FunctionRegistry;
        return yield* analyzeFormulaGraph(
          new Map([
            ["field:after", parseSync("=[computed]+1")],
            ["field:computed", parseSync("=DOUBLE([input])")],
          ]),
          { "field:input": "Text" },
          {},
          registry,
        );
      }).pipe(Effect.provide(profile)),
    );
    expect(graph.formulas.get("field:computed")?.types).toEqual(["Number"]);
    expect(graph.formulas.get("field:after")?.types).toEqual(["Number"]);
  });

  it("propagates built-in function types through formula dependencies", async () => {
    const graph = await Effect.runPromise(
      analyzeFormulaGraph(
        new Map([
          ["field:root", parseSync("=SQRT([length])")],
          ["field:length", parseSync("=LEN([trimmed])")],
          ["field:trimmed", parseSync("=TRIM([name])")],
        ]),
        { "field:name": "Text" },
      ),
    );
    expect(graph.formulas.get("field:trimmed")).toEqual({ types: ["Text"], diagnostics: [] });
    expect(graph.formulas.get("field:length")).toEqual({ types: ["Number"], diagnostics: [] });
    expect(graph.formulas.get("field:root")).toEqual({ types: ["Number"], diagnostics: [] });
  });

  it("propagates IFERROR and CHOOSE result categories", async () => {
    const graph = await Effect.runPromise(
      analyzeFormulaGraph(
        new Map([
          ["field:display", parseSync('=CHOOSE([choice];[safe];"none")')],
          ["field:safe", parseSync("=IFERROR([raw];0)")],
        ]),
        { "field:choice": "Number", "field:raw": ["Number", "Error"] },
      ),
    );
    expect(graph.formulas.get("field:safe")?.types).toEqual(["Number"]);
    expect(graph.formulas.get("field:display")?.types).toEqual(["Error", "Number", "Text"]);
  });

  it("infers SUM over formula cells", async () => {
    const graph = await Effect.runPromise(
      analyzeFormulaGraph(
        new Map([
          ["cell:B1", parseSync("=SUM(A1:A2)")],
          ["cell:A1", parseSync("=2")],
        ]),
        { "cell:A2": "Number" },
      ),
    );
    expect(graph.dependencies.get("cell:B1")).toEqual(["cell:A1", "cell:A2"]);
    expect(graph.formulas.get("cell:B1")?.types).toEqual(["Number"]);
  });

  it("passes grid bounds through range input and type analysis", async () => {
    const graph = await Effect.runPromise(
      analyzeFormulaGraph(
        new Map([["cell:B1", parseSync("=SUM([.A:.A])")]]),
        { "cell:A1": "Number", "cell:A2": "Number" },
        { grid: { rows: 2, columns: 2 } },
      ),
    );
    expect(graph.dependencies.get("cell:B1")).toEqual(["cell:A1", "cell:A2"]);
    expect(graph.formulas.get("cell:B1")?.types).toEqual(["Number"]);
  });

  it("marks cycle members and propagates their error downstream", async () => {
    const formulas = new Map([
      ["field:after", parseSync("=[a]+1")],
      ["field:a", parseSync("=[b]+1", { captureSpans: true })],
      ["field:b", parseSync("=[a]+1", { captureSpans: true })],
    ]);
    const graph = await Effect.runPromise(analyzeFormulaGraph(formulas, {}));
    expect(graph.cycles).toEqual([["field:a", "field:b"]]);
    expect(graph.formulas.get("field:a")).toEqual({
      types: ["Error"],
      diagnostics: [
        {
          path: "root",
          severity: "definite",
          message: "Cyclic formula dependency",
          span: { start: 1, end: 6 },
        },
      ],
    });
    expect(graph.formulas.get("field:b")?.types).toEqual(["Error"]);
    expect(graph.formulas.get("field:after")?.types).toEqual(["Error"]);
  });

  it("conservatively reports a cycle in a skipped IF branch", async () => {
    const graph = await Effect.runPromise(
      analyzeFormulaGraph(new Map([["field:self", parseSync("=IF(FALSE();[self];1)")]]), {}),
    );
    expect(graph.cycles).toEqual([["field:self"]]);
    expect(graph.formulas.get("field:self")?.types).toEqual(["Error"]);
  });

  it("reports undeclared inputs and rejects unbounded ranges", async () => {
    const unknown = await Effect.runPromise(
      analyzeFormulaGraph(new Map([["field:total", parseSync("=[missing]+1")]]), {}),
    );
    expect(unknown.formulas.get("field:total")).toEqual({
      types: ["Unknown"],
      diagnostics: [
        { path: "root.left", severity: "possible", message: "No declared type for field:missing" },
      ],
    });
    const unbounded = await Effect.runPromise(
      Effect.either(analyzeFormulaGraph(new Map([["cell:B1", parseSync("=SUM([.A:.A])")]]), {})),
    );
    expect(Either.isLeft(unbounded)).toBe(true);
  });
});

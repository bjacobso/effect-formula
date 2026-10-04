import { Context, Data, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  bool,
  createForm,
  defineFormulaFunction,
  evaluate,
  FunctionRegistry,
  memory,
  number,
  parseSync,
  ReferenceResolver,
  typedFormula,
  type Value,
} from "../src/index.js";

const triple = defineFormulaFunction("TRIPLE", [Schema.Number] as const, Schema.Number, ([value]) =>
  Effect.succeed(value * 3),
);
const f = typedFormula(
  {
    price: Schema.Number,
    quantity: Schema.Number,
    discounted: Schema.Boolean,
    label: Schema.String,
  },
  [triple],
);
const product = f.multiply(f.ref("price"), f.ref("quantity"));
const built = f.if(f.ref("discounted"), f.call(triple, product), product);
const parsed = f.parse("=IF([discounted];TRIPLE([price]*[quantity]);[price]*[quantity])");
class Scale extends Context.Tag("typed-formula-test/Scale")<Scale, { readonly factor: number }>() {}
class ScaleFailure extends Data.TaggedError("ScaleFailure")<{ readonly reason: string }> {}
const scale = defineFormulaFunction("SCALE", [Schema.Number] as const, Schema.Number, ([value]) =>
  Effect.flatMap(Scale, ({ factor }) =>
    factor > 0
      ? Effect.succeed(value * factor)
      : Effect.fail(new ScaleFailure({ reason: "factor must be positive" })),
  ),
);
const services = Layer.merge(
  memory(
    new Map<string, Value>([
      ["field:price", number(12)],
      ["field:quantity", number(3)],
      ["field:discounted", bool(true)],
    ]),
  ),
  Layer.succeed(FunctionRegistry, f.registry),
);

describe("typed formula", () => {
  it("builds and parses the same AST and evaluates with a typed custom function", async () => {
    expect(built.ast).toEqual(
      parseSync("=IF([discounted];TRIPLE([price]*[quantity]);[price]*[quantity])"),
    );
    expect(f.check(parsed, Schema.Number)).toEqual({
      passed: true,
      coverage: "complete",
      types: ["Number"],
      diagnostics: [],
    });
    const builtResult = await Effect.runPromise(evaluate(built.ast).pipe(Effect.provide(services)));
    const parsedResult = await Effect.runPromise(evaluate(parsed).pipe(Effect.provide(services)));
    expect(builtResult).toEqual(number(108));
    expect(parsedResult).toEqual(builtResult);
  });

  it("rejects invalid strings with located diagnostics", () => {
    const arithmetic = f.check(f.parse("=[label]*[quantity]"), Schema.Number);
    expect(arithmetic.passed).toBe(false);
    expect(arithmetic.diagnostics).toContainEqual({
      code: "OperandType",
      message: "* requires Number",
      path: "root.left",
      span: { start: 1, end: 8 },
    });
    const unknown = f.check(f.parse("=MYSTERY([price])"), Schema.Number);
    expect(unknown.passed).toBe(false);
    expect(unknown.coverage).toBe("partial");
    expect(unknown.diagnostics.map((diagnostic) => diagnostic.code)).toContain("UnknownCoverage");
    expect(f.check(f.parse("=[price]+[quantity]"), Schema.String).passed).toBe(false);
    expect(f.check(f.parse("=#N/A+1"), Schema.Number).passed).toBe(false);
  });

  it("checks custom function arity and input types before evaluation", async () => {
    expect(f.check(f.parse("=TRIPLE([label])"), Schema.Number).diagnostics[0]?.code).toBe(
      "ArgumentType",
    );
    expect(f.check(f.parse("=TRIPLE()"), Schema.Number).diagnostics[0]?.code).toBe("Arity");
    const result = await Effect.runPromise(
      evaluate(f.parse('=TRIPLE("3")')).pipe(Effect.provide(services)),
    );
    expect(result).toEqual({ _tag: "Error", code: "#VALUE!" });
  });

  it("decodes host inputs and rejects invalid custom function output", async () => {
    const values = await Effect.runPromise(
      f.decodeInputs({ price: 12, quantity: 3, discounted: true }),
    );
    expect(values.get("field:price")).toEqual(number(12));
    await expect(
      Effect.runPromise(f.decodeInputs({ price: "12", quantity: 3, discounted: true })),
    ).rejects.toThrow();
    await expect(Effect.runPromise(f.decodeInputs({ unknown: 1 }))).rejects.toThrow();

    const broken = defineFormulaFunction("BROKEN", [] as const, Schema.Number, () =>
      Effect.succeed("wrong" as unknown as number),
    );
    const contract = typedFormula({}, [broken]);
    const result = await Effect.runPromise(
      evaluate(contract.call(broken).ast).pipe(
        Effect.provide(
          Layer.merge(memory(new Map()), Layer.succeed(FunctionRegistry, contract.registry)),
        ),
      ),
    );
    expect(result).toEqual({ _tag: "Error", code: "#VALUE!" });
  });

  it("recalculates a built AST in a form session", async () => {
    const host = await Effect.runPromise(
      createForm(["price", "quantity", "discounted", "total"], {
        inputSchemas: f.inputSchemas,
      }).pipe(Effect.provide(Layer.succeed(FunctionRegistry, f.registry))),
    );
    await Effect.runPromise(
      host.set({
        price: number(12),
        quantity: number(3),
        discounted: bool(true),
        total: { formula: built.ast },
      }),
    );
    expect(await Effect.runPromise(host.get("total"))).toEqual(number(108));
    await Effect.runPromise(host.set({ quantity: number(4) }));
    expect(await Effect.runPromise(host.get("total"))).toEqual(number(144));
    await expect(Effect.runPromise(host.set({ quantity: bool(true) }))).rejects.toThrow();
    expect(await Effect.runPromise(host.get("total"))).toEqual(number(144));
  });

  it("preserves a custom function's Effect requirement and typed failure", async () => {
    const contract = typedFormula({ amount: Schema.Number, scaled: Schema.Number }, [scale]);
    const program = contract.evaluate(contract.call(scale, contract.ref("amount")).ast).pipe(
      Effect.provideService(ReferenceResolver, {
        get: () => Effect.succeed(number(5)),
      }),
    );
    expect(
      await Effect.runPromise(program.pipe(Effect.provideService(Scale, { factor: 3 }))),
    ).toEqual(number(15));
    const recovered = program.pipe(
      Effect.catchTag("ScaleFailure", () => Effect.succeed(number(-1))),
      Effect.provideService(Scale, { factor: -1 }),
    );
    expect(await Effect.runPromise(recovered)).toEqual(number(-1));

    const session = await Effect.runPromise(
      contract.createSession().pipe(Effect.provide(memory(new Map()))),
    );
    await Effect.runPromise(
      session
        .update([
          { _tag: "Input", key: "field:amount", value: number(5) },
          {
            _tag: "Formula",
            key: "field:scaled",
            formula: contract.call(scale, contract.ref("amount")).ast,
          },
        ])
        .pipe(Effect.provideService(Scale, { factor: 4 })),
    );
    expect(await Effect.runPromise(session.get("field:scaled"))).toEqual(number(20));
    const checkFailure = await Effect.runPromise(
      session
        .update([
          {
            _tag: "Formula",
            key: "field:scaled",
            formula: '=[amount]+"bad"',
          },
        ])
        .pipe(Effect.provideService(Scale, { factor: 4 }), Effect.flip),
    );
    expect(checkFailure).toMatchObject({
      _tag: "FormulaCheckFailure",
      diagnostics: [{ code: "OperandType", path: "root.right", span: { start: 10, end: 15 } }],
    });
    expect(await Effect.runPromise(session.get("field:scaled"))).toEqual(number(20));
    await expect(
      Effect.runPromise(
        session
          .update([{ _tag: "Input", key: "field:amount", value: bool(true) }])
          .pipe(Effect.provideService(Scale, { factor: 4 })),
      ),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        session
          .update([{ _tag: "Input", key: "field:unknown", value: number(1) }])
          .pipe(Effect.provideService(Scale, { factor: 4 })),
      ),
    ).rejects.toThrow();
    const recoveredUpdate = session
      .update([{ _tag: "Input", key: "field:amount", value: number(6) }])
      .pipe(
        Effect.catchTag("ScaleFailure", () =>
          Effect.succeed({ revision: -1, changed: new Map<string, Value>() }),
        ),
        Effect.provideService(Scale, { factor: -1 }),
      );
    expect((await Effect.runPromise(recoveredUpdate)).revision).toBe(-1);
    expect(await Effect.runPromise(session.get("field:scaled"))).toEqual(number(20));
  });

  it("checks numeric ranges and selected built-ins", async () => {
    const grid = typedFormula({}, [], {
      cells: { A1: Schema.Number, A2: Schema.Number, B1: Schema.String },
    });
    const builtRange = grid.sum(grid.range("A1", "A2"));
    expect(builtRange.ast).toEqual(parseSync("=SUM(A1:A2)"));
    expect(grid.check(grid.parse("=SUM(A1:A2)"), Schema.Number).passed).toBe(true);
    const cells = await Effect.runPromise(grid.decodeCells({ A1: 2, A2: 3, B1: "note" }));
    const result = await Effect.runPromise(
      grid.evaluate(builtRange.ast).pipe(Effect.provide(memory(cells))),
    );
    expect(result).toEqual(number(5));
    expect(grid.check(grid.parse("=SUM(A1:B1)"), Schema.Number).passed).toBe(false);
    expect(grid.check(grid.parse("=SUM(A1:A3)"), Schema.Number).coverage).toBe("partial");
    expect(grid.check(grid.parse("=ABS(-3)"), Schema.Number).passed).toBe(true);
    expect(grid.check(grid.parse("=TRUE()"), Schema.Boolean).passed).toBe(true);
    expect(grid.check(grid.parse("=NA()"), Schema.Number).passed).toBe(false);
  });

  it("marks unsupported field schemas as partial coverage", () => {
    const nested = typedFormula({ value: Schema.Array(Schema.Number) });
    const result = nested.check(nested.parse("=[value]"), Schema.Number);
    expect(result.passed).toBe(false);
    expect(result.coverage).toBe("partial");
    expect(f.check(f.parse("=[unknown]"), Schema.Number).coverage).toBe("partial");
  });
});

function typeChecks() {
  f.ref("price");
  f.call(triple, f.ref("price"));
  // @ts-expect-error Unknown field
  f.ref("prcie");
  // @ts-expect-error Boolean cannot be multiplied
  f.multiply(f.ref("discounted"), f.ref("quantity"));
  // @ts-expect-error Custom function expects Number
  f.call(triple, f.ref("label"));
  // @ts-expect-error IF condition must be Boolean
  f.if(f.ref("price"), f.number(1), f.number(2));
  // @ts-expect-error Wrong number of function arguments
  f.call(triple, f.number(1), f.number(2));
  // @ts-expect-error The implementation must return the declared schema type
  defineFormulaFunction("WRONG", [] as const, Schema.Number, () => Effect.succeed("text"));
  const grid = typedFormula({}, [], { cells: { A1: Schema.Number, B1: Schema.String } });
  // @ts-expect-error A text cell cannot be used as a numeric range endpoint
  grid.range("A1", "B1");
  // @ts-expect-error SUM requires at least one expression
  grid.sum();
  const effectful = typedFormula({ amount: Schema.Number }, [scale]);
  // @ts-expect-error Effect requirements cannot be erased into the default registry service
  Layer.succeed(FunctionRegistry, effectful.registry);
}
void typeChecks;

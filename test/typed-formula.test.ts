import { Context, Data, Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  bool,
  createForm,
  defineFormulaFunction,
  error,
  evaluate,
  FunctionRegistry,
  memory,
  number,
  parseSync,
  ReferenceResolver,
  text,
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
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "OperandType",
          path: "root.right",
          span: { start: 10, end: 15 },
        }),
      ]),
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
    expect(grid.check(grid.parse("=SUM(A1:B1)"), Schema.Number).passed).toBe(true);
    expect(grid.check(grid.parse("=SUM(A1:A3)"), Schema.Number).coverage).toBe("partial");
    expect(grid.check(grid.parse("=ABS(-3)"), Schema.Number).passed).toBe(true);
    expect(grid.check(grid.parse("=TRUE()"), Schema.Boolean).passed).toBe(true);
    expect(grid.check(grid.parse("=NA()"), Schema.Number).passed).toBe(false);
  });

  it.each([
    ['=1="1"', Schema.Boolean, bool(false)],
    ['="AbC"="abc"', Schema.Boolean, bool(true)],
    ["=1<>TRUE", Schema.Boolean, bool(true)],
    ["=1<2", Schema.Boolean, bool(true)],
    ["=2<=2", Schema.Boolean, bool(true)],
    ['="b">="a"', Schema.Boolean, bool(true)],
    ["=TRUE&12", Schema.String, text("TRUE12")],
    ['=CONCATENATE("a";TRUE;12;)', Schema.String, text("aTRUE12")],
    ["=LEN(TRUE)", Schema.Number, number(4)],
    ['=LEN("😀a")', Schema.Number, number(2)],
    ['=LEFT("😀abc")', Schema.String, text("😀")],
    ['=RIGHT(1234;"2")', Schema.String, text("34")],
    ['=MID("😀abc";2;2)', Schema.String, text("ab")],
    ['=UPPER("abc")', Schema.String, text("ABC")],
    ["=LOWER(TRUE)", Schema.String, text("true")],
    ['=TRIM(" a  b ")', Schema.String, text("a b")],
    ["=AND(TRUE;2;)", Schema.Boolean, bool(false)],
    ["=OR(FALSE;2)", Schema.Boolean, bool(true)],
    ["=NOT(0)", Schema.Boolean, bool(true)],
    ['=ROUND("-1.25";1)', Schema.Number, number(-1.3)],
    ["=ROUNDUP(-1.21;1)", Schema.Number, number(-1.3)],
    ["=ROUNDDOWN(-1.29;1)", Schema.Number, number(-1.2)],
    ["=ROUNDUP(12.1)", Schema.Number, number(13)],
    ["=ROUNDDOWN(12.9)", Schema.Number, number(12)],
    ["=ROUNDUP(1e-300;-100)", Schema.Number, number(1e100)],
    ["=ROUNDUP(0;-1001)", Schema.Number, number(0)],
    ["=IFERROR(ROUNDUP(1;-1001);42)", Schema.Number, number(42)],
    ["=INT(-1.2)", Schema.Number, number(-2)],
    ["=MOD(-3;2)", Schema.Number, number(1)],
    ["=IFERROR(MOD(1;0);9)", Schema.Number, number(9)],
    ["=IFERROR(1;MYSTERY())", Schema.Number, number(1)],
    ["=IFERROR(#N/A;9)", Schema.Number, number(9)],
    ['=CHOOSE("2.9";MYSTERY();42)', Schema.Number, number(42)],
    ["=IF(TRUE;42;MYSTERY())", Schema.Number, number(42)],
    ["=IF(TRUE;;MYSTERY())", Schema.Number, number(0)],
  ] as const)(
    "checks and evaluates %s using engine conversions",
    async (source, schema, expected) => {
      const result = f.check(f.parse(source), schema);
      expect(result).toMatchObject({ passed: true, coverage: "complete", diagnostics: [] });
      expect(
        await Effect.runPromise(
          f.evaluate(f.parse(source)).pipe(Effect.provide(memory(new Map()))),
        ),
      ).toEqual(expected);
    },
  );

  it.each([
    ['=AND("TRUE")', "ArgumentType"],
    ["=NOT([label])", "ArgumentType"],
    ["=ROUND([label])", "ArgumentType"],
    ['=ROUND("bad")', "ArgumentType"],
    ['=LEFT("a";"bad")', "ArgumentType"],
    ['=MID("a";1)', "Arity"],
    ["=ROUNDUP(1;2;3)", "Arity"],
    ["=ROUNDDOWN()", "Arity"],
    ["=CONCATENATE()", "Arity"],
    ["=AND()", "Arity"],
    ["=IFERROR(1)", "Arity"],
    ["=CHOOSE(3;1;2)", "ArgumentType"],
    ['=IFERROR(1/0;"text")', "ResultType"],
    ['=CHOOSE([quantity];1;"text")', "ResultType"],
  ])("rejects incompatible call %s with located diagnostics", (source, code) => {
    const result = f.check(f.parse(source!), Schema.Number);
    expect(result.passed).toBe(false);
    expect(result.coverage).toBe("complete");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code, span: expect.any(Object) }),
    );
  });

  it("uses NumberSequence for logical ranges and rejects ranges in scalar contexts", async () => {
    const grid = typedFormula({}, [], {
      cells: { A1: Schema.Number, A2: Schema.String, A3: Schema.Boolean },
    });
    const cells = await Effect.runPromise(grid.decodeCells({ A1: 1, A2: "bad", A3: false }));
    for (const source of ["=AND(A1:A3)", "=OR(A1:A3)"]) {
      expect(grid.check(grid.parse(source), Schema.Boolean).passed).toBe(true);
      expect(
        await Effect.runPromise(
          grid.evaluate(grid.parse(source)).pipe(Effect.provide(memory(cells))),
        ),
      ).toEqual(bool(true));
    }
    expect(grid.check(grid.parse("=AND(A2:A3)"), Schema.Boolean).passed).toBe(true);
    expect(
      await Effect.runPromise(
        grid.evaluate(grid.parse("=AND(A2:A3)")).pipe(Effect.provide(memory(cells))),
      ),
    ).toEqual(bool(true));
    expect(
      await Effect.runPromise(
        grid.evaluate(grid.parse("=OR(A2:A3)")).pipe(Effect.provide(memory(cells))),
      ),
    ).toEqual(bool(false));
    expect(grid.check(grid.parse("=AND(A1:A4)"), Schema.Boolean).coverage).toBe("partial");
    for (const source of ["=NOT(A1:A3)", "=LEN(A1:A3)", '=A1:A3&"x"', "=A1:A3=1", "=ROUND(A1:A3)"])
      expect(grid.check(grid.parse(source), Schema.String).passed).toBe(false);
    expect(grid.check(grid.parse("=SUM(A1:A3)"), Schema.Number).passed).toBe(true);
    expect(
      await Effect.runPromise(
        grid.evaluate(grid.parse("=SUM(A1:A3)")).pipe(Effect.provide(memory(cells))),
      ),
    ).toEqual(number(1));
    expect(grid.check(grid.parse("=AVERAGE(A2:A3)"), Schema.Number).passed).toBe(false);
  });

  it("keeps IFERROR and CHOOSE lazy, AND and OR eager, and operational failures in Effect", async () => {
    let calls = 0;
    const fail = defineFormulaFunction("FAIL", [] as const, Schema.Number, () =>
      Effect.sync(() => {
        calls++;
        throw new Error("evaluated");
      }),
    );
    const contract = typedFormula({}, [fail]);
    const run = (source: string) =>
      Effect.runPromise(
        contract.evaluate(contract.parse(source)).pipe(Effect.provide(memory(new Map()))),
      );
    expect(await run("=IFERROR(1;FAIL())")).toEqual(number(1));
    expect(await run("=CHOOSE(2;FAIL();42)")).toEqual(number(42));
    expect(calls).toBe(0);
    await expect(run("=AND(FALSE;FAIL())")).rejects.toThrow("evaluated");
    await expect(run("=OR(TRUE;FAIL())")).rejects.toThrow("evaluated");
    await expect(run("=IFERROR(FAIL();42)")).rejects.toThrow("evaluated");
    expect(calls).toBe(3);
    expect(await run("=AND(FALSE;#N/A)")).toEqual(error("#N/A"));
    expect(await run("=OR(TRUE;#N/A)")).toEqual(error("#N/A"));
    expect(
      contract.check(contract.parse("=IFERROR(FAIL();MYSTERY())"), Schema.Number).coverage,
    ).toBe("partial");
    expect(f.check(f.parse("=SQRT(4)"), Schema.Number).coverage).toBe("partial");
  });

  it("builds the same AST for the added helpers", () => {
    const grid = typedFormula({}, [], { cells: { A1: Schema.Number, A2: Schema.String } });
    const examples = [
      [f.equals(f.text("a"), f.text("A")), '="a"="A"'],
      [f.lessThan(f.number(1), f.number(2)), "=1<2"],
      [f.concat(f.text("a"), f.boolean(true)), '="a"&TRUE'],
      [f.concatenate(f.text("a"), f.number(1)), '=CONCATENATE("a";1)'],
      [f.and(f.boolean(true), f.number(1)), "=AND(TRUE;1)"],
      [f.or(f.boolean(false), f.number(1)), "=OR(FALSE;1)"],
      [f.not(f.number(0)), "=NOT(0)"],
      [f.len(f.text("abc")), '=LEN("abc")'],
      [f.left(f.text("abc")), '=LEFT("abc")'],
      [f.right(f.text("abc"), f.number(2)), '=RIGHT("abc";2)'],
      [f.mid(f.text("abc"), f.number(1), f.number(2)), '=MID("abc";1;2)'],
      [f.upper(f.text("abc")), '=UPPER("abc")'],
      [f.lower(f.text("ABC")), '=LOWER("ABC")'],
      [f.trim(f.text(" a ")), '=TRIM(" a ")'],
      [f.round(f.number(1.2)), "=ROUND(1.2)"],
      [f.roundUp(f.number(1.2), f.number(1)), "=ROUNDUP(1.2;1)"],
      [f.roundDown(f.number(1.2)), "=ROUNDDOWN(1.2)"],
      [f.int(f.number(1.2)), "=INT(1.2)"],
      [f.mod(f.number(3), f.number(2)), "=MOD(3;2)"],
      [f.ifError(f.number(1), f.number(2)), "=IFERROR(1;2)"],
      [f.choose(f.number(1), f.number(2), f.text("x")), '=CHOOSE(1;2;"x")'],
      [grid.and(grid.valuesRange("A1", "A2")), "=AND(A1:A2)"],
    ] as const;
    for (const [built, source] of examples) expect(built.ast).toEqual(parseSync(source));
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
  f.add(f.len(f.text("abc")), f.number(1));
  // @ts-expect-error Logical scalar text is rejected
  f.and(f.text("TRUE"));
  // @ts-expect-error NOT cannot accept a range
  grid.not(grid.range("A1", "A1"));
  // @ts-expect-error Text position is rejected
  f.mid(f.text("abc"), f.text("1"), f.number(2));
  // @ts-expect-error Rounding expects a Number expression
  f.round(f.ref("label"));
  // @ts-expect-error CHOOSE index must be Number
  f.choose(f.text("1"), f.number(2));
  // @ts-expect-error CHOOSE needs a choice
  f.choose(f.number(1));
  // @ts-expect-error CONCATENATE needs an argument
  f.concatenate();
  // @ts-expect-error Mixed CHOOSE results cannot be treated as Number
  f.add(f.choose(f.number(1), f.number(2), f.text("x")), f.number(1));
  f.add(f.choose(f.number(1), f.number(2), f.number(3)), f.number(1));
  // @ts-expect-error A range is not a scalar text argument
  grid.len(grid.valuesRange("A1", "B1"));
  const effectful = typedFormula({ amount: Schema.Number }, [scale]);
  // @ts-expect-error Effect requirements cannot be erased into the default registry service
  Layer.succeed(FunctionRegistry, effectful.registry);
}
void typeChecks;

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  createSession,
  emptyFunctions,
  error,
  evaluate,
  FunctionRegistry,
  memory,
  number,
  parse,
  parseSync,
  ReferenceResolver,
  range,
  text,
  type Value,
} from "../src/index.js";

const layer = (values: ReadonlyMap<string, Value> = new Map()) =>
  Layer.merge(memory(values), emptyFunctions);
const run = (formula: string, values: ReadonlyMap<string, Value> = new Map()) =>
  Effect.runPromise(
    Effect.flatMap(parse(formula), (ast) => evaluate(ast)).pipe(Effect.provide(layer(values))),
  );

describe("one-shot evaluation", () => {
  it("parses precedence, exponentiation, strings, and explicit dialects", async () => {
    expect(await run("=2+3*4")).toEqual(number(14));
    expect(await run("=-2^2")).toEqual(number(4));
    expect(await run("=2^3^2")).toEqual(number(64));
    expect(parseSync("=-2^2", { dialect: "excel" })).toMatchObject({ _tag: "Unary" });
    expect(await run('="a""b"&"c"')).toEqual(text('a"bc'));
    expect(await run("=SUM(1;2;3)")).toEqual(number(6));
    expect(parseSync("=SUM(1,2,3)", { dialect: "excel" })).toMatchObject({
      _tag: "Call",
      name: "SUM",
    });
    expect(() => parseSync("=SUM(1,2,3)")).toThrow();
  });
  it("meets the OpenFormula basic string and nesting limits", async () => {
    const longText = "a".repeat(32767);
    expect(await run(`="${longText}"`)).toEqual(text(longText));
    expect(await run(`=${"ABS(".repeat(7)}-1${")".repeat(7)}`)).toEqual(number(1));
  });
  it("evaluates ranges and field references through one core", async () => {
    const values = new Map<string, Value>([
      ["cell:A1", number(2)],
      ["cell:A2", number(3)],
      ["cell:B1", number(5)],
      ["cell:B2", number(7)],
      ["field:quantity", number(4)],
      ["field:price", number(8)],
    ]);
    expect(await run("=SUM(A1:B2)", values)).toEqual(number(17));
    expect(await run("=IF([quantity]>0;[price]*[quantity];0)", values)).toEqual(number(32));
  });
  it("keeps formula errors as values and skips unselected IF branches", async () => {
    expect(await run("=1/0")).toEqual(error("#DIV/0!"));
    expect(await run("=IF(TRUE;42;1/0)")).toEqual(number(42));
    expect(await run("=IFERROR(1/0;9)")).toEqual(number(9));
    expect(await run("=MISSING(1)")).toEqual(error("#NAME?"));
  });
  it("supports Effect custom functions", async () => {
    const functions = Layer.succeed(FunctionRegistry, {
      functions: new Map([
        [
          "DOUBLE",
          (args: readonly Value[]) =>
            Effect.succeed(number((args[0] as { value: number }).value * 2)),
        ],
      ]),
    });
    const ast = parseSync("=DOUBLE(21)");
    expect(
      await Effect.runPromise(
        evaluate(ast).pipe(Effect.provide(Layer.merge(memory(new Map()), functions))),
      ),
    ).toEqual(number(42));
  });
  it("accepts a range returned by a registered function as a lookup source", async () => {
    const functions = Layer.succeed(FunctionRegistry, {
      functions: new Map([["VALUES", () => Effect.succeed(range([[number(1)], [number(2)]]))]]),
    });
    expect(
      await Effect.runPromise(
        evaluate(parseSync("=MATCH(2;VALUES();0)")).pipe(
          Effect.provide(Layer.merge(memory(new Map()), functions)),
        ),
      ),
    ).toEqual(number(2));
  });
  it("resolves simple named expressions and reference intersection", async () => {
    expect(await run("=TAX*2", new Map([["name:TAX", number(3)]]))).toEqual(number(6));
    expect(await run("=$$TAX*2", new Map([["name:TAX", number(3)]]))).toEqual(number(6));
    expect(await run("=MISSING_NAME")).toEqual(error("#NAME?"));
    expect(
      await run(
        "=SUM([.A1:.B2]![.B1:.C2])",
        new Map([
          ["cell:B1", number(10)],
          ["cell:B2", number(20)],
        ]),
      ),
    ).toEqual(number(30));
    expect(await run("=[.A1]![.B1]")).toEqual(error("#NULL!"));
  });
});

describe("session", () => {
  it("recalculates transitive dependents and reports only changed values", async () => {
    const session = await Effect.runPromise(createSession().pipe(Effect.provide(layer())));
    const first = await Effect.runPromise(
      session.update([
        { _tag: "Input", key: "cell:A1", value: number(2) },
        { _tag: "Formula", key: "cell:B1", formula: "=A1*2" },
        { _tag: "Formula", key: "cell:C1", formula: "=B1+1" },
      ]),
    );
    expect(first.changed.get("cell:C1")).toEqual(number(5));
    const second = await Effect.runPromise(
      session.update([{ _tag: "Input", key: "cell:A1", value: number(4) }]),
    );
    expect(second.changed.get("cell:B1")).toEqual(number(8));
    expect(second.changed.get("cell:C1")).toEqual(number(9));
    expect(await Effect.runPromise(session.get("cell:C1"))).toEqual(number(9));
  });
  it("tracks every cell in a range", async () => {
    const session = await Effect.runPromise(createSession().pipe(Effect.provide(layer())));
    await Effect.runPromise(
      session.update([
        { _tag: "Input", key: "cell:A1", value: number(1) },
        { _tag: "Input", key: "cell:A2", value: number(2) },
        { _tag: "Input", key: "cell:A3", value: number(3) },
        { _tag: "Formula", key: "cell:B1", formula: "=SUM(A1:A3)" },
      ]),
    );
    const result = await Effect.runPromise(
      session.update([{ _tag: "Input", key: "cell:A2", value: number(8) }]),
    );
    expect(result.changed.get("cell:B1")).toEqual(number(12));
  });
  it("recalculates formulas that depend on a named expression", async () => {
    const session = await Effect.runPromise(createSession().pipe(Effect.provide(layer())));
    await Effect.runPromise(
      session.update([
        { _tag: "Input", key: "name:TAX", value: number(3) },
        { _tag: "Formula", key: "cell:A1", formula: "=TAX*2" },
      ]),
    );
    const revision = await Effect.runPromise(
      session.update([{ _tag: "Input", key: "name:TAX", value: number(4) }]),
    );
    expect(revision.changed.get("cell:A1")).toEqual(number(8));
  });
  it("detects cycles and preserves state after a parse failure", async () => {
    const session = await Effect.runPromise(createSession().pipe(Effect.provide(layer())));
    await Effect.runPromise(session.update([{ _tag: "Input", key: "cell:A1", value: number(3) }]));
    await expect(
      Effect.runPromise(
        session.update([
          { _tag: "Input", key: "cell:B1", value: number(9) },
          { _tag: "Formula", key: "cell:A1", formula: "=SUM(" },
        ]),
      ),
    ).rejects.toThrow("Expected expression");
    expect(await Effect.runPromise(session.get("cell:A1"))).toEqual(number(3));
    expect(await Effect.runPromise(session.snapshot())).toEqual(new Map());
    const result = await Effect.runPromise(
      session.update([
        { _tag: "Formula", key: "cell:A1", formula: "=B1+1" },
        { _tag: "Formula", key: "cell:B1", formula: "=A1+1" },
      ]),
    );
    expect(result.revision).toBe(2);
    expect(result.changed.get("cell:A1")).toEqual(error("#CYCLE!"));
    expect(result.changed.get("cell:B1")).toEqual(error("#CYCLE!"));
  });
  it("serializes updates across an asynchronous resolver", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = Layer.succeed(ReferenceResolver, {
      get: (key: string) =>
        Effect.promise(async () => {
          if (key === "cell:Z1") {
            await gate;
            return number(1);
          }
          return error("#REF!");
        }),
    });
    const session = await Effect.runPromise(
      createSession().pipe(Effect.provide(Layer.merge(resolver, emptyFunctions))),
    );
    const first = Effect.runPromise(
      session.update([{ _tag: "Formula", key: "cell:B1", formula: "=Z1+1" }]),
    );
    const second = Effect.runPromise(
      session.update([{ _tag: "Input", key: "cell:B1", value: number(7) }]),
    );
    release?.();
    await Promise.all([first, second]);
    expect(await Effect.runPromise(session.get("cell:B1"))).toEqual(number(7));
  });
  it("validates host values and reads state after a queued update", async () => {
    const session = await Effect.runPromise(createSession().pipe(Effect.provide(layer())));
    await expect(
      Effect.runPromise(
        session.update([
          { _tag: "Input", key: "cell:A1", value: { _tag: "Number", value: Number.NaN } as Value },
        ]),
      ),
    ).rejects.toThrow("Invalid value");
    const updating = Effect.runPromise(
      session.update([{ _tag: "Input", key: "cell:A1", value: number(5) }]),
    );
    const reading = Effect.runPromise(session.get("cell:A1"));
    await updating;
    expect(await reading).toEqual(number(5));
  });
});

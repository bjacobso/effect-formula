import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  emptyFunctions,
  error,
  evaluate,
  number,
  parseSync,
  ReferenceResolver,
  ResolutionFailure,
  type Value,
} from "../src/index.js";

describe("OpenFormula IF", () => {
  it("reads only the selected reference and returns its value", async () => {
    const visited: string[] = [];
    const resolver = Layer.succeed(ReferenceResolver, {
      get: (key: string): Effect.Effect<Value, ResolutionFailure> => {
        visited.push(key);
        return key === "cell:A1"
          ? Effect.succeed(number(8))
          : Effect.fail(new ResolutionFailure({ key, message: "Unselected reference" }));
      },
    });
    const result = await Effect.runPromise(
      evaluate(parseSync("=IF(TRUE();A1;B1)")).pipe(
        Effect.provide(Layer.merge(resolver, emptyFunctions)),
      ),
    );
    expect(result).toEqual(number(8));
    expect(visited).toEqual(["cell:A1"]);
  });

  it("converts numeric and blank conditions and rejects invalid arity", async () => {
    const resolver = Layer.succeed(ReferenceResolver, {
      get: (key: string) =>
        Effect.succeed(key === "cell:A1" ? ({ _tag: "Blank" } as const) : error("#REF!")),
    });
    const run = (formula: string) =>
      Effect.runPromise(
        evaluate(parseSync(formula)).pipe(Effect.provide(Layer.merge(resolver, emptyFunctions))),
      );
    expect(await run("=IF(2;7;9)")).toEqual(number(7));
    expect(await run("=IF(0;7;9)")).toEqual(number(9));
    expect(await run("=IF(A1;7;9)")).toEqual(number(9));
    expect(await run("=IF(#N/A;7;9)")).toEqual(error("#N/A"));
    expect(await run("=IF()")).toEqual(error("#VALUE!"));
    expect(await run("=IF(1;2;3;4)")).toEqual(error("#VALUE!"));
  });
});

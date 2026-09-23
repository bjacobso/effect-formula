import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { formulaInputSchema, formulaInputs, parseSync } from "../src/index.js";

describe("formula input analysis", () => {
  it("collects each reference once across conditional branches", async () => {
    const ast = parseSync("=IF([quantity]>0;[price]*[quantity];[discount])");
    expect(await Effect.runPromise(formulaInputs(ast))).toEqual([
      "field:quantity",
      "field:price",
      "field:discount",
    ]);
  });

  it("expands range references in row order", async () => {
    const ast = parseSync("=SUM(A1:B2;A1)");
    expect(await Effect.runPromise(formulaInputs(ast))).toEqual([
      "cell:A1",
      "cell:B1",
      "cell:A2",
      "cell:B2",
    ]);
    const wholeColumn = parseSync("=SUM([.A:.A])");
    expect(
      await Effect.runPromise(formulaInputs(wholeColumn, { grid: { rows: 2, columns: 2 } })),
    ).toEqual(["cell:A1", "cell:A2"]);
    expect(Either.isLeft(await Effect.runPromise(Effect.either(formulaInputs(wholeColumn))))).toBe(
      true,
    );
  });

  it("includes the aligned result cells of conditional aggregates", async () => {
    const ast = parseSync('=SUMIF(A1:A3;">0";B1)');
    expect(await Effect.runPromise(formulaInputs(ast))).toEqual([
      "cell:B1",
      "cell:B2",
      "cell:B3",
      "cell:A1",
      "cell:A2",
      "cell:A3",
    ]);
  });

  it("builds an Effect Schema from host-declared types", async () => {
    const ast = parseSync("=[price]*[quantity]");
    const schema = await Effect.runPromise(
      formulaInputSchema(ast, {
        "field:price": Schema.Number,
        "field:quantity": Schema.Number,
      }),
    );
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(schema)({ "field:price": 12, "field:quantity": 3 }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(schema)({ "field:price": "12", "field:quantity": 3 }),
      ),
    ).toBe(true);
    expect(Either.isLeft(Schema.decodeUnknownEither(schema)({ "field:price": 12 }))).toBe(true);
    const missing = await Effect.runPromise(
      Effect.either(formulaInputSchema(ast, { "field:price": Schema.Number })),
    );
    expect(missing).toMatchObject({
      _tag: "Left",
      left: { _tag: "FormulaAnalysisError", message: "Missing schema for field:quantity" },
    });
  });
});

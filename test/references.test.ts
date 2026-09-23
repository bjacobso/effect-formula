import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  createSession,
  emptyFunctions,
  error,
  evaluate,
  memory,
  number,
  parseSync,
  rangeKeys,
} from "../src/index.js";

const values = new Map([
  ["cell:Sales!A1", number(2)],
  ["cell:Sales!A2", number(3)],
  ["cell:Sales!B1", number(5)],
  ["cell:Sales!B2", number(7)],
  ["cell:Sales%20West!A1", number(11)],
  ["cell:O'Reilly!A1", number(13)],
]);
const run = (formula: string, grid = { rows: 2, columns: 2 }, maxRangeCells = 10000) =>
  Effect.runPromise(
    evaluate(parseSync(formula), { grid, maxRangeCells }).pipe(
      Effect.provide(memory(values)),
      Effect.provide(emptyFunctions),
    ),
  );

describe("OpenFormula references", () => {
  it("parses qualified, quoted, fixed, and local sheet addresses", () => {
    expect(parseSync("=[Sales.$A$1]")).toEqual({ _tag: "Reference", key: "cell:Sales!A1" });
    expect(parseSync("=['Sales West'.A1]")).toEqual({
      _tag: "Reference",
      key: "cell:Sales%20West!A1",
    });
    expect(parseSync("=['O''Reilly'.A1]")).toEqual({ _tag: "Reference", key: "cell:O'Reilly!A1" });
    expect(parseSync("=['Sales:West]'.A1]")).toEqual({
      _tag: "Reference",
      key: "cell:Sales%3AWest%5D!A1",
    });
    expect(parseSync("=[.A1]", { currentSheet: "Sales" })).toEqual({
      _tag: "Reference",
      key: "cell:Sales!A1",
    });
    expect(parseSync("=A1", { currentSheet: "Sales" })).toEqual({
      _tag: "Reference",
      key: "cell:Sales!A1",
    });
    expect(parseSync("=[order.total]")).toEqual({ _tag: "Reference", key: "field:order.total" });
    expect(parseSync("=[#REF!]")).toEqual({ _tag: "Literal", value: error("#REF!") });
  });

  it("evaluates qualified cell and rectangular ranges", async () => {
    expect(await run("=[Sales.A1]")).toEqual(number(2));
    expect(await run("=SUM([Sales.A1:.B2])")).toEqual(number(17));
    expect(await run("=SUM([Sales.A1:Sales.B2])")).toEqual(number(17));
    expect(await run("=['Sales West'.A1]")).toEqual(number(11));
    expect(await run("=['O''Reilly'.A1]")).toEqual(number(13));
    expect(await run("=[Missing.A1]")).toEqual(error("#REF!"));
  });

  it("expands whole rows and columns only within configured limits", async () => {
    expect(await run("=SUM([Sales.A:.B])")).toEqual(number(17));
    expect(await run("=SUM([Sales.1:.2])")).toEqual(number(17));
    expect(await run("=SUM([Sales.A:.B])", { rows: 2, columns: 2 }, 3)).toEqual(error("#REF!"));
    expect(await run("=SUM([Sales.A:.B])", { rows: 2, columns: 1 })).toEqual(error("#REF!"));
    expect(rangeKeys("column:Sales!A", "column:Sales!B")).toEqual(Option.none());
    expect(rangeKeys("column:Sales!A", "column:Sales!B", 4, { rows: 2, columns: 2 })).toEqual(
      Option.some([
        ["cell:Sales!A1", "cell:Sales!B1"],
        ["cell:Sales!A2", "cell:Sales!B2"],
      ]),
    );
  });

  it("rejects malformed and cross-sheet ranges", () => {
    expect(() => parseSync("=[Sales.A1:Costs.B2]")).toThrow("same kind and sheet");
    expect(() => parseSync("=[Sales.A1:.B]")).toThrow("same kind and sheet");
    expect(() => parseSync("=[Sales.A]")).toThrow("require a range");
    expect(() => parseSync("=[Sales.A0]")).toThrow();
    expect(() => parseSync("=[Sales.A9007199254740992]")).toThrow("Invalid OpenFormula address");
    expect(() => parseSync("=['Open.A1]")).toThrow();
  });

  it("tracks local and whole-column dependencies in a named sheet", async () => {
    const session = await Effect.runPromise(
      createSession({ grid: { rows: 2, columns: 2 } }).pipe(
        Effect.provide(memory(new Map())),
        Effect.provide(emptyFunctions),
      ),
    );
    await Effect.runPromise(
      session.update([
        { _tag: "Input", key: "cell:Sales!A1", value: number(2) },
        { _tag: "Input", key: "cell:Sales!A2", value: number(3) },
        { _tag: "Formula", key: "cell:Sales!B1", formula: "=SUM([.A:.A])" },
        { _tag: "Formula", key: "cell:Costs!B1", formula: "=[Sales.A1]*2" },
      ]),
    );
    expect(await Effect.runPromise(session.get("cell:Sales!B1"))).toEqual(number(5));
    const revision = await Effect.runPromise(
      session.update([{ _tag: "Input", key: "cell:Sales!A2", value: number(8) }]),
    );
    expect(revision.changed.get("cell:Sales!B1")).toEqual(number(10));
    const crossSheet = await Effect.runPromise(
      session.update([{ _tag: "Input", key: "cell:Sales!A1", value: number(4) }]),
    );
    expect(crossSheet.changed.get("cell:Costs!B1")).toEqual(number(8));
  });
});

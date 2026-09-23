import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  blank,
  bool,
  configureFunctions,
  createSession,
  createSpreadsheet,
  error,
  evaluate,
  memory,
  number,
  parseSync,
  text,
  type Value,
} from "../src/index.js";

const values = new Map<string, Value>([
  ["cell:A1", number(1)],
  ["cell:A2", number(2)],
  ["cell:A3", number(3)],
  ["cell:B1", number(10)],
  ["cell:B2", number(20)],
  ["cell:B3", number(30)],
  ["cell:C1", text("Alpha")],
  ["cell:C2", text("alpha")],
  ["cell:C3", blank],
  ["cell:D1", bool(true)],
  ["cell:D2", bool(false)],
  ["cell:D3", number(1)],
]);
const run = (formula: string, functions = configureFunctions()) =>
  Effect.runPromise(
    evaluate(parseSync(formula)).pipe(Effect.provide(Layer.merge(memory(values), functions))),
  );

describe("OpenFormula criteria functions", () => {
  it("matches numeric, text, logical, and blank criteria", async () => {
    expect(await run('=COUNTIF(A1:A3;">1")')).toEqual(number(2));
    expect(await run('=COUNTIF(C1:C3;"alpha")')).toEqual(number(2));
    expect(await run('=COUNTIF(C1:C3;"=")')).toEqual(number(1));
    expect(await run('=COUNTIF(C1:C3;"<>")')).toEqual(number(2));
    expect(await run('=COUNTIF(C1:C3;"<>Alpha")')).toEqual(number(1));
    expect(await run('=COUNTIF(C1:C3;"=0")')).toEqual(number(0));
    expect(await run("=COUNTIF(D1:D3;TRUE())")).toEqual(number(1));
    expect(await run("=COUNTIF(A1:A3;A2)")).toEqual(number(1));
  });
  it("uses the result range top-left cell and source dimensions", async () => {
    expect(await run('=SUMIF(A1:A3;">1";B1)')).toEqual(number(50));
    expect(await run('=AVERAGEIF(A1:A3;">1";B1:B2)')).toEqual(number(25));
    expect(await run('=SUMIF(A1:A3;">1")')).toEqual(number(5));
    expect(await run('=AVERAGEIF(A1:A3;">3")')).toEqual(error("#DIV/0!"));
  });
  it("requires reference arguments", async () => {
    expect(await run('=COUNTIF(2;">1")')).toEqual(error("#VALUE!"));
    expect(await run('=SUMIF(A1:A3;">1";42)')).toEqual(error("#VALUE!"));
    expect(await run('=AVERAGEIF(A1:A3;">1";"B1")')).toEqual(error("#VALUE!"));
  });
  it("recalculates when an expanded result cell changes", async () => {
    const session = await Effect.runPromise(
      createSession().pipe(Effect.provide(Layer.merge(memory(new Map()), configureFunctions()))),
    );
    await Effect.runPromise(
      session.update([
        { _tag: "Input", key: "cell:A1", value: number(1) },
        { _tag: "Input", key: "cell:A2", value: number(2) },
        { _tag: "Input", key: "cell:A3", value: number(3) },
        { _tag: "Input", key: "cell:B2", value: number(20) },
        { _tag: "Input", key: "cell:B3", value: number(30) },
        { _tag: "Formula", key: "cell:C1", formula: '=SUMIF(A1:A3;">1";B1)' },
      ]),
    );
    expect(await Effect.runPromise(session.get("cell:C1"))).toEqual(number(50));
    const revision = await Effect.runPromise(
      session.update([{ _tag: "Input", key: "cell:B3", value: number(40) }]),
    );
    expect(revision.changed.get("cell:C1")).toEqual(number(60));
  });
});

describe("function configuration", () => {
  it("registers names case-insensitively and overrides built-ins", async () => {
    const functions = configureFunctions({
      register: {
        triple: (args) => Effect.succeed(number((args[0] as { value: number }).value * 3)),
        sum: () => Effect.succeed(number(99)),
      },
    });
    expect(await run("=TRIPLE(7)", functions)).toEqual(number(21));
    expect(await run("=SUM(1;2)", functions)).toEqual(number(99));
  });
  it("removes built-ins and registered functions for a profile", async () => {
    const functions = configureFunctions({
      register: { triple: () => Effect.succeed(number(3)) },
      remove: ["sum", "TRIPLE", "if"],
    });
    expect(await run("=SUM(1;2)", functions)).toEqual(error("#NAME?"));
    expect(await run("=TRIPLE(7)", functions)).toEqual(error("#NAME?"));
    expect(await run("=IF(TRUE();1;2)", functions)).toEqual(error("#NAME?"));
  });
  it("applies a profile to a spreadsheet host", async () => {
    const sheet = await Effect.runPromise(
      createSpreadsheet().pipe(Effect.provide(configureFunctions({ remove: ["SUM"] }))),
    );
    await Effect.runPromise(sheet.set({ A1: { formula: "=SUM(1;2)" } }));
    expect(await Effect.runPromise(sheet.get("A1"))).toEqual(error("#NAME?"));
  });
});

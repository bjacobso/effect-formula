import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { emptyFunctions, error, evaluate, memory, number, parseSync, text } from "../src/index.js";

const run = (formula: string, dateEpoch?: string) =>
  Effect.runPromise(
    evaluate(parseSync(formula), dateEpoch ? { dateEpoch } : {}).pipe(
      Effect.provide(Layer.merge(memory(new Map()), emptyFunctions)),
    ),
  );
const serial = (year: number, month: number, day: number) =>
  (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000;

describe("OpenFormula VALUE and numeric conversion", () => {
  it("accepts invariant, en-US, percentage, and mixed-fraction numbers", async () => {
    const cases: readonly [string, number][] = [
      ["12.5", 12.5],
      ["-1.25e2", -125],
      ["1e3%", 10],
      ["$1,234.50", 1234.5],
      ["1,234.5%", 12.345],
      ["-2 1/2", -2.5],
      ["0 1/4", 0.25],
    ];
    for (const [input, expected] of cases)
      expect(await run(`=VALUE(${JSON.stringify(input)})`)).toEqual(number(expected));
  });

  it("accepts time, ISO date, en-US date, and datetime forms", async () => {
    const cases: readonly [string, number][] = [
      ["2:00", 2 / 24],
      ["02:03:04.5", (2 * 3600 + 3 * 60 + 4.5) / 86400],
      ["2024-02-29", serial(2024, 2, 29)],
      ["5/21/2006", serial(2006, 5, 21)],
      ["5-21-2006", serial(2006, 5, 21)],
      ["Oct 29, 2006", serial(2006, 10, 29)],
      ["29 October 2006", serial(2006, 10, 29)],
      ["2024-02-29T2:03:04", serial(2024, 2, 29) + (2 * 3600 + 3 * 60 + 4) / 86400],
    ];
    for (const [input, expected] of cases) {
      const result = await run(`=VALUE(${JSON.stringify(input)})`);
      expect(result._tag).toBe("Number");
      if (result._tag === "Number") expect(result.value).toBeCloseTo(expected, 9);
    }
    expect(await run('=VALUE("2024-01-02")', "2024-01-01")).toEqual(number(1));
  });

  it("rejects invalid spellings and preserves formula errors", async () => {
    for (const input of ["0x10", "1,23", "2023-02-29", "24:00", "2:60", "not a number"])
      expect(await run(`=VALUE(${JSON.stringify(input)})`)).toEqual(error("#VALUE!"));
    expect(await run("=VALUE(#N/A)")).toEqual(error("#N/A"));
    expect(await run('="0x10"+1')).toEqual(error("#VALUE!"));
    expect(await run('="2.5"+1')).toEqual(number(3.5));
  });

  it("preserves operand types for unary plus and rejects zero to zero power", async () => {
    expect(await run('=+"hello"')).toEqual(text("hello"));
    expect(await run("=+TRUE()")).toEqual({ _tag: "Boolean", value: true });
    expect(await run("=0^0")).toEqual(error("#NUM!"));
    expect(await run("=POWER(0;0)")).toEqual(error("#NUM!"));
  });
});

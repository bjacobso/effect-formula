import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { emptyFunctions, evaluate, memory, parseSync, type Value } from "../src/index.js";

interface Case {
  readonly name: string;
  readonly formula: string;
  readonly bindings?: Readonly<Record<string, Value>>;
  readonly expected: Value;
}
interface Rule {
  readonly id: string;
  readonly section: string;
  readonly status: "partial" | "extension";
  readonly cases: readonly Case[];
}
interface Unsupported {
  readonly id: string;
  readonly section: string;
  readonly reason: string;
}
interface Matrix {
  readonly standard: string;
  readonly url: string;
  readonly rules: readonly Rule[];
  readonly unsupported: readonly Unsupported[];
}
const matrix = JSON.parse(
  readFileSync(new URL("../conformance/rules.json", import.meta.url), "utf8"),
) as Matrix;

describe("compatibility matrix", () => {
  it("gives every checked rule an id, source section, and independent cases", () => {
    expect(matrix.standard).toBe("OpenFormula 1.4");
    const ids = [...matrix.rules, ...matrix.unsupported].map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of matrix.rules) {
      expect(rule.section).toBeTruthy();
      expect(rule.cases.length).toBeGreaterThan(0);
      expect(new Set(rule.cases.map((sample) => sample.name)).size).toBe(rule.cases.length);
    }
    for (const rule of matrix.unsupported) {
      expect(rule.section).toBeTruthy();
      expect(rule.reason).toBeTruthy();
    }
  });
  for (const rule of matrix.rules)
    for (const sample of rule.cases) {
      it(`${rule.id}: ${sample.name}`, async () => {
        const ast = parseSync(sample.formula);
        const bindings = new Map(Object.entries(sample.bindings ?? {}));
        const result = await Effect.runPromise(
          evaluate(ast).pipe(Effect.provide(Layer.merge(memory(bindings), emptyFunctions))),
        );
        expect(result).toEqual(sample.expected);
      });
    }
});

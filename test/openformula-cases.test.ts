import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { emptyFunctions, evaluate, memory, parseSync, type Value } from "../src/index.js";

interface Sample {
  readonly id: string;
  readonly name: string;
  readonly formula: string;
  readonly bindings?: Readonly<Record<string, Value>>;
  readonly expected: Value;
}
interface Group {
  readonly functions: readonly { readonly name: string; readonly section: string }[];
  readonly requirements: readonly { readonly id: string; readonly section: string }[];
}
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../conformance/${name}`, import.meta.url), "utf8"));
const inventory = read("openformula-1.4-inventory.json") as { readonly groups: readonly Group[] };
const samples = (read("openformula-cases.json") as { readonly cases: readonly Sample[] }).cases;

describe("OpenFormula 1.4 inventory", () => {
  it("tracks every group entry and maps each executable case to a requirement", () => {
    expect(inventory.groups.map((group) => group.functions.length)).toEqual([110, 162, 116]);
    const ids = inventory.groups.flatMap((group) => [
      ...group.functions.map((fn) => `function.${fn.name}`),
      ...group.requirements.map((requirement) => requirement.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const sample of samples) expect(ids).toContain(sample.id);
    expect(new Set(samples.map((sample) => `${sample.id}/${sample.name}`)).size).toBe(
      samples.length,
    );
  });
  for (const sample of samples) {
    it(`${sample.id}: ${sample.name}`, async () => {
      const ast = parseSync(sample.formula);
      const values = new Map(Object.entries(sample.bindings ?? {}));
      const result = await Effect.runPromise(
        evaluate(ast).pipe(Effect.provide(Layer.merge(memory(values), emptyFunctions))),
      );
      expect(result).toEqual(sample.expected);
    });
  }
});

import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { emptyFunctions, evaluate, memory, parseSync, type Value } from "../src/index.js";

interface Sample {
  readonly id: string;
  readonly name: string;
  readonly formula: string;
  readonly bindings?: Readonly<Record<string, Value>>;
  readonly preset?: string;
  readonly clock?: string;
  readonly grid?: { readonly rows: number; readonly columns: number };
  readonly tolerance?: number;
  readonly expected: Value;
}
interface Group {
  readonly functions: readonly { readonly name: string; readonly section: string }[];
  readonly requirements: readonly { readonly id: string; readonly section: string }[];
}
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../conformance/${name}`, import.meta.url), "utf8"));
const inventory = read("openformula-1.4-inventory.json") as { readonly groups: readonly Group[] };
const corpus = read("openformula-cases.json") as {
  readonly cases: readonly Sample[];
  readonly presets?: Readonly<Record<string, Readonly<Record<string, Value>>>>;
};
const audits = read("audits.json") as { readonly verified: readonly string[] };
const samples = corpus.cases;

describe("OpenFormula 1.4 inventory", () => {
  it("tracks every group entry and maps each executable case to a requirement", () => {
    expect(inventory.groups.map((group) => group.functions.length)).toEqual([110, 162, 116]);
    const ids = inventory.groups.flatMap((group) => [
      ...group.functions.map((fn) => `function.${fn.name}`),
      ...group.requirements.map((requirement) => requirement.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(audits.verified).size).toBe(audits.verified.length);
    for (const id of audits.verified) {
      expect(ids).toContain(id);
      expect(samples.some((sample) => sample.id === id)).toBe(true);
    }
    for (const sample of samples) expect(ids).toContain(sample.id);
    const sampled = new Set(samples.map((sample) => sample.id));
    for (const fn of inventory.groups[0]!.functions)
      expect(sampled.has(`function.${fn.name}`)).toBe(true);
    for (const requirement of inventory.groups[0]!.requirements)
      expect(sampled.has(requirement.id)).toBe(true);
    for (const sample of samples)
      if (sample.preset) expect(corpus.presets).toHaveProperty(sample.preset);
    expect(new Set(samples.map((sample) => `${sample.id}/${sample.name}`)).size).toBe(
      samples.length,
    );
  });
  for (const sample of samples) {
    it(`${sample.id}: ${sample.name}`, async () => {
      const ast = parseSync(sample.formula);
      const values = new Map(
        Object.entries({ ...corpus.presets?.[sample.preset ?? ""], ...sample.bindings }),
      );
      const result = await Effect.runPromise(
        evaluate(ast, {
          ...(sample.clock ? { clock: () => new Date(sample.clock!) } : {}),
          ...(sample.grid ? { grid: sample.grid } : {}),
        }).pipe(Effect.provide(Layer.merge(memory(values), emptyFunctions))),
      );
      if (
        sample.tolerance !== undefined &&
        result._tag === "Number" &&
        sample.expected._tag === "Number"
      )
        expect(Math.abs(result.value - sample.expected.value)).toBeLessThanOrEqual(
          sample.tolerance,
        );
      else expect(result).toEqual(sample.expected);
    });
  }
});

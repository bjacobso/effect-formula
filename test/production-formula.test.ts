import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  blank,
  bool,
  createSession,
  emptyFunctions,
  evaluate,
  memory,
  number,
  parseSync,
  references,
  type Scalar,
  text,
  type Update,
  type Value,
} from "../src/index.js";
import {
  type FormulaResult,
  PRODUCTION_FORMULA_FIXTURES,
  PRODUCTION_QUIZ_FIXTURE,
} from "./production-formula.fixtures.js";

type EvaluationMode = "browser" | "server";

// Test host policy for these synthetic answers, not a public input converter.
// Multi-selects become searchable text. Only canonical safe integer strings in
// this corpus become Numbers; leading zeros, long identifiers and dates stay Text.
// The original application's convertValue implementation was not supplied.
const inputValue = (value: unknown): Scalar => {
  if (value === undefined || value === null) return blank;
  if (typeof value === "boolean") return bool(value);
  if (typeof value === "number") return number(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
    return text(value.join(","));
  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && String(numeric) === value
      ? number(numeric)
      : text(value);
  }
  throw new Error("Unsupported production fixture input");
};

const resultOf = (value: Value): FormulaResult => {
  switch (value._tag) {
    case "Blank":
      return null;
    case "Number":
    case "Text":
    case "Boolean":
      return value.value;
    case "Error":
      return { error: value.code };
    case "Range":
      throw new Error("Production formulas must return a scalar");
  }
};

const nameKey = (name: string) => `name:${name.toUpperCase()}`;
const options = { compatibility: "hyperformula" } as const;
const services = (values: ReadonlyMap<string, Value> = new Map()) =>
  Layer.merge(memory(values), emptyFunctions);

// Keep original expressions and literals. Every form reference is a declared
// field, so omitted answers are bound to Blank. Browser mode also binds bare
// names such as null; server mode leaves those names unresolved, as in the source.
const run = async (
  formula: string,
  data: Readonly<Record<string, unknown>>,
  mode: EvaluationMode,
) => {
  const ast = parseSync(formula, { dialect: "excel" });
  const values = new Map<string, Value>();
  for (const key of references(ast)) {
    if (mode === "browser" || key.startsWith("name:FORM."))
      values.set(key, inputValue(data[key.slice("name:".length).toLowerCase()]));
  }
  if (mode === "browser")
    return resultOf(
      await Effect.runPromise(evaluate(ast, options).pipe(Effect.provide(services(values)))),
    );

  const session = await Effect.runPromise(createSession(options).pipe(Effect.provide(services())));
  await Effect.runPromise(
    session.update([
      { _tag: "Formula", key: nameKey("form.conformance_result"), formula: ast },
      ...[...values].map(([key, value]): Update => ({ _tag: "Input", key, value })),
    ]),
  );
  return resultOf(await Effect.runPromise(session.get(nameKey("form.conformance_result"))));
};

interface ParityGap {
  readonly reason: string;
  readonly browser: FormulaResult;
  readonly server?: FormulaResult;
}

// Keep the supplied expectations intact. These are explicit diagnostic gaps,
// not alternative parity targets. Remove entries when compatibility improves;
// it.fails then reports an unexpected pass until the gap is removed.
const parityGaps: Readonly<Record<string, Readonly<Record<string, ParityGap>>>> = {};
const strictParity = process.env.PRODUCTION_PARITY_STRICT === "1";

describe.each(["browser", "server"] as const)("%s production formula parity", (mode) => {
  describe.each(PRODUCTION_FORMULA_FIXTURES)("$label", ({ label, formula, cases }) => {
    for (const { label: caseLabel, data, expected, serverExpected } of cases) {
      const target = mode === "server" && serverExpected !== undefined ? serverExpected : expected;
      const gap = parityGaps[label]?.[caseLabel];
      const parityTest = gap && !strictParity ? it.fails : it;
      parityTest(gap ? `${caseLabel} (known parity gap: ${gap.reason})` : caseLabel, async () => {
        expect(await run(formula, data, mode)).toEqual(target);
      });
      if (gap) {
        // A normal assertion also pins the actual result, so a parser or Effect
        // failure cannot accidentally satisfy an expected-failure parity test.
        it(`${caseLabel}: documents current engine behavior`, async () => {
          const current = mode === "server" && gap.server !== undefined ? gap.server : gap.browser;
          expect(await run(formula, data, mode)).toEqual(current);
          expect(current).not.toEqual(target);
        });
      }
    }
  });
});

const quizTotalKey = nameKey("form.conformance_quiz_total");

const createQuizSession = async (data: Readonly<Record<string, unknown>>) => {
  const session = await Effect.runPromise(
    createSession({ ...options, dialect: "excel" }).pipe(Effect.provide(services())),
  );
  const formulas = Object.entries(PRODUCTION_QUIZ_FIXTURE.formulas);
  const computedKeys = new Set(formulas.map(([name]) => nameKey(name)));
  const inputKeys = new Set(
    formulas.flatMap(([, formula]) => [...references(parseSync(formula, { dialect: "excel" }))]),
  );
  // Dependents first: form fields may be stored in any page order.
  const updates: Update[] = [
    { _tag: "Formula", key: quizTotalKey, formula: PRODUCTION_QUIZ_FIXTURE.totalFormula },
    ...[...formulas]
      .reverse()
      .map(([name, formula]): Update => ({ _tag: "Formula", key: nameKey(name), formula })),
  ];
  for (const key of inputKeys) {
    if (!computedKeys.has(key))
      updates.push({
        _tag: "Input",
        key,
        value: inputValue(data[key.slice("name:".length).toLowerCase()]),
      });
  }
  await Effect.runPromise(session.update(updates));
  return session;
};

describe("production quiz formula dependencies", () => {
  it.each(PRODUCTION_QUIZ_FIXTURE.cases)("$label", async ({ data, expected }) => {
    const session = await createQuizSession(data);
    expect(resultOf(await Effect.runPromise(session.get(quizTotalKey)))).toEqual(expected);
  });

  it("recalculates the total when underlying answers change", async () => {
    const allCorrect = PRODUCTION_QUIZ_FIXTURE.cases.find(
      (example) => example.label === "all correct choices",
    )!;
    const session = await createQuizSession(allCorrect.data);
    expect(await Effect.runPromise(session.get(quizTotalKey))).toEqual(number(7));
    for (const [name, answer, expected] of [
      ["form.multi_select_q2", ["report_it"], 5],
      ["form.radio_q1", "wrong", 4],
      ["form.multi_select_q3", [], 1],
    ] as const) {
      const revision = await Effect.runPromise(
        session.update([{ _tag: "Input", key: nameKey(name), value: inputValue(answer) }]),
      );
      expect(revision.changed.get(quizTotalKey)).toEqual(number(expected));
      expect(await Effect.runPromise(session.get(quizTotalKey))).toEqual(number(expected));
    }
  });
});

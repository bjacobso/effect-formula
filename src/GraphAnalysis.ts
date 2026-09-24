import { Effect, Option } from "effect";
import { FormulaAnalysisError, type FormulaAnalysisOptions, formulaInputs } from "./Analysis.js";
import type { FunctionRegistryService } from "./Engine.js";
import type { Ast } from "./Parser.js";
import {
  analyzeFormulaTypes,
  type FormulaInputType,
  type FormulaTypeAnalysis,
} from "./TypeAnalysis.js";

export interface FormulaGraphAnalysis {
  readonly formulas: ReadonlyMap<string, FormulaTypeAnalysis>;
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  readonly cycles: readonly (readonly string[])[];
}

/** Analyze formula results in dependency order, using declared types for non-formula inputs. */
export const analyzeFormulaGraph = (
  formulas: ReadonlyMap<string, Ast>,
  inputTypes: Readonly<Record<string, FormulaInputType>>,
  options: FormulaAnalysisOptions = {},
  registry?: FunctionRegistryService,
): Effect.Effect<FormulaGraphAnalysis, FormulaAnalysisError> =>
  Effect.gen(function* () {
    const sources = new Map(formulas);
    const declaredTypes = { ...inputTypes };
    const dependencies = new Map<string, readonly string[]>();
    for (const [key, ast] of sources) dependencies.set(key, yield* formulaInputs(ast, options));

    const results = new Map<string, FormulaTypeAnalysis>();
    const visiting = new Set<string>();
    const cyclic = new Set<string>();
    const stack: string[] = [];
    const cycles: string[][] = [];
    const visit = (key: string): Effect.Effect<FormulaTypeAnalysis, FormulaAnalysisError> =>
      Effect.gen(function* () {
        const finished = Option.fromNullable(results.get(key));
        if (Option.isSome(finished)) return finished.value;
        if (visiting.has(key)) {
          const members = stack.slice(stack.indexOf(key));
          for (const member of members) cyclic.add(member);
          cycles.push(members);
          return { types: ["Error"], diagnostics: [] } satisfies FormulaTypeAnalysis;
        }
        visiting.add(key);
        stack.push(key);
        const resolved: Record<string, FormulaInputType> = { ...declaredTypes };
        for (const dependency of dependencies.get(key) ?? [])
          if (sources.has(dependency)) resolved[dependency] = (yield* visit(dependency)).types;
        stack.pop();
        visiting.delete(key);

        const ast = Option.fromNullable(sources.get(key));
        if (Option.isNone(ast))
          return yield* Effect.fail(
            new FormulaAnalysisError({ message: `Formula ${key} disappeared during analysis` }),
          );
        const result: FormulaTypeAnalysis = cyclic.has(key)
          ? {
              types: ["Error"],
              diagnostics: [
                {
                  path: "root",
                  severity: "definite",
                  message: "Cyclic formula dependency",
                  ...(ast.value.span ? { span: ast.value.span } : {}),
                },
              ],
            }
          : yield* analyzeFormulaTypes(ast.value, resolved, registry);
        results.set(key, result);
        return result;
      });
    for (const key of sources.keys()) yield* visit(key);
    return { formulas: results, dependencies, cycles };
  });

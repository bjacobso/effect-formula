import { Data, Effect, Option, Schema } from "effect";
import type { GridBounds } from "./Address.js";
import { offsetReferenceKeys, rangeKeys } from "./Engine.js";
import type { Ast } from "./Parser.js";

export class FormulaAnalysisError extends Data.TaggedError("FormulaAnalysisError")<{
  readonly message: string;
}> {}

export interface FormulaAnalysisOptions {
  readonly maxRangeCells?: number;
  readonly grid?: GridBounds;
}

/** Collect canonical keys used by a formula, expanding ranges into individual cells. */
export const formulaInputs = (
  ast: Ast,
  options: FormulaAnalysisOptions = {},
): Effect.Effect<readonly string[], FormulaAnalysisError> =>
  Effect.gen(function* () {
    const keys = new Set<string>();
    const visit = (node: Ast): Effect.Effect<void, FormulaAnalysisError> =>
      Effect.gen(function* () {
        switch (node._tag) {
          case "Reference":
            keys.add(node.key);
            break;
          case "Range": {
            const cells = rangeKeys(
              node.start,
              node.end,
              options.maxRangeCells ?? 10000,
              options.grid,
            );
            if (Option.isNone(cells))
              return yield* Effect.fail(
                new FormulaAnalysisError({
                  message: `Cannot expand range ${node.start}:${node.end}`,
                }),
              );
            for (const row of cells.value) for (const key of row) keys.add(key);
            break;
          }
          case "Unary":
            yield* visit(node.value);
            break;
          case "Binary":
            yield* visit(node.left);
            yield* visit(node.right);
            break;
          case "Call":
            if (
              (node.name === "SUMIF" || node.name === "AVERAGEIF") &&
              node.args[0] &&
              node.args[2]
            ) {
              const offset = offsetReferenceKeys(
                node.args[0],
                node.args[2],
                options.maxRangeCells ?? 10000,
                options.grid,
              );
              if (Option.isSome(offset))
                for (const row of offset.value) for (const key of row) keys.add(key);
            }
            for (const arg of node.args) yield* visit(arg);
            break;
        }
      });
    yield* visit(ast);
    return [...keys];
  });

/** Require an explicit host schema for every referenced key. */
export const formulaInputSchema = (
  ast: Ast,
  schemas: Readonly<Record<string, Schema.Schema.AnyNoContext>>,
  options: FormulaAnalysisOptions = {},
): Effect.Effect<Schema.Schema.AnyNoContext, FormulaAnalysisError> =>
  Effect.gen(function* () {
    const keys = yield* formulaInputs(ast, options);
    const fields: Record<string, Schema.Schema.AnyNoContext> = {};
    for (const key of keys) {
      const schema = Option.fromNullable(schemas[key]);
      if (Option.isNone(schema))
        return yield* Effect.fail(
          new FormulaAnalysisError({ message: `Missing schema for ${key}` }),
        );
      fields[key] = schema.value;
    }
    return Schema.Struct(fields);
  });

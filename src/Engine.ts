import { Context, Data, Effect, Layer } from "effect";
import type { Ast } from "./Parser.js";
import type { Scalar, Value } from "./Value.js";
import {
  bool,
  entries,
  error,
  isError,
  number,
  range,
  scalar,
  text,
  toBoolean,
  toNumber,
  toText,
} from "./Value.js";

export class ResolutionFailure extends Data.TaggedError("ResolutionFailure")<{
  readonly key: string;
  readonly message: string;
}> {}
export class EvaluationFailure extends Data.TaggedError("EvaluationFailure")<{
  readonly message: string;
}> {}
export interface ReferenceResolverService {
  readonly get: (key: string) => Effect.Effect<Value, ResolutionFailure | EvaluationFailure>;
}
export class ReferenceResolver extends Context.Tag("effect-formula/ReferenceResolver")<
  ReferenceResolver,
  ReferenceResolverService
>() {}
export type CustomFunction = (args: readonly Value[]) => Effect.Effect<Value, EvaluationFailure>;
export interface FunctionRegistryService {
  readonly functions: ReadonlyMap<string, CustomFunction>;
}
export class FunctionRegistry extends Context.Tag("effect-formula/FunctionRegistry")<
  FunctionRegistry,
  FunctionRegistryService
>() {}
export const emptyFunctions = Layer.succeed(FunctionRegistry, { functions: new Map() });
export const memory = (values: ReadonlyMap<string, Value>) =>
  Layer.succeed(ReferenceResolver, {
    get: (key: string) => Effect.succeed(values.get(key) ?? error("#REF!")),
  });
export interface EvalOptions {
  readonly maxSteps?: number;
  readonly maxRangeCells?: number;
}
function cell(key: string): { col: number; row: number } | undefined {
  const match = /^cell:([A-Z]+)([1-9][0-9]*)$/.exec(key);
  if (!match) return undefined;
  let col = 0;
  for (const letter of match[1]!) col = col * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  return Number.isSafeInteger(col) && Number.isSafeInteger(row) ? { col, row } : undefined;
}
function keyOf(col: number, row: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return `cell:${name}${row}`;
}
export function rangeKeys(
  start: string,
  end: string,
  max = 10000,
): readonly (readonly string[])[] | undefined {
  const a = cell(start);
  const b = cell(end);
  if (!a || !b) return undefined;
  const width = Math.abs(b.col - a.col) + 1;
  const height = Math.abs(b.row - a.row) + 1;
  if (!Number.isSafeInteger(width * height) || width * height > max) return undefined;
  const rows: string[][] = [];
  for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) {
    const keys: string[] = [];
    for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col++)
      keys.push(keyOf(col, row));
    rows.push(keys);
  }
  return rows;
}
function arithmetic(op: string, left: Scalar, right: Scalar): Scalar {
  if (isError(left)) return left;
  if (isError(right)) return right;
  if (op === "&") {
    const a = toText(left);
    const b = toText(right);
    return isError(a) ? a : isError(b) ? b : text(a.value + b.value);
  }
  if (["=", "<>", "<", "<=", ">", ">="].includes(op)) {
    const numeric = left._tag === "Number" && right._tag === "Number";
    const a = numeric ? left.value : toText(left);
    const b = numeric ? (right as Extract<Scalar, { _tag: "Number" }>).value : toText(right);
    if (typeof a !== "number" && isError(a)) return a;
    if (typeof b !== "number" && isError(b)) return b;
    const x = typeof a === "number" ? a : a.value.toLowerCase();
    const y = typeof b === "number" ? b : b.value.toLowerCase();
    switch (op) {
      case "=":
        return bool(x === y);
      case "<>":
        return bool(x !== y);
      case "<":
        return bool(x < y);
      case "<=":
        return bool(x <= y);
      case ">":
        return bool(x > y);
      default:
        return bool(x >= y);
    }
  }
  const a = toNumber(left);
  const b = toNumber(right);
  if (isError(a)) return a;
  if (isError(b)) return b;
  switch (op) {
    case "+":
      return number(a.value + b.value);
    case "-":
      return number(a.value - b.value);
    case "*":
      return number(a.value * b.value);
    case "/":
      return b.value === 0 ? error("#DIV/0!") : number(a.value / b.value);
    case "^":
      return number(a.value ** b.value);
    default:
      return error("#VALUE!");
  }
}
function aggregate(name: string, args: readonly Value[]): Scalar {
  const values = args.flatMap(entries);
  const failed = values.find(isError);
  if (failed) return failed;
  const numbers: number[] = [];
  for (const arg of args) {
    for (const value of entries(arg)) {
      if (value._tag === "Number") numbers.push(value.value);
      else if (arg._tag !== "Range" && value._tag !== "Blank") {
        const converted = toNumber(value);
        if (isError(converted)) return converted;
        numbers.push(converted.value);
      }
    }
  }
  switch (name) {
    case "COUNT":
      return number(numbers.length);
    case "SUM":
      return number(numbers.reduce((a, b) => a + b, 0));
    case "AVERAGE":
      return numbers.length
        ? number(numbers.reduce((a, b) => a + b, 0) / numbers.length)
        : error("#DIV/0!");
    case "MIN":
      return number(numbers.length ? Math.min(...numbers) : 0);
    default:
      return number(numbers.length ? Math.max(...numbers) : 0);
  }
}
export function evaluate(
  ast: Ast,
  options: EvalOptions = {},
): Effect.Effect<
  Value,
  ResolutionFailure | EvaluationFailure,
  ReferenceResolver | FunctionRegistry
> {
  return Effect.gen(function* () {
    const resolver = yield* ReferenceResolver;
    const registry = yield* FunctionRegistry;
    let steps = 0;
    const visit = (node: Ast): Effect.Effect<Value, ResolutionFailure | EvaluationFailure> =>
      Effect.gen(function* () {
        if (++steps > (options.maxSteps ?? 100000))
          return yield* Effect.fail(
            new EvaluationFailure({ message: "Evaluation step limit exceeded" }),
          );
        switch (node._tag) {
          case "Literal":
            return node.value;
          case "Reference":
            return yield* resolver.get(node.key);
          case "Range": {
            const keys = rangeKeys(node.start, node.end, options.maxRangeCells ?? 10000);
            if (!keys) return error("#REF!");
            const rows: Scalar[][] = [];
            for (const row of keys) {
              const values: Scalar[] = [];
              for (const key of row) values.push(scalar(yield* resolver.get(key)));
              rows.push(values);
            }
            return range(rows);
          }
          case "Unary": {
            const value = toNumber(scalar(yield* visit(node.value)));
            return isError(value)
              ? value
              : number(node.operator === "-" ? -value.value : value.value);
          }
          case "Binary":
            return arithmetic(
              node.operator,
              scalar(yield* visit(node.left)),
              scalar(yield* visit(node.right)),
            );
          case "Call": {
            const name = node.name;
            if (name === "IF") {
              if (node.args.length < 2 || node.args.length > 3) return error("#VALUE!");
              const condition = toBoolean(scalar(yield* visit(node.args[0]!)));
              if (isError(condition)) return condition;
              return condition.value
                ? yield* visit(node.args[1]!)
                : node.args[2]
                  ? yield* visit(node.args[2])
                  : bool(false);
            }
            if (name === "IFERROR") {
              if (node.args.length !== 2) return error("#VALUE!");
              const value = yield* visit(node.args[0]!);
              return isError(value) ? yield* visit(node.args[1]!) : value;
            }
            if (name === "AND" || name === "OR") {
              if (!node.args.length) return error("#VALUE!");
              let result = name === "AND";
              for (const arg of node.args)
                for (const entry of entries(yield* visit(arg))) {
                  const value = toBoolean(entry);
                  if (isError(value)) return value;
                  result = name === "AND" ? result && value.value : result || value.value;
                }
              return bool(result);
            }
            if (name === "NOT") {
              if (node.args.length !== 1) return error("#VALUE!");
              const value = toBoolean(scalar(yield* visit(node.args[0]!)));
              return isError(value) ? value : bool(!value.value);
            }
            const args: Value[] = [];
            for (const arg of node.args) args.push(yield* visit(arg));
            if (["SUM", "AVERAGE", "MIN", "MAX", "COUNT"].includes(name))
              return aggregate(name, args);
            const custom = registry.functions.get(name);
            return custom ? yield* custom(args) : error("#NAME?");
          }
        }
      });
    return yield* visit(ast);
  });
}

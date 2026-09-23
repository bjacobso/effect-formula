import { Context, Data, Effect, Layer } from "effect";
import type { Ast } from "./Parser.js";
import type { Scalar, Value } from "./Value.js";
import {
  blank,
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
    if (op === "=" || op === "<>") {
      let equal = false;
      if (left._tag === right._tag) {
        switch (left._tag) {
          case "Blank":
            equal = true;
            break;
          case "Number":
            equal = left.value === (right as typeof left).value;
            break;
          case "Boolean":
            equal = left.value === (right as typeof left).value;
            break;
          case "Text":
            equal = left.value.toLowerCase() === (right as typeof left).value.toLowerCase();
            break;
        }
      }
      return bool(op === "=" ? equal : !equal);
    }
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
  if (name === "COUNT") return number(values.filter((value) => value._tag === "Number").length);
  if (name === "COUNTA") return number(values.filter((value) => value._tag !== "Blank").length);
  if (name === "COUNTBLANK") return number(values.filter((value) => value._tag === "Blank").length);
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
function builtIn(name: string, args: readonly Value[]): Scalar | undefined {
  const unary = (fn: (value: number) => number): Scalar => {
    if (args.length !== 1) return error("#VALUE!");
    const value = toNumber(scalar(args[0]!));
    return isError(value) ? value : number(fn(value.value));
  };
  const binary = (fn: (left: number, right: number) => Scalar): Scalar => {
    if (args.length !== 2) return error("#VALUE!");
    const left = toNumber(scalar(args[0]!));
    const right = toNumber(scalar(args[1]!));
    if (isError(left)) return left;
    if (isError(right)) return right;
    return fn(left.value, right.value);
  };
  const stringArg = (index: number): Extract<Scalar, { _tag: "Text" | "Error" }> =>
    toText(scalar(args[index]!));
  const countArg = (index: number): Extract<Scalar, { _tag: "Number" | "Error" }> =>
    toNumber(scalar(args[index]!));
  switch (name) {
    case "TRUE":
      return args.length ? error("#VALUE!") : bool(true);
    case "FALSE":
      return args.length ? error("#VALUE!") : bool(false);
    case "PI":
      return args.length ? error("#VALUE!") : number(Math.PI);
    case "NA":
      return args.length ? error("#VALUE!") : error("#N/A");
    case "ABS":
      return unary(Math.abs);
    case "ACOS":
      return unary(Math.acos);
    case "ASIN":
      return unary(Math.asin);
    case "ATAN":
      return unary(Math.atan);
    case "COS":
      return unary(Math.cos);
    case "SIN":
      return unary(Math.sin);
    case "TAN":
      return unary(Math.tan);
    case "EXP":
      return unary(Math.exp);
    case "LN":
      return unary(Math.log);
    case "LOG10":
      return unary(Math.log10);
    case "DEGREES":
      return unary((value) => (value * 180) / Math.PI);
    case "RADIANS":
      return unary((value) => (value * Math.PI) / 180);
    case "EVEN":
      return unary((value) => Math.sign(value) * Math.ceil(Math.abs(value) / 2) * 2);
    case "ODD":
      return unary((value) =>
        value === 0 ? 1 : Math.sign(value) * (2 * Math.ceil((Math.abs(value) - 1) / 2) + 1),
      );
    case "FACT":
      return unary((value) => {
        const n = Math.trunc(value);
        if (n < 0 || n > 170) return Number.NaN;
        let result = 1;
        for (let i = 2; i <= n; i++) result *= i;
        return result;
      });
    case "SQRT":
      return unary(Math.sqrt);
    case "INT":
      return unary(Math.floor);
    case "POWER":
      return binary((left, right) => number(left ** right));
    case "ATAN2":
      return binary((x, y) => (x === 0 && y === 0 ? error("#NUM!") : number(Math.atan2(y, x))));
    case "MOD":
      return binary((left, right) =>
        right === 0 ? error("#DIV/0!") : number(left - right * Math.floor(left / right)),
      );
    case "ROUND": {
      if (args.length < 1 || args.length > 2) return error("#VALUE!");
      const value = toNumber(scalar(args[0]!));
      const digits = args[1] ? toNumber(scalar(args[1])) : number(0);
      if (isError(value)) return value;
      if (isError(digits)) return digits;
      const factor = 10 ** Math.trunc(digits.value);
      return number((Math.sign(value.value) * Math.round(Math.abs(value.value) * factor)) / factor);
    }
    case "LOG": {
      if (args.length < 1 || args.length > 2) return error("#VALUE!");
      const value = toNumber(scalar(args[0]!));
      const base = args[1] ? toNumber(scalar(args[1])) : number(10);
      if (isError(value)) return value;
      if (isError(base)) return base;
      return value.value <= 0 || base.value <= 0 || base.value === 1
        ? error("#NUM!")
        : number(Math.log(value.value) / Math.log(base.value));
    }
    case "TRUNC": {
      if (args.length < 1 || args.length > 2) return error("#VALUE!");
      const value = toNumber(scalar(args[0]!));
      const digits = args[1] ? toNumber(scalar(args[1])) : number(0);
      if (isError(value)) return value;
      if (isError(digits)) return digits;
      const factor = 10 ** Math.trunc(digits.value);
      return number(Math.trunc(value.value * factor) / factor);
    }
    case "LEN":
    case "LOWER":
    case "UPPER":
    case "TRIM": {
      if (args.length !== 1) return error("#VALUE!");
      const value = stringArg(0);
      if (isError(value)) return value;
      if (name === "LEN") return number(Array.from(value.value).length);
      if (name === "LOWER") return text(value.value.toLowerCase());
      if (name === "UPPER") return text(value.value.toUpperCase());
      return text(value.value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "").replace(/[\t\n\r ]+/g, " "));
    }
    case "LEFT":
    case "RIGHT": {
      if (args.length < 1 || args.length > 2) return error("#VALUE!");
      const value = stringArg(0);
      const length = args.length === 2 ? countArg(1) : number(1);
      if (isError(value)) return value;
      if (isError(length)) return length;
      if (length.value < 0) return error("#VALUE!");
      const chars = Array.from(value.value);
      const n = Math.trunc(length.value);
      return text(
        (name === "LEFT" ? chars.slice(0, n) : chars.slice(Math.max(0, chars.length - n))).join(""),
      );
    }
    case "MID": {
      if (args.length !== 3) return error("#VALUE!");
      const value = stringArg(0);
      const start = countArg(1);
      const length = countArg(2);
      if (isError(value)) return value;
      if (isError(start)) return start;
      if (isError(length)) return length;
      if (start.value < 1 || length.value < 0) return error("#VALUE!");
      return text(
        Array.from(value.value)
          .slice(
            Math.trunc(start.value) - 1,
            Math.trunc(start.value) - 1 + Math.trunc(length.value),
          )
          .join(""),
      );
    }
    case "EXACT": {
      if (args.length !== 2) return error("#VALUE!");
      const left = stringArg(0);
      const right = stringArg(1);
      return isError(left) ? left : isError(right) ? right : bool(left.value === right.value);
    }
    case "FIND": {
      if (args.length < 2 || args.length > 3) return error("#VALUE!");
      const needle = stringArg(0);
      const haystack = stringArg(1);
      const start = args.length === 3 ? countArg(2) : number(1);
      if (isError(needle)) return needle;
      if (isError(haystack)) return haystack;
      if (isError(start)) return start;
      const chars = Array.from(haystack.value);
      const index = Math.trunc(start.value) - 1;
      if (index < 0 || index > chars.length) return error("#VALUE!");
      const position = chars.slice(index).join("").indexOf(needle.value);
      return position < 0
        ? error("#VALUE!")
        : number(index + Array.from(chars.slice(index).join("").slice(0, position)).length + 1);
    }
    case "REPT": {
      if (args.length !== 2) return error("#VALUE!");
      const value = stringArg(0);
      const count = countArg(1);
      if (isError(value)) return value;
      if (isError(count)) return count;
      if (count.value < 0 || count.value > 32767) return error("#VALUE!");
      return text(value.value.repeat(Math.trunc(count.value)));
    }
    case "N": {
      if (args.length !== 1) return error("#VALUE!");
      const value = scalar(args[0]!);
      return isError(value)
        ? value
        : value._tag === "Number"
          ? value
          : value._tag === "Boolean"
            ? number(value.value ? 1 : 0)
            : number(0);
    }
    case "T": {
      if (args.length !== 1) return error("#VALUE!");
      const value = scalar(args[0]!);
      return isError(value) ? value : value._tag === "Text" ? value : text("");
    }
    case "VALUE": {
      if (args.length !== 1) return error("#VALUE!");
      const value = stringArg(0);
      return isError(value) ? value : toNumber(value);
    }
    case "ROWS":
    case "COLUMNS": {
      if (args.length !== 1) return error("#VALUE!");
      const value = args[0]!;
      if (isError(value)) return value;
      if (value._tag !== "Range") return number(1);
      return number(name === "ROWS" ? value.rows.length : (value.rows[0]?.length ?? 0));
    }
    case "ISBLANK":
      return args.length === 1 ? bool(scalar(args[0]!)._tag === "Blank") : error("#VALUE!");
    case "ISERROR":
      return args.length === 1 ? bool(isError(scalar(args[0]!))) : error("#VALUE!");
    case "ISERR": {
      if (args.length !== 1) return error("#VALUE!");
      const value = scalar(args[0]!);
      return bool(isError(value) && value.code !== "#N/A");
    }
    case "ISNA": {
      if (args.length !== 1) return error("#VALUE!");
      const value = scalar(args[0]!);
      return bool(isError(value) && value.code === "#N/A");
    }
    case "ISNUMBER":
      return args.length === 1 ? bool(scalar(args[0]!)._tag === "Number") : error("#VALUE!");
    case "ISTEXT":
      return args.length === 1 ? bool(scalar(args[0]!)._tag === "Text") : error("#VALUE!");
    case "ISLOGICAL":
      return args.length === 1 ? bool(scalar(args[0]!)._tag === "Boolean") : error("#VALUE!");
    case "ISNONTEXT":
      return args.length === 1 ? bool(scalar(args[0]!)._tag !== "Text") : error("#VALUE!");
  }
  return undefined;
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
          case "Missing":
            return blank;
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
            if (node.operator === "+") return yield* visit(node.value);
            const value = toNumber(scalar(yield* visit(node.value)));
            return isError(value)
              ? value
              : number(node.operator === "-" ? -value.value : value.value / 100);
          }
          case "Binary":
            return arithmetic(
              node.operator,
              scalar(yield* visit(node.left)),
              scalar(yield* visit(node.right)),
            );
          case "Call": {
            const name = node.name;
            if (name === "CHOOSE") {
              if (node.args.length < 2) return error("#VALUE!");
              const index = toNumber(scalar(yield* visit(node.args[0]!)));
              if (isError(index)) return index;
              const selected = Math.trunc(index.value);
              if (selected < 1 || selected >= node.args.length) return error("#VALUE!");
              return yield* visit(node.args[selected]!);
            }
            if (name === "IF") {
              if (node.args.length < 1 || node.args.length > 3) return error("#VALUE!");
              const condition = toBoolean(scalar(yield* visit(node.args[0]!)));
              if (isError(condition)) return condition;
              if (node.args.length === 1) return condition;
              return condition.value
                ? node.args[1]?._tag === "Missing"
                  ? number(0)
                  : yield* visit(node.args[1]!)
                : node.args[2]
                  ? node.args[2]._tag === "Missing"
                    ? number(0)
                    : yield* visit(node.args[2])
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
            if (
              name === "COUNTBLANK" &&
              (node.args.length !== 1 || !["Reference", "Range"].includes(node.args[0]?._tag ?? ""))
            )
              return error("#VALUE!");
            if (["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "COUNTBLANK"].includes(name))
              return aggregate(name, args);
            const built = builtIn(name, args);
            if (built !== undefined) return built;
            const custom = registry.functions.get(name);
            return custom ? yield* custom(args) : error("#NAME?");
          }
        }
      });
    return yield* visit(ast);
  });
}

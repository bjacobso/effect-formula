import { Option } from "effect";
import type { Scalar, Value } from "./Value.js";
import { bool, error, isError, number, range, scalar, toBoolean, toNumber } from "./Value.js";

function table(value: Value): readonly (readonly Scalar[])[] {
  return value._tag === "Range" ? value.rows : [[value]];
}
function compare(left: Scalar, right: Scalar): Option.Option<number> {
  if (isError(left) || isError(right)) return Option.none();
  const rank = (value: Scalar) =>
    value._tag === "Number" ? 0 : value._tag === "Text" ? 1 : value._tag === "Boolean" ? 2 : 3;
  if (rank(left) !== rank(right)) return Option.some(rank(left) - rank(right));
  if (left._tag === "Blank" && right._tag === "Blank") return Option.some(0);
  if (left._tag === "Number" && right._tag === "Number")
    return Option.some(left.value - right.value);
  if (left._tag === "Text" && right._tag === "Text")
    return Option.some(left.value.toLowerCase().localeCompare(right.value.toLowerCase()));
  if (left._tag === "Boolean" && right._tag === "Boolean")
    return Option.some(Number(left.value) - Number(right.value));
  return Option.none();
}
function matchIndex(lookup: Scalar, values: readonly Scalar[], mode: number): number {
  if (mode === 0)
    return values.findIndex((value) => {
      const comparison = compare(value, lookup);
      return Option.isSome(comparison) && comparison.value === 0;
    });
  let found = -1;
  for (let i = 0; i < values.length; i++) {
    const comparison = compare(values[i]!, lookup);
    if (Option.isNone(comparison)) continue;
    if (mode === 1 ? comparison.value <= 0 : comparison.value >= 0) found = i;
  }
  if (found >= 0 && values[found]!._tag !== lookup._tag) return -1;
  return found;
}

const names = new Set(["INDEX", "MATCH", "HLOOKUP", "VLOOKUP"]);
export function smallLookup(name: string, args: readonly Value[]): Option.Option<Value> {
  return names.has(name) ? Option.some(evaluateLookup(name, args)) : Option.none();
}
function evaluateLookup(name: string, args: readonly Value[]): Value {
  if (name === "INDEX") {
    if (args.length < 1 || args.length > 4) return error("#VALUE!");
    const rows = table(args[0]!);
    const row = args[1] ? toNumber(scalar(args[1])) : number(0);
    const col = args[2] ? toNumber(scalar(args[2])) : number(0);
    const area = args[3] ? toNumber(scalar(args[3])) : number(1);
    if (isError(row)) return row;
    if (isError(col)) return col;
    if (isError(area)) return area;
    if (area.value !== 1 || row.value < 0 || col.value < 0) return error("#REF!");
    const r = Math.trunc(row.value);
    const c = Math.trunc(col.value);
    if (r > rows.length || c > (rows[0]?.length ?? 0)) return error("#REF!");
    if (r === 0 && c === 0) return range(rows);
    if (r === 0) return range(rows.map((entry) => [entry[c - 1]!]));
    if (c === 0) return range([rows[r - 1]!]);
    return rows[r - 1]![c - 1]!;
  }
  if (name === "MATCH") {
    if (args.length < 2 || args.length > 3) return error("#VALUE!");
    const lookup = scalar(args[0]!);
    if (isError(lookup)) return lookup;
    const rows = table(args[1]!);
    if (rows.length > 1 && rows[0]!.length > 1) return error("#VALUE!");
    const mode = args[2] ? toNumber(scalar(args[2])) : number(1);
    if (isError(mode)) return mode;
    if (![-1, 0, 1].includes(mode.value)) return error("#VALUE!");
    const candidates = rows.flat();
    const index = matchIndex(lookup, candidates, mode.value);
    return index < 0 ? error("#N/A") : number(index + 1);
  }
  if (name === "HLOOKUP" || name === "VLOOKUP") {
    if (args.length < 3 || args.length > 4) return error("#VALUE!");
    const lookup = scalar(args[0]!);
    if (isError(lookup)) return lookup;
    const rows = table(args[1]!);
    const index = toNumber(scalar(args[2]!));
    const approximate = args[3] ? toBoolean(scalar(args[3])) : bool(true);
    if (isError(index)) return index;
    if (isError(approximate)) return approximate;
    const ordinal = Math.trunc(index.value);
    if (ordinal < 1 || ordinal > (name === "HLOOKUP" ? rows.length : (rows[0]?.length ?? 0)))
      return error("#REF!");
    const candidates = name === "HLOOKUP" ? rows[0]! : rows.map((row) => row[0]!);
    const position = matchIndex(lookup, candidates, approximate.value ? 1 : 0);
    if (position < 0) return error("#N/A");
    return name === "HLOOKUP" ? rows[ordinal - 1]![position]! : rows[position]![ordinal - 1]!;
  }
  return error("#NAME?");
}

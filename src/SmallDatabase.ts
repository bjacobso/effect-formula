import { Option } from "effect";
import { matchesCriterion } from "./Criterion.js";
import type { Scalar, Value } from "./Value.js";
import { error, isError, number, scalar } from "./Value.js";

function fieldIndex(headers: readonly Scalar[], field: Scalar): number {
  if (field._tag === "Number") return Number.isInteger(field.value) ? field.value - 1 : -1;
  if (field._tag === "Text")
    return headers.findIndex(
      (header) =>
        header._tag === "Text" && header.value.toLowerCase() === field.value.toLowerCase(),
    );
  return -1;
}
function numeric(name: string, values: readonly number[]): Scalar {
  if (name === "DCOUNT") return number(values.length);
  if (name === "DSUM") return number(values.reduce((a, b) => a + b, 0));
  if (name === "DPRODUCT") return number(values.reduce((a, b) => a * b, 1));
  if (name === "DMIN") return number(values.length ? Math.min(...values) : 0);
  if (name === "DMAX") return number(values.length ? Math.max(...values) : 0);
  if (name === "DAVERAGE")
    return values.length
      ? number(values.reduce((a, b) => a + b, 0) / values.length)
      : error("#DIV/0!");
  const sample = name === "DSTDEV" || name === "DVAR";
  if (values.length < (sample ? 2 : 1)) return error("#DIV/0!");
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - (sample ? 1 : 0));
  return number(name.startsWith("DSTDEV") ? Math.sqrt(variance) : variance);
}

const names = new Set([
  "DAVERAGE",
  "DCOUNT",
  "DCOUNTA",
  "DGET",
  "DMAX",
  "DMIN",
  "DPRODUCT",
  "DSTDEV",
  "DSTDEVP",
  "DSUM",
  "DVAR",
  "DVARP",
]);
export function smallDatabase(name: string, args: readonly Value[]): Option.Option<Value> {
  return names.has(name) ? Option.some(evaluateDatabase(name, args)) : Option.none();
}
function evaluateDatabase(name: string, args: readonly Value[]): Value {
  if (args.length !== 3 || args[0]?._tag !== "Range" || args[2]?._tag !== "Range")
    return error("#VALUE!");
  const database = args[0].rows;
  const criteria = args[2].rows;
  const headers = database[0];
  const criterionHeaders = criteria[0];
  if (
    !headers?.length ||
    !criterionHeaders?.length ||
    criteria.length < 2 ||
    database.some((row) => row.length !== headers.length) ||
    criteria.some((row) => row.length !== criterionHeaders.length)
  )
    return error("#VALUE!");
  const field = scalar(args[1]!);
  if (isError(field)) return field;
  const fieldIsOptional = name === "DCOUNTA" || name === "DCOUNT";
  const selected = field._tag === "Blank" && fieldIsOptional ? -1 : fieldIndex(headers, field);
  if (selected < 0 && !(field._tag === "Blank" && fieldIsOptional)) return error("#VALUE!");
  if (selected >= headers.length) return error("#VALUE!");
  const criteriaColumns = criterionHeaders.map((header) => fieldIndex(headers, header));
  if (criteriaColumns.some((index) => index < 0 || index >= headers.length))
    return error("#VALUE!");
  const matches = database
    .slice(1)
    .filter((row) =>
      criteria
        .slice(1)
        .some((condition) =>
          condition.every(
            (criterion, index) =>
              criterion._tag === "Blank" ||
              matchesCriterion(row[criteriaColumns[index]!]!, criterion),
          ),
        ),
    );
  if (name === "DGET")
    return matches.length === 1
      ? matches[0]![selected]!
      : error(matches.length ? "#NUM!" : "#VALUE!");
  if (name === "DCOUNTA")
    return number(
      selected < 0
        ? matches.length
        : matches.filter((row) => row[selected]!._tag !== "Blank").length,
    );
  if (name === "DCOUNT" && selected < 0) return number(matches.length);
  const values: number[] = [];
  for (const row of matches) {
    const value = row[selected]!;
    if (isError(value)) return value;
    if (value._tag === "Number") values.push(value.value);
  }
  return numeric(name, values);
}

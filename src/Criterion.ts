import type { Scalar } from "./Value.js";
import { isError, number, text, toNumber } from "./Value.js";

/** The default criterion profile uses whole-cell, case-insensitive text matching. */
export function matchesCriterion(cell: Scalar, input: Scalar): boolean {
  if (isError(cell) || isError(input)) return false;
  const criterion = input._tag === "Blank" ? number(0) : input;
  if (criterion._tag === "Number" || criterion._tag === "Boolean")
    return cell._tag === criterion._tag && cell.value === criterion.value;
  if (criterion._tag !== "Text") return false;

  const match = /^(<=|>=|<>|=|<|>)(.*)$/s.exec(criterion.value);
  const operator = match?.[1] ?? "=";
  const raw = match?.[2] ?? criterion.value;
  if (match && raw === "")
    return operator === "=" ? cell._tag === "Blank" : operator === "<>" && cell._tag !== "Blank";
  if (cell._tag === "Blank") return operator === "<>";

  const converted = raw.trim() === "" ? text(raw) : toNumber(text(raw));
  const target: Scalar = isError(converted) ? text(raw) : converted;
  if (cell._tag !== target._tag) return operator === "<>";
  const left = cell._tag === "Text" ? cell.value.toLowerCase() : cell.value;
  const right = target._tag === "Text" ? target.value.toLowerCase() : target.value;
  switch (operator) {
    case "=":
      return left === right;
    case "<>":
      return left !== right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    default:
      return left >= right;
  }
}

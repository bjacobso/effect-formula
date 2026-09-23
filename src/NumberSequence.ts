import { Either } from "effect";
import type { Scalar, Value } from "./Value.js";
import { entries, isError, toNumber } from "./Value.js";

type FormulaError = Extract<Scalar, { _tag: "Error" }>;

/** Convert numeric arguments while preserving the distinction between values and references. */
export function numberSequence(
  args: readonly Value[],
  referenceArguments: readonly boolean[],
  errors: "propagate" | "ignore",
): Either.Either<readonly number[], FormulaError> {
  const numbers: number[] = [];
  for (const [index, arg] of args.entries()) {
    const referenced = arg._tag === "Range" || referenceArguments[index] === true;
    for (const value of entries(arg)) {
      if (isError(value)) {
        if (errors === "propagate") return Either.left(value);
      } else if (value._tag === "Number") {
        numbers.push(value.value);
      } else if (!referenced && value._tag !== "Blank") {
        const converted = toNumber(value);
        if (isError(converted)) {
          if (errors === "propagate") return Either.left(converted);
        } else numbers.push(converted.value);
      }
    }
  }
  return Either.right(numbers);
}

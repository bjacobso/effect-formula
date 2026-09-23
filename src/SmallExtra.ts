import { Either, Option } from "effect";
import { numberSequence } from "./NumberSequence.js";
import type { Scalar, Value } from "./Value.js";
import { error, isError, number, scalar, text, toNumber, toText } from "./Value.js";

const names = new Set([
  "PRODUCT",
  "STDEV",
  "STDEVP",
  "VAR",
  "VARP",
  "PROPER",
  "REPLACE",
  "SUBSTITUTE",
]);
export function smallExtra(
  name: string,
  args: readonly Value[],
  referenceArguments: readonly boolean[],
): Option.Option<Scalar> {
  return names.has(name)
    ? Option.some(evaluateExtra(name, args, referenceArguments))
    : Option.none();
}
function evaluateExtra(
  name: string,
  args: readonly Value[],
  referenceArguments: readonly boolean[],
): Scalar {
  if (["PRODUCT", "STDEV", "STDEVP", "VAR", "VARP"].includes(name)) {
    const sequence = numberSequence(args, referenceArguments, "propagate");
    if (Either.isLeft(sequence)) return sequence.left;
    const values = sequence.right;
    if (name === "PRODUCT") return number(values.reduce((product, value) => product * value, 1));
    const sample = name === "STDEV" || name === "VAR";
    if (values.length < (sample ? 2 : 1)) return error("#DIV/0!");
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (values.length - (sample ? 1 : 0));
    return number(name.startsWith("STDEV") ? Math.sqrt(variance) : variance);
  }
  if (name === "PROPER") {
    if (args.length !== 1) return error("#VALUE!");
    const value = toText(scalar(args[0]!));
    if (isError(value)) return value;
    return text(
      value.value
        .toLowerCase()
        .replace(
          /(^|[^\p{L}])(\p{L})/gu,
          (_, prefix: string, letter: string) => prefix + letter.toUpperCase(),
        ),
    );
  }
  if (name === "REPLACE") {
    if (args.length !== 4) return error("#VALUE!");
    const source = toText(scalar(args[0]!));
    const start = toNumber(scalar(args[1]!));
    const length = toNumber(scalar(args[2]!));
    const replacement = toText(scalar(args[3]!));
    for (const value of [source, start, length, replacement]) if (isError(value)) return value;
    if (isError(source) || isError(start) || isError(length) || isError(replacement))
      return error("#VALUE!");
    if (start.value < 1 || length.value < 0) return error("#VALUE!");
    const chars = Array.from(source.value);
    const before = chars.slice(0, Math.floor(start.value - 1)).join("");
    const after = chars.slice(Math.floor(start.value + length.value - 1)).join("");
    return text(before + replacement.value + after);
  }
  if (name === "SUBSTITUTE") {
    if (args.length < 3 || args.length > 4) return error("#VALUE!");
    const source = toText(scalar(args[0]!));
    const oldText = toText(scalar(args[1]!));
    const newText = toText(scalar(args[2]!));
    const instance = args[3] ? toNumber(scalar(args[3])) : number(0);
    if (isError(source)) return source;
    if (isError(oldText)) return oldText;
    if (isError(newText)) return newText;
    if (isError(instance)) return instance;
    if ((args[3] && instance.value < 1) || !Number.isInteger(instance.value))
      return error("#VALUE!");
    if (oldText.value === "") return source;
    if (instance.value === 0) return text(source.value.split(oldText.value).join(newText.value));
    let seen = 0;
    return text(
      source.value.replaceAll(oldText.value, (match) =>
        ++seen === instance.value ? newText.value : match,
      ),
    );
  }
  return error("#NAME?");
}

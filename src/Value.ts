import { Schema } from "effect";

export const FormulaErrorCode = Schema.Literal(
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#CYCLE!",
  "#N/A",
  "#NULL!",
);
export type FormulaErrorCode = typeof FormulaErrorCode.Type;
export const ScalarSchema = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("Blank") }),
  Schema.Struct({ _tag: Schema.Literal("Number"), value: Schema.Finite }),
  Schema.Struct({ _tag: Schema.Literal("Text"), value: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Boolean"), value: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("Error"), code: FormulaErrorCode }),
);
export type Scalar = typeof ScalarSchema.Type;
export const ValueSchema = Schema.Union(
  ScalarSchema,
  Schema.Struct({ _tag: Schema.Literal("Range"), rows: Schema.Array(Schema.Array(ScalarSchema)) }),
);
export type Value = typeof ValueSchema.Type;
export const blank: Scalar = { _tag: "Blank" };
export const number = (value: number): Extract<Scalar, { _tag: "Number" | "Error" }> =>
  Number.isFinite(value) ? { _tag: "Number", value } : error("#NUM!");
export const text = (value: string): Extract<Scalar, { _tag: "Text" }> => ({ _tag: "Text", value });
export const bool = (value: boolean): Extract<Scalar, { _tag: "Boolean" }> => ({
  _tag: "Boolean",
  value,
});
export const error = (code: FormulaErrorCode): Extract<Scalar, { _tag: "Error" }> => ({
  _tag: "Error",
  code,
});
export const range = (rows: readonly (readonly Scalar[])[]): Value => ({ _tag: "Range", rows });
export const isError = (value: Value): value is Extract<Scalar, { _tag: "Error" }> =>
  value._tag === "Error";
export const scalar = (value: Value): Scalar => (value._tag === "Range" ? error("#VALUE!") : value);

export function toNumber(value: Scalar): Extract<Scalar, { _tag: "Number" | "Error" }> {
  switch (value._tag) {
    case "Blank":
      return number(0);
    case "Number":
      return value;
    case "Boolean":
      return number(value.value ? 1 : 0);
    case "Text": {
      const trimmed = value.value.trim();
      return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) &&
        Number.isFinite(Number(trimmed))
        ? number(Number(trimmed))
        : error("#VALUE!");
    }
    case "Error":
      return value;
  }
}
export function toBoolean(value: Scalar): Extract<Scalar, { _tag: "Boolean" | "Error" }> {
  switch (value._tag) {
    case "Blank":
      return bool(false);
    case "Boolean":
      return value;
    case "Number":
      return bool(value.value !== 0);
    case "Text":
      return error("#VALUE!");
    case "Error":
      return value;
  }
}
export function toText(value: Scalar): Extract<Scalar, { _tag: "Text" | "Error" }> {
  switch (value._tag) {
    case "Blank":
      return text("");
    case "Text":
      return value;
    case "Boolean":
      return text(value.value ? "TRUE" : "FALSE");
    case "Number":
      return text(String(value.value));
    case "Error":
      return value;
  }
}
export function entries(value: Value): readonly Scalar[] {
  return value._tag === "Range" ? value.rows.flat() : [value];
}

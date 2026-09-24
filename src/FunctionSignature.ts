export type FormulaType = "Blank" | "Number" | "Text" | "Boolean" | "Error" | "Range" | "Unknown";

/** Conversion contract assumed by static analysis; custom functions must honor it themselves. */
export type FunctionParameterType = "Number" | "Boolean" | "Text" | "Value";

/** An exact-arity signature for analysis; the runtime function remains authoritative. */
export interface FunctionSignature {
  readonly parameters: readonly FunctionParameterType[];
  readonly returns: FormulaType;
}

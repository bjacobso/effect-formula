export type FormulaType = "Blank" | "Number" | "Text" | "Boolean" | "Error" | "Range" | "Unknown";

/** Conversion contract assumed by static analysis; custom functions must honor it themselves. */
export type FunctionParameterType = "Number" | "Boolean" | "Text" | "Value";

/** A signature with required and optional trailing arguments; the runtime remains authoritative. */
export interface FunctionSignature {
  readonly parameters: readonly FunctionParameterType[];
  readonly optionalParameters?: readonly FunctionParameterType[];
  readonly returns: FormulaType;
}

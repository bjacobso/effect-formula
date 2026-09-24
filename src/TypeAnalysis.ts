import { Effect, Option } from "effect";
import type { FormulaAnalysisOptions } from "./Analysis.js";
import { type FunctionRegistryService, rangeKeys } from "./Engine.js";
import type { FormulaType, FunctionSignature } from "./FunctionSignature.js";
import type { Ast, SourceSpan } from "./Parser.js";
import { isError, toBoolean, toNumber } from "./Value.js";

const builtInSignatures: Readonly<Record<string, FunctionSignature>> = {
  ABS: { parameters: ["Number"], returns: "Number" },
  ACOS: { parameters: ["Number"], returns: "Number" },
  ASIN: { parameters: ["Number"], returns: "Number" },
  ATAN: { parameters: ["Number"], returns: "Number" },
  ATAN2: { parameters: ["Number", "Number"], returns: "Number" },
  COS: { parameters: ["Number"], returns: "Number" },
  DEGREES: { parameters: ["Number"], returns: "Number" },
  EVEN: { parameters: ["Number"], returns: "Number" },
  EXACT: { parameters: ["Text", "Text"], returns: "Boolean" },
  EXP: { parameters: ["Number"], returns: "Number" },
  FACT: { parameters: ["Number"], returns: "Number" },
  INT: { parameters: ["Number"], returns: "Number" },
  ISBLANK: { parameters: ["Value"], returns: "Boolean" },
  ISERR: { parameters: ["Value"], returns: "Boolean" },
  ISERROR: { parameters: ["Value"], returns: "Boolean" },
  ISLOGICAL: { parameters: ["Value"], returns: "Boolean" },
  ISNA: { parameters: ["Value"], returns: "Boolean" },
  ISNONTEXT: { parameters: ["Value"], returns: "Boolean" },
  ISNUMBER: { parameters: ["Value"], returns: "Boolean" },
  ISTEXT: { parameters: ["Value"], returns: "Boolean" },
  LEN: { parameters: ["Text"], returns: "Number" },
  LN: { parameters: ["Number"], returns: "Number" },
  LOG10: { parameters: ["Number"], returns: "Number" },
  LOWER: { parameters: ["Text"], returns: "Text" },
  MID: { parameters: ["Text", "Number", "Number"], returns: "Text" },
  MOD: { parameters: ["Number", "Number"], returns: "Number" },
  NA: { parameters: [], returns: "Error" },
  NOT: { parameters: ["Boolean"], returns: "Boolean" },
  ODD: { parameters: ["Number"], returns: "Number" },
  PI: { parameters: [], returns: "Number" },
  POWER: { parameters: ["Number", "Number"], returns: "Number" },
  RADIANS: { parameters: ["Number"], returns: "Number" },
  REPT: { parameters: ["Text", "Number"], returns: "Text" },
  SIN: { parameters: ["Number"], returns: "Number" },
  SQRT: { parameters: ["Number"], returns: "Number" },
  TAN: { parameters: ["Number"], returns: "Number" },
  TRIM: { parameters: ["Text"], returns: "Text" },
  UPPER: { parameters: ["Text"], returns: "Text" },
};
export interface TypeDiagnostic {
  readonly path: string;
  readonly severity: "definite" | "possible";
  readonly message: string;
  readonly span?: SourceSpan;
}
export interface FormulaTypeAnalysis {
  /** Possible result categories. Numeric overflow and other value-dependent errors are not enumerated. */
  readonly types: readonly FormulaType[];
  readonly diagnostics: readonly TypeDiagnostic[];
}
export type FormulaInputType = FormulaType | readonly FormulaType[];
export interface TypeAnalysisOptions extends FormulaAnalysisOptions {
  readonly registry?: FunctionRegistryService;
}

/** Analyze supported AST operations against host-declared reference types. */
export const analyzeFormulaTypes = (
  ast: Ast,
  inputTypes: Readonly<Record<string, FormulaInputType>>,
  config: FunctionRegistryService | TypeAnalysisOptions = {},
  legacyOptions: FormulaAnalysisOptions = {},
): Effect.Effect<FormulaTypeAnalysis> =>
  Effect.sync(() => {
    const registry = "functions" in config ? config : config.registry;
    const options = "functions" in config ? legacyOptions : config;
    const diagnostics: TypeDiagnostic[] = [];
    const report = (
      node: Ast,
      path: string,
      severity: TypeDiagnostic["severity"],
      message: string,
    ): void => {
      diagnostics.push({ path, severity, message, ...(node.span ? { span: node.span } : {}) });
    };
    const unique = (types: readonly FormulaType[]): readonly FormulaType[] => [...new Set(types)];
    const referenceTypes = (key: string, node: Ast, path: string): readonly FormulaType[] => {
      const declared = Option.fromNullable(inputTypes[key]);
      if (Option.isSome(declared))
        return typeof declared.value === "string" ? [declared.value] : declared.value;
      report(node, path, "possible", `No declared type for ${key}`);
      return ["Unknown"];
    };
    const knownBoolean = (node: Ast): Option.Option<boolean> => {
      if (node._tag === "Literal") {
        const converted = toBoolean(node.value);
        return isError(converted) ? Option.none() : Option.some(converted.value);
      }
      if (
        node._tag === "Call" &&
        node.args.length === 0 &&
        (node.name === "TRUE" || node.name === "FALSE") &&
        !registry?.disabled?.has(node.name) &&
        !registry?.functions.has(node.name)
      )
        return Option.some(node.name === "TRUE");
      return Option.none();
    };
    const conversion = (
      node: Ast,
      types: readonly FormulaType[],
      target: "Number" | "Boolean" | "Text",
      path: string,
    ): readonly FormulaType[] => {
      const result: FormulaType[] = [];
      let possible = false;
      let definite = false;
      for (const type of types) {
        if (type === "Error" || type === "Unknown") {
          result.push(type);
        } else if (type === "Range" || (target === "Boolean" && type === "Text")) {
          result.push("Error");
          definite = true;
        } else if (target === "Number" && type === "Text") {
          if (node._tag === "Literal" && node.value._tag === "Text") {
            if (isError(toNumber(node.value))) {
              result.push("Error");
              definite = true;
            } else result.push("Number");
          } else {
            result.push("Number", "Error");
            possible = true;
          }
        } else result.push(target);
      }
      if (definite || possible)
        report(
          node,
          path,
          possible || result.some((type) => type === target) ? "possible" : "definite",
          `Cannot guarantee conversion to ${target}`,
        );
      return unique(result);
    };
    const infer = (node: Ast, path: string): readonly FormulaType[] => {
      switch (node._tag) {
        case "Missing":
          return ["Blank"];
        case "Literal":
          return [node.value._tag];
        case "Reference": {
          return referenceTypes(node.key, node, path);
        }
        case "Range":
          return ["Range"];
        case "Unary": {
          const value = infer(node.value, `${path}.value`);
          return node.operator === "+"
            ? value
            : conversion(node.value, value, "Number", `${path}.value`);
        }
        case "Binary": {
          const leftPath = `${path}.left`;
          const rightPath = `${path}.right`;
          const left = infer(node.left, leftPath);
          const right = infer(node.right, rightPath);
          if (node.operator === "!") return ["Unknown"];
          if (node.operator === "&" || ["=", "<>", "<", "<=", ">", ">="].includes(node.operator)) {
            const resultType = node.operator === "&" ? "Text" : "Boolean";
            const result: FormulaType[] = [];
            if (
              left.includes("Error") ||
              right.includes("Error") ||
              left.includes("Range") ||
              right.includes("Range")
            )
              result.push("Error");
            if (left.includes("Unknown") || right.includes("Unknown")) result.push("Unknown");
            if (
              left.some((type) => !["Error", "Range", "Unknown"].includes(type)) &&
              right.some((type) => !["Error", "Range", "Unknown"].includes(type))
            )
              result.push(resultType);
            if (left.includes("Range") || right.includes("Range"))
              report(
                left.includes("Range") ? node.left : node.right,
                path,
                result.includes(resultType) ? "possible" : "definite",
                "A range cannot be used as a scalar",
              );
            return unique(result);
          }
          const numericLeft = conversion(node.left, left, "Number", leftPath);
          const numericRight = conversion(node.right, right, "Number", rightPath);
          const result: FormulaType[] = [];
          if (numericLeft.includes("Error") || numericRight.includes("Error")) result.push("Error");
          if (numericLeft.includes("Unknown") || numericRight.includes("Unknown"))
            result.push("Unknown");
          if (numericLeft.includes("Number") && numericRight.includes("Number"))
            result.push("Number");
          return unique(result);
        }
        case "Call": {
          if (registry?.disabled?.has(node.name)) return ["Error"];
          const custom = registry?.functions.has(node.name) === true;
          const signature = custom
            ? registry?.signatures?.get(node.name)
            : builtInSignatures[node.name];
          if (signature) {
            if (node.args.length !== signature.parameters.length) {
              report(
                node,
                path,
                "definite",
                `${node.name} expects ${signature.parameters.length} argument${signature.parameters.length === 1 ? "" : "s"}`,
              );
              return ["Error"];
            }
            const args = node.args.map((arg, index) => infer(arg, `${path}.args[${index}]`));
            const converted = signature.parameters.map((parameter, index) =>
              parameter === "Value"
                ? args[index]!
                : conversion(node.args[index]!, args[index]!, parameter, `${path}.args[${index}]`),
            );
            const result: FormulaType[] = [];
            if (
              converted.some(
                (types, index) =>
                  signature.parameters[index] !== "Value" && types.includes("Error"),
              )
            )
              result.push("Error");
            if (
              converted.some(
                (types, index) =>
                  signature.parameters[index] !== "Value" && types.includes("Unknown"),
              )
            )
              result.push("Unknown");
            if (
              converted.every(
                (types, index) =>
                  signature.parameters[index] === "Value" ||
                  types.includes(signature.parameters[index] as FormulaType),
              )
            )
              result.push(signature.returns);
            return unique(result);
          }
          if (custom) {
            for (const [index, arg] of node.args.entries()) infer(arg, `${path}.args[${index}]`);
            return ["Unknown"];
          }
          if (
            ["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "COUNTBLANK"].includes(node.name)
          ) {
            if (
              node.name === "COUNTBLANK" &&
              (node.args.length !== 1 || !["Reference", "Range"].includes(node.args[0]?._tag ?? ""))
            ) {
              report(node, path, "definite", "COUNTBLANK expects one reference");
              return ["Error"];
            }
            if (node.name === "COUNT" || node.name === "COUNTA" || node.name === "COUNTBLANK") {
              for (const [index, arg] of node.args.entries()) infer(arg, `${path}.args[${index}]`);
              return ["Number"];
            }
            let certainNumber = false;
            let possibleNumber = false;
            let definiteError = false;
            let possibleError = false;
            let unknown = false;
            for (const [index, arg] of node.args.entries()) {
              const argPath = `${path}.args[${index}]`;
              const referenced = arg._tag === "Reference" || arg._tag === "Range";
              let candidates: readonly (readonly FormulaType[])[];
              if (arg._tag === "Range") {
                const cells = rangeKeys(
                  arg.start,
                  arg.end,
                  options.maxRangeCells ?? 10000,
                  options.grid,
                );
                if (Option.isNone(cells)) {
                  report(arg, argPath, "definite", "Cannot expand range");
                  definiteError = true;
                  continue;
                }
                candidates = cells.value.flat().map((key) => {
                  const declared = Option.fromNullable(inputTypes[key]);
                  if (Option.isNone(declared)) {
                    unknown = true;
                    return ["Unknown"];
                  }
                  return typeof declared.value === "string" ? [declared.value] : declared.value;
                });
                if (candidates.some((types) => types.includes("Unknown")))
                  report(arg, argPath, "possible", "Type of some range cells is unknown");
              } else candidates = [infer(arg, argPath)];
              for (const types of candidates) {
                const converted = referenced
                  ? unique([
                      ...types.filter(
                        (type) => type === "Number" || type === "Error" || type === "Unknown",
                      ),
                      ...(types.includes("Range")
                        ? [arg._tag === "Range" ? ("Error" as const) : ("Unknown" as const)]
                        : []),
                    ])
                  : unique([
                      ...(types.includes("Blank") ? ["Blank" as const] : []),
                      ...(types.includes("Range") ? ["Unknown" as const] : []),
                      ...conversion(
                        arg,
                        types.filter((type) => type !== "Blank" && type !== "Range"),
                        "Number",
                        argPath,
                      ),
                    ]);
                if (converted.includes("Number")) possibleNumber = true;
                if (converted.length === 1 && converted[0] === "Number") certainNumber = true;
                if (converted.includes("Error")) {
                  possibleError = true;
                  if (converted.length === 1) definiteError = true;
                }
                if (converted.includes("Unknown")) {
                  unknown = true;
                  possibleNumber = true;
                }
              }
            }
            if (definiteError) return ["Error"];
            const result: FormulaType[] = [];
            if (node.name !== "AVERAGE" || possibleNumber) result.push("Number");
            if (possibleError || (node.name === "AVERAGE" && !certainNumber)) result.push("Error");
            if (unknown) result.push("Unknown");
            return unique(result);
          }
          if (node.name === "TRUE" || node.name === "FALSE")
            return node.args.length === 0 ? ["Boolean"] : ["Error"];
          if (node.name === "IFERROR") {
            if (node.args.length !== 2) {
              report(node, path, "definite", "IFERROR expects 2 arguments");
              return ["Error"];
            }
            const first = infer(node.args[0]!, `${path}.args[0]`);
            if (node.args[0]?._tag === "Literal" && node.args[0].value._tag !== "Error")
              return first;
            const fallback = infer(node.args[1]!, `${path}.args[1]`);
            if (first.length === 1 && first[0] === "Error") return fallback;
            return unique([...first.filter((type) => type !== "Error"), ...fallback]);
          }
          if (node.name === "CHOOSE") {
            if (node.args.length < 2) {
              report(node, path, "definite", "CHOOSE expects at least 2 arguments");
              return ["Error"];
            }
            const indexNode = node.args[0]!;
            const index = conversion(
              indexNode,
              infer(indexNode, `${path}.args[0]`),
              "Number",
              `${path}.args[0]`,
            );
            if (!index.includes("Number") && !index.includes("Unknown")) return ["Error"];
            if (indexNode._tag === "Literal") {
              const known = toNumber(indexNode.value);
              if (!isError(known)) {
                const selected = Math.trunc(known.value);
                if (selected < 1 || selected >= node.args.length) {
                  report(indexNode, `${path}.args[0]`, "definite", "CHOOSE index is out of range");
                  return ["Error"];
                }
                return infer(node.args[selected]!, `${path}.args[${selected}]`);
              }
            }
            return unique([
              "Error",
              ...(index.includes("Unknown") ? ["Unknown" as const] : []),
              ...node.args
                .slice(1)
                .flatMap((arg, offset) => infer(arg, `${path}.args[${offset + 1}]`)),
            ]);
          }
          if (node.name === "IF") {
            if (node.args.length < 1 || node.args.length > 3) {
              report(node, path, "definite", "IF expects one to three arguments");
              return ["Error"];
            }
            const conditionNode = node.args[0]!;
            const condition = conversion(
              conditionNode,
              infer(conditionNode, `${path}.args[0]`),
              "Boolean",
              `${path}.args[0]`,
            );
            if (
              node.args.length === 1 ||
              (!condition.includes("Boolean") && !condition.includes("Unknown"))
            )
              return condition;
            const known = knownBoolean(conditionNode);
            if (Option.isSome(known)) {
              const selected = known.value ? node.args[1] : node.args[2];
              if (!selected) return ["Boolean"];
              return selected._tag === "Missing"
                ? ["Number"]
                : infer(selected, `${path}.args[${known.value ? 1 : 2}]`);
            }
            const result: FormulaType[] = [];
            if (condition.includes("Error")) result.push("Error");
            if (condition.includes("Unknown")) result.push("Unknown");
            if (node.args[1]?._tag === "Missing") result.push("Number");
            else result.push(...infer(node.args[1]!, `${path}.args[1]`));
            if (!node.args[2]) result.push("Boolean");
            else if (node.args[2]._tag === "Missing") result.push("Number");
            else result.push(...infer(node.args[2], `${path}.args[2]`));
            return unique(result);
          }
          for (const [index, arg] of node.args.entries()) infer(arg, `${path}.args[${index}]`);
          return ["Unknown"];
        }
      }
    };
    return { types: infer(ast, "root"), diagnostics };
  });

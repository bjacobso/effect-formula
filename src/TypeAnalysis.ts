import { Effect, Option } from "effect";
import type { Ast } from "./Parser.js";
import { isError, toNumber } from "./Value.js";

export type FormulaType = "Blank" | "Number" | "Text" | "Boolean" | "Error" | "Range" | "Unknown";
export interface TypeDiagnostic {
  readonly path: string;
  readonly severity: "definite" | "possible";
  readonly message: string;
}
export interface FormulaTypeAnalysis {
  /** Possible result categories. Numeric overflow and other value-dependent errors are not enumerated. */
  readonly types: readonly FormulaType[];
  readonly diagnostics: readonly TypeDiagnostic[];
}

/** Analyze supported AST operations against host-declared reference types. */
export const analyzeFormulaTypes = (
  ast: Ast,
  inputTypes: Readonly<Record<string, FormulaType>>,
): Effect.Effect<FormulaTypeAnalysis> =>
  Effect.sync(() => {
    const diagnostics: TypeDiagnostic[] = [];
    const unique = (types: readonly FormulaType[]): readonly FormulaType[] => [...new Set(types)];
    const conversion = (
      node: Ast,
      types: readonly FormulaType[],
      target: "Number" | "Boolean",
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
        diagnostics.push({
          path,
          severity: possible || result.some((type) => type === target) ? "possible" : "definite",
          message: `Cannot guarantee conversion to ${target}`,
        });
      return unique(result);
    };
    const infer = (node: Ast, path: string): readonly FormulaType[] => {
      switch (node._tag) {
        case "Missing":
          return ["Blank"];
        case "Literal":
          return [node.value._tag];
        case "Reference": {
          const declared = Option.fromNullable(inputTypes[node.key]);
          if (Option.isSome(declared)) return [declared.value];
          diagnostics.push({
            path,
            severity: "possible",
            message: `No declared type for ${node.key}`,
          });
          return ["Unknown"];
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
              diagnostics.push({
                path,
                severity: result.includes(resultType) ? "possible" : "definite",
                message: "A range cannot be used as a scalar",
              });
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
          const args = node.args.map((arg, index) => infer(arg, `${path}.args[${index}]`));
          if (node.name === "TRUE" || node.name === "FALSE")
            return node.args.length === 0 ? ["Boolean"] : ["Error"];
          if (node.name !== "IF") return ["Unknown"];
          if (node.args.length < 1 || node.args.length > 3) {
            diagnostics.push({
              path,
              severity: "definite",
              message: "IF expects one to three arguments",
            });
            return ["Error"];
          }
          const condition = conversion(node.args[0]!, args[0]!, "Boolean", `${path}.args[0]`);
          if (node.args.length === 1) return condition;
          const result: FormulaType[] = [];
          if (condition.includes("Error")) result.push("Error");
          if (condition.includes("Unknown")) result.push("Unknown");
          if (condition.includes("Boolean") || condition.includes("Unknown")) {
            if (node.args[1]?._tag === "Missing") result.push("Number");
            else result.push(...args[1]!);
            if (!node.args[2]) result.push("Boolean");
            else if (node.args[2]._tag === "Missing") result.push("Number");
            else result.push(...args[2]!);
          }
          return unique(result);
        }
      }
    };
    return { types: infer(ast, "root"), diagnostics };
  });

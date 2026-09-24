import { Effect, Option } from "effect";
import type { FunctionRegistryService } from "./Engine.js";
import type { FormulaType, FunctionSignature } from "./FunctionSignature.js";
import type { Ast, SourceSpan } from "./Parser.js";
import { isError, toBoolean, toNumber } from "./Value.js";

const builtInSignatures: Readonly<Record<string, FunctionSignature>> = {
  ABS: { parameters: ["Number"], returns: "Number" },
  LEN: { parameters: ["Text"], returns: "Number" },
  LOWER: { parameters: ["Text"], returns: "Text" },
  NOT: { parameters: ["Boolean"], returns: "Boolean" },
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

/** Analyze supported AST operations against host-declared reference types. */
export const analyzeFormulaTypes = (
  ast: Ast,
  inputTypes: Readonly<Record<string, FormulaInputType>>,
  registry?: FunctionRegistryService,
): Effect.Effect<FormulaTypeAnalysis> =>
  Effect.sync(() => {
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
          const declared = Option.fromNullable(inputTypes[node.key]);
          if (Option.isSome(declared))
            return typeof declared.value === "string" ? [declared.value] : declared.value;
          report(node, path, "possible", `No declared type for ${node.key}`);
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

import { Data, Effect, Option, Schema } from "effect";
import { type GridBounds, parseAddress, sheetOfKey } from "./Address.js";
import {
  type CustomFunction,
  type EvalOptions,
  EvaluationFailure,
  evaluateWithRegistry,
  type FunctionRegistryService,
  rangeKeys,
} from "./Engine.js";
import type { FormulaType, FunctionSignature } from "./FunctionSignature.js";
import { type Ast, parse, parseSync, type SourceSpan } from "./Parser.js";
import {
  createSessionWithRegistry,
  type FormulaSession,
  type SessionOptions,
  type Update,
} from "./Session.js";
import { analyzeFormulaTypesSync } from "./TypeAnalysis.js";
import { bool, error, number, text, type Value } from "./Value.js";

type PrimitiveSchema = typeof Schema.Number | typeof Schema.String | typeof Schema.Boolean;
type SchemaValue<S> = S extends Schema.Schema<infer A, infer _I, infer _R> ? A : never;
type Fields = Readonly<Record<string, Schema.Schema.AnyNoContext>>;
type NumericKeys<F extends Fields> = {
  [K in keyof F]: SchemaValue<F[K]> extends number ? K : never;
}[keyof F] &
  string;
type ExpressionValue<E> = E extends Expression<infer T> ? T : never;
type ScalarExpression = Expression<number> | Expression<string> | Expression<boolean>;
type LogicalExpression =
  | Expression<number>
  | Expression<boolean>
  | Expression<readonly number[]>
  | Expression<readonly (number | string | boolean)[]>;
type Arguments<P extends readonly PrimitiveSchema[]> = {
  readonly [K in keyof P]: SchemaValue<P[K]>;
};
type Expressions<P extends readonly PrimitiveSchema[]> = {
  readonly [K in keyof P]: Expression<SchemaValue<P[K]>>;
};

declare const expressionBrand: unique symbol;
const functionBrand = Symbol("effect-formula/typed-function");
/** An AST expression with a TypeScript successful-result type. Formula errors remain values. */
export interface Expression<T> {
  readonly ast: Ast;
  readonly [expressionBrand]: (value: T) => T;
}

const expression = <T>(ast: Ast): Expression<T> => ({ ast }) as Expression<T>;

function category(schema: Schema.Schema.AnyNoContext): FormulaType | undefined {
  switch (schema.ast._tag) {
    case "NumberKeyword":
      return "Number";
    case "StringKeyword":
      return "Text";
    case "BooleanKeyword":
      return "Boolean";
    default:
      return undefined;
  }
}

function raw(value: Value): unknown {
  return value._tag === "Number" || value._tag === "Text" || value._tag === "Boolean"
    ? value.value
    : undefined;
}

function tagged(value: unknown, type: FormulaType): Value {
  if (type === "Number" && typeof value === "number") return number(value);
  if (type === "Text" && typeof value === "string") return text(value);
  if (type === "Boolean" && typeof value === "boolean") return bool(value);
  return error("#VALUE!");
}

/** A custom function whose schemas drive both static checking and runtime validation. */
export class FormulaFunction<
  P extends readonly PrimitiveSchema[],
  O extends PrimitiveSchema,
  E = EvaluationFailure,
  R = never,
> {
  readonly [functionBrand] = true;
  readonly name: string;
  readonly signature: FunctionSignature;

  constructor(
    name: string,
    readonly parameters: P,
    readonly returns: O,
    readonly run: (args: Arguments<P>) => Effect.Effect<SchemaValue<O>, E, R>,
  ) {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) throw new Error(`Invalid function name: ${name}`);
    this.name = name.toUpperCase();
    if (this.name === "IF") throw new Error("IF cannot be replaced in a typed formula");
    this.parameters = Object.freeze([...parameters]) as unknown as P;
    this.signature = Object.freeze({
      parameters: Object.freeze(
        parameters.map((schema) => category(schema)!),
      ) as FunctionSignature["parameters"],
      returns: category(returns)!,
    });
    Object.freeze(this);
  }

  toCustomFunction(): CustomFunction<E, R> {
    return (values) => {
      if (values.length !== this.parameters.length) return Effect.succeed(error("#VALUE!"));
      const decoded: unknown[] = [];
      for (let index = 0; index < values.length; index++) {
        const value = values[index]!;
        if (value._tag === "Error") return Effect.succeed(value);
        const expected = category(this.parameters[index]!);
        if (value._tag !== expected) return Effect.succeed(error("#VALUE!"));
        const result = Schema.decodeUnknownEither(
          this.parameters[index]! as Schema.Schema.AnyNoContext,
        )(raw(value));
        if (result._tag === "Left") return Effect.succeed(error("#VALUE!"));
        decoded.push(result.right);
      }
      return Effect.flatMap(this.run(decoded as Arguments<P>), (output) => {
        const result = Schema.decodeUnknownEither(this.returns as Schema.Schema.AnyNoContext)(
          output,
        );
        return result._tag === "Left"
          ? Effect.succeed(error("#VALUE!"))
          : Effect.succeed(tagged(result.right, this.signature.returns));
      });
    };
  }
}

export const defineFormulaFunction = <
  const P extends readonly PrimitiveSchema[],
  O extends PrimitiveSchema,
  E,
  R,
>(
  name: string,
  parameters: P,
  returns: O,
  run: (args: Arguments<P>) => Effect.Effect<SchemaValue<O>, E, R>,
): FormulaFunction<P, O, E, R> => new FormulaFunction(name, parameters, returns, run);

type RuntimeFunction = Pick<
  FormulaFunction<readonly PrimitiveSchema[], PrimitiveSchema, unknown, unknown>,
  typeof functionBrand | "name" | "signature" | "toCustomFunction"
>;
type FunctionError<F> = F extends { toCustomFunction(): CustomFunction<infer E, infer _R> }
  ? E
  : never;
type FunctionRequirements<F> = F extends { toCustomFunction(): CustomFunction<infer _E, infer R> }
  ? R
  : never;

export interface CheckDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly span?: SourceSpan;
}
export interface CheckResult {
  readonly passed: boolean;
  readonly coverage: "complete" | "partial";
  readonly types: readonly FormulaType[];
  readonly diagnostics: readonly CheckDiagnostic[];
}
export class FormulaCheckFailure extends Data.TaggedError("FormulaCheckFailure")<{
  readonly message: string;
  readonly diagnostics: readonly CheckDiagnostic[];
}> {}
export interface TypedFormulaOptions<C extends Fields> {
  readonly cells?: C;
  readonly grid?: GridBounds;
  readonly maxRangeCells?: number;
}

function decodeValues(
  schemas: Fields,
  input: unknown,
  keyOf: (name: string) => string,
): Effect.Effect<ReadonlyMap<string, Value>, EvaluationFailure> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return Effect.fail(new EvaluationFailure({ message: "Invalid typed formula inputs" }));
  const values = new Map<string, Value>();
  for (const [name, rawValue] of Object.entries(input)) {
    const schema = schemas[name];
    if (!schema) return Effect.fail(new EvaluationFailure({ message: `Unknown input ${name}` }));
    const type = category(schema);
    if (!type)
      return Effect.fail(new EvaluationFailure({ message: `Unsupported schema for ${name}` }));
    const decoded = Schema.decodeUnknownEither(schema)(rawValue);
    if (decoded._tag === "Left")
      return Effect.fail(new EvaluationFailure({ message: `Invalid value for ${name}` }));
    const value = tagged(decoded.right, type);
    if (value._tag !== type)
      return Effect.fail(new EvaluationFailure({ message: `Invalid value for ${name}` }));
    values.set(keyOf(name), value);
  }
  return Effect.succeed(values);
}

/** Create a typed AST builder and a strict checker for parsed formulas over the same fields. */
export function typedFormula<
  const F extends Fields,
  const FS extends readonly RuntimeFunction[] = readonly [],
  const C extends Fields = Record<never, never>,
>(fields: F, functions: FS = [] as unknown as FS, options: TypedFormulaOptions<C> = {}) {
  for (const name of Object.keys(fields))
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`Invalid field name: ${name}`);
  const cellSchemas = options.cells ?? ({} as C);
  const normalizedCells = new Set<string>();
  for (const name of Object.keys(cellSchemas))
    if (
      !/^[A-Za-z]+[1-9][0-9]*$/.test(name) ||
      Option.isNone(parseAddress(`cell:${name.toUpperCase()}`))
    )
      throw new Error(`Invalid cell address: ${name}`);
    else if (normalizedCells.has(name.toUpperCase()))
      throw new Error(`Duplicate cell address: ${name}`);
    else normalizedCells.add(name.toUpperCase());
  const declarations = new Map<string, FormulaType | undefined>([
    ...Object.entries(fields).map(([name, schema]) => [`field:${name}`, category(schema)] as const),
    ...Object.entries(cellSchemas).map(
      ([name, schema]) => [`cell:${name.toUpperCase()}`, category(schema)] as const,
    ),
  ]);
  const inputSchemas: Readonly<Record<string, Schema.Schema.AnyNoContext>> = Object.fromEntries([
    ...Object.entries(fields).map(([name, schema]) => [`field:${name}`, schema] as const),
    ...Object.entries(cellSchemas).map(
      ([name, schema]) => [`cell:${name.toUpperCase()}`, schema] as const,
    ),
  ]);
  for (const fn of functions)
    if (fn.name === "IF" || fn.name !== fn.name.toUpperCase())
      throw new Error(`Invalid typed function name: ${fn.name}`);
  const registered = new Map(functions.map((fn) => [fn.name, fn]));
  if (registered.size !== functions.length) throw new Error("Duplicate function name");
  const registry = {
    functions: new Map(functions.map((fn) => [fn.name, fn.toCustomFunction()])),
    signatures: new Map(functions.map((fn) => [fn.name, fn.signature])),
  } as FunctionRegistryService<FunctionError<FS[number]>, FunctionRequirements<FS[number]>>;

  const check = (ast: Ast, expected: PrimitiveSchema): CheckResult => {
    const diagnostics: CheckDiagnostic[] = [];
    let coverage: CheckResult["coverage"] = "complete";
    const report = (node: Ast, path: string, code: string, message: string): void => {
      diagnostics.push({ code, message, path, ...(node.span ? { span: node.span } : {}) });
    };
    const unknown = (node: Ast, path: string, message: string): readonly FormulaType[] => {
      coverage = "partial";
      report(node, path, "UnknownCoverage", message);
      return ["Unknown"];
    };
    const inferred = new Map<string, readonly FormulaType[]>();
    const supported = new Set([
      "TRUE",
      "FALSE",
      "PI",
      "NA",
      "ABS",
      "SUM",
      "AVERAGE",
      "MIN",
      "MAX",
      "IF",
      "IFERROR",
      "CHOOSE",
      "AND",
      "OR",
      "NOT",
      "LEN",
      "LEFT",
      "RIGHT",
      "MID",
      "UPPER",
      "LOWER",
      "TRIM",
      "CONCATENATE",
      "ROUND",
      "ROUNDUP",
      "ROUNDDOWN",
      "INT",
      "MOD",
    ]);
    const analysis = analyzeFormulaTypesSync(
      ast,
      Object.fromEntries(
        [...declarations].filter((entry): entry is [string, FormulaType] => entry[1] !== undefined),
      ),
      { registry, ...options },
      {},
      (node, path, types) => {
        inferred.set(path, types);
        switch (node._tag) {
          case "Reference":
            if (!declarations.has(node.key)) unknown(node, path, `Unknown reference ${node.key}`);
            else if (!declarations.get(node.key))
              unknown(node, path, `Unsupported schema for ${node.key}`);
            break;
          case "Range": {
            const keys = rangeKeys(
              node.start,
              node.end,
              options.maxRangeCells ?? 10000,
              options.grid,
            );
            if (Option.isNone(keys)) unknown(node, path, "Range cannot be expanded");
            else
              for (const key of keys.value.flat()) {
                if (!declarations.has(key)) unknown(node, path, `Unknown range cell ${key}`);
                else if (!declarations.get(key))
                  unknown(node, path, `Unsupported schema for ${key}`);
              }
            break;
          }
          case "Unary":
            if (
              node.operator !== "+" &&
              !inferred.get(`${path}.value`)?.every((type) => type === "Number" || type === "Error")
            )
              report(
                node.value,
                `${path}.value`,
                "OperandType",
                `${node.operator} requires Number`,
              );
            break;
          case "Binary":
            if (["+", "-", "*", "/", "^"].includes(node.operator)) {
              for (const side of ["left", "right"] as const)
                if (
                  !inferred
                    .get(`${path}.${side}`)
                    ?.every((type) => type === "Number" || type === "Error")
                )
                  report(
                    node[side],
                    `${path}.${side}`,
                    "OperandType",
                    `${node.operator} requires Number`,
                  );
            } else if (!["&", "=", "<>", "<", "<=", ">", ">="].includes(node.operator))
              unknown(node, path, `Unsupported operator ${node.operator}`);
            break;
          case "Call": {
            const fn = registered.get(node.name);
            if (fn) {
              // Schema-backed functions do not perform the advisory signature conversions.
              node.args.forEach((arg, index) => {
                const expectedType = fn.signature.parameters[index];
                const argTypes = inferred.get(`${path}.args[${index}]`);
                if (
                  expectedType &&
                  !argTypes?.every((type) => type === expectedType || type === "Error")
                )
                  report(
                    arg,
                    `${path}.args[${index}]`,
                    "ArgumentType",
                    `${node.name} expects ${expectedType}`,
                  );
              });
            } else if (!supported.has(node.name))
              unknown(node, path, `Unknown function ${node.name}`);
            else if (node.name === "IF" && node.args.length !== 3)
              report(node, path, "Arity", "IF requires three arguments in strict formulas");
            break;
          }
        }
      },
    );
    for (const diagnostic of analysis.diagnostics) {
      // Keep stricter operand/custom-function diagnostics when they already explain the problem.
      if (diagnostics.some((existing) => existing.path === diagnostic.path)) continue;
      diagnostics.push({
        code: diagnostic.message.includes("expects") ? "Arity" : "ArgumentType",
        message: diagnostic.message,
        path: diagnostic.path,
        ...(diagnostic.span ? { span: diagnostic.span } : {}),
      });
    }
    const types = analysis.types;
    if (types.includes("Unknown")) coverage = "partial";
    const expectedType = category(expected)!;
    if (
      !types.includes(expectedType) ||
      types.some((type) => type !== expectedType && type !== "Error")
    )
      report(ast, "root", "ResultType", `Expected ${expectedType} result`);
    return {
      passed: diagnostics.length === 0 && coverage === "complete",
      coverage,
      types,
      diagnostics,
    };
  };

  const builtin = <T>(name: string, args: readonly { readonly ast: Ast }[]): Expression<T> => {
    if (registered.has(name)) throw new Error(`Use call() for the registered override of ${name}`);
    return expression({ _tag: "Call", name, args: args.map((arg) => arg.ast) });
  };
  const compare = (
    operator: "=" | "<>" | "<" | "<=" | ">" | ">=",
    left: ScalarExpression,
    right: ScalarExpression,
  ): Expression<boolean> =>
    expression({ _tag: "Binary", operator, left: left.ast, right: right.ast });

  return {
    registry,
    inputSchemas,
    evaluate: (ast: Ast, options: EvalOptions = {}) => evaluateWithRegistry(ast, registry, options),
    createSession: (sessionOptions: Omit<SessionOptions, "inputSchemas"> = {}) =>
      Effect.map(
        createSessionWithRegistry(registry, { ...sessionOptions, inputSchemas }),
        (
          session,
        ): FormulaSession<
          FunctionError<FS[number]> | FormulaCheckFailure,
          FunctionRequirements<FS[number]>
        > => ({
          get: session.get,
          snapshot: session.snapshot,
          update: (updates) =>
            Effect.gen(function* () {
              const checked: Update[] = [];
              for (const update of updates) {
                if (update._tag === "Input" && !inputSchemas[update.key])
                  return yield* Effect.fail(
                    new EvaluationFailure({ message: `Unknown typed input ${update.key}` }),
                  );
                if (update._tag !== "Formula") {
                  checked.push(update);
                  continue;
                }
                const schema = inputSchemas[update.key];
                if (!schema || !category(schema))
                  return yield* Effect.fail(
                    new FormulaCheckFailure({
                      message: `No supported output schema for ${update.key}`,
                      diagnostics: [
                        {
                          code: "UnknownOutput",
                          message: `No supported output schema for ${update.key}`,
                          path: "root",
                        },
                      ],
                    }),
                  );
                const sheet = sheetOfKey(update.key);
                const ast =
                  typeof update.formula === "string"
                    ? yield* parse(update.formula, {
                        ...sessionOptions,
                        captureSpans: true,
                        ...(Option.isSome(sheet) ? { currentSheet: sheet.value } : {}),
                      })
                    : update.formula;
                const result = check(ast, schema as PrimitiveSchema);
                if (!result.passed)
                  return yield* Effect.fail(
                    new FormulaCheckFailure({
                      message: `Formula for ${update.key} did not pass strict checking`,
                      diagnostics: result.diagnostics,
                    }),
                  );
                checked.push({ ...update, formula: ast });
              }
              return yield* session.update(checked);
            }),
        }),
      ),
    decodeInputs: (input: unknown) => decodeValues(fields, input, (name) => `field:${name}`),
    decodeCells: (input: unknown) =>
      decodeValues(cellSchemas, input, (name) => `cell:${name.toUpperCase()}`),
    ref<K extends keyof F & string>(name: K): Expression<SchemaValue<F[K]>> {
      return expression({ _tag: "Reference", key: `field:${name}` });
    },
    cell<K extends keyof C & string>(name: K): Expression<SchemaValue<C[K]>> {
      return expression({ _tag: "Reference", key: `cell:${name.toUpperCase()}` });
    },
    range<S extends NumericKeys<C>, E extends NumericKeys<C>>(
      start: S,
      end: E,
    ): Expression<readonly number[]> {
      const startKey = `cell:${start.toUpperCase()}`;
      const endKey = `cell:${end.toUpperCase()}`;
      const keys = rangeKeys(startKey, endKey, options.maxRangeCells ?? 10000, options.grid);
      if (
        Option.isNone(keys) ||
        keys.value.flat().some((key) => declarations.get(key) !== "Number")
      )
        throw new Error(`Range ${start}:${end} requires declared Number cells`);
      return expression({ _tag: "Range", start: startKey, end: endKey });
    },
    /** A declared primitive range for NumberSequence logical arguments. */
    valuesRange<S extends keyof C & string, E extends keyof C & string>(
      start: S,
      end: E,
    ): Expression<readonly (number | string | boolean)[]> {
      const startKey = `cell:${start.toUpperCase()}`;
      const endKey = `cell:${end.toUpperCase()}`;
      const keys = rangeKeys(startKey, endKey, options.maxRangeCells ?? 10000, options.grid);
      if (Option.isNone(keys) || keys.value.flat().some((key) => !declarations.get(key)))
        throw new Error(`Range ${start}:${end} requires declared primitive cells`);
      return expression({ _tag: "Range", start: startKey, end: endKey });
    },
    number: (value: number): Expression<number> =>
      expression({ _tag: "Literal", value: number(value) }),
    text: (value: string): Expression<string> =>
      expression({ _tag: "Literal", value: text(value) }),
    boolean: (value: boolean): Expression<boolean> =>
      expression({ _tag: "Literal", value: bool(value) }),
    add: (left: Expression<number>, right: Expression<number>): Expression<number> =>
      expression({ _tag: "Binary", operator: "+", left: left.ast, right: right.ast }),
    multiply: (left: Expression<number>, right: Expression<number>): Expression<number> =>
      expression({ _tag: "Binary", operator: "*", left: left.ast, right: right.ast }),
    equals: (left: ScalarExpression, right: ScalarExpression) => compare("=", left, right),
    notEquals: (left: ScalarExpression, right: ScalarExpression) => compare("<>", left, right),
    lessThan: (left: ScalarExpression, right: ScalarExpression) => compare("<", left, right),
    lessThanOrEqual: (left: ScalarExpression, right: ScalarExpression) =>
      compare("<=", left, right),
    greaterThan: (left: ScalarExpression, right: ScalarExpression) => compare(">", left, right),
    greaterThanOrEqual: (left: ScalarExpression, right: ScalarExpression) =>
      compare(">=", left, right),
    concat: (left: ScalarExpression, right: ScalarExpression): Expression<string> =>
      expression({ _tag: "Binary", operator: "&", left: left.ast, right: right.ast }),
    concatenate: (first: ScalarExpression, ...rest: readonly ScalarExpression[]) =>
      builtin<string>("CONCATENATE", [first, ...rest]),
    and: (first: LogicalExpression, ...rest: readonly LogicalExpression[]) =>
      builtin<boolean>("AND", [first, ...rest]),
    or: (first: LogicalExpression, ...rest: readonly LogicalExpression[]) =>
      builtin<boolean>("OR", [first, ...rest]),
    not: (value: Expression<boolean> | Expression<number>) => builtin<boolean>("NOT", [value]),
    len: (value: ScalarExpression) => builtin<number>("LEN", [value]),
    left: (value: ScalarExpression, count?: Expression<number>) =>
      builtin<string>("LEFT", count ? [value, count] : [value]),
    right: (value: ScalarExpression, count?: Expression<number>) =>
      builtin<string>("RIGHT", count ? [value, count] : [value]),
    mid: (value: ScalarExpression, start: Expression<number>, count: Expression<number>) =>
      builtin<string>("MID", [value, start, count]),
    upper: (value: ScalarExpression) => builtin<string>("UPPER", [value]),
    lower: (value: ScalarExpression) => builtin<string>("LOWER", [value]),
    trim: (value: ScalarExpression) => builtin<string>("TRIM", [value]),
    round: (value: Expression<number>, digits?: Expression<number>) =>
      builtin<number>("ROUND", digits ? [value, digits] : [value]),
    roundUp: (value: Expression<number>, digits?: Expression<number>) =>
      builtin<number>("ROUNDUP", digits ? [value, digits] : [value]),
    roundDown: (value: Expression<number>, digits?: Expression<number>) =>
      builtin<number>("ROUNDDOWN", digits ? [value, digits] : [value]),
    int: (value: Expression<number>) => builtin<number>("INT", [value]),
    mod: (value: Expression<number>, divisor: Expression<number>) =>
      builtin<number>("MOD", [value, divisor]),
    ifError<T, U>(value: Expression<T>, fallback: Expression<U>): Expression<T | U> {
      return builtin<T | U>("IFERROR", [value, fallback]);
    },
    choose<const Choices extends readonly [ScalarExpression, ...ScalarExpression[]]>(
      index: Expression<number>,
      ...choices: Choices
    ): Expression<ExpressionValue<Choices[number]>> {
      return builtin("CHOOSE", [index, ...choices]);
    },
    sum: (
      first: Expression<number> | Expression<readonly number[]>,
      ...rest: readonly (Expression<number> | Expression<readonly number[]>)[]
    ): Expression<number> => builtin<number>("SUM", [first, ...rest]),
    if<T, U>(
      condition: Expression<boolean>,
      yes: Expression<T>,
      no: Expression<U>,
    ): Expression<T | U> {
      return expression({ _tag: "Call", name: "IF", args: [condition.ast, yes.ast, no.ast] });
    },
    call<P extends readonly PrimitiveSchema[], O extends PrimitiveSchema, E, R>(
      fn: FormulaFunction<P, O, E, R>,
      ...args: Expressions<P>
    ): Expression<SchemaValue<O>> {
      if (registered.get(fn.name) !== fn) throw new Error(`Unregistered function ${fn.name}`);
      return expression({ _tag: "Call", name: fn.name, args: args.map((arg) => arg.ast) });
    },
    parse: (source: string): Ast => parseSync(source, { captureSpans: true }),
    check,
  };
}

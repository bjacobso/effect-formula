import { Effect, Layer, Schema } from "effect";
import {
  type EvalOptions,
  EvaluationFailure,
  evaluate,
  FunctionRegistry,
  type FunctionRegistryService,
  offsetReferenceKeys,
  ReferenceResolver,
  type ReferenceResolverService,
  type ResolutionFailure,
  rangeKeys,
} from "./Engine.js";
import { type Ast, ParseError, type ParseOptions, parseSync, references } from "./Parser.js";
import type { Value } from "./Value.js";
import { error, ValueSchema } from "./Value.js";

export type Update =
  | { readonly _tag: "Input"; readonly key: string; readonly value: Value }
  | { readonly _tag: "Formula"; readonly key: string; readonly formula: string }
  | { readonly _tag: "Remove"; readonly key: string };
export interface Revision {
  readonly revision: number;
  readonly changed: ReadonlyMap<string, Value>;
}
export interface FormulaSession {
  readonly update: (
    updates: readonly Update[],
  ) => Effect.Effect<Revision, ParseError | ResolutionFailure | EvaluationFailure>;
  readonly get: (key: string) => Effect.Effect<Value, ResolutionFailure | EvaluationFailure>;
  readonly snapshot: () => Effect.Effect<ReadonlyMap<string, Value>>;
}
export interface SessionOptions extends ParseOptions, EvalOptions {}
function dependencyKeys(ast: Ast, limit: number): ReadonlySet<string> {
  const keys = new Set<string>(references(ast));
  const visit = (node: Ast): void => {
    switch (node._tag) {
      case "Range":
        for (const row of rangeKeys(node.start, node.end, limit) ?? [])
          for (const key of row) keys.add(key);
        break;
      case "Unary":
        visit(node.value);
        break;
      case "Binary":
        visit(node.left);
        visit(node.right);
        break;
      case "Call":
        if ((node.name === "SUMIF" || node.name === "AVERAGEIF") && node.args[0] && node.args[2])
          for (const row of offsetReferenceKeys(node.args[0], node.args[2], limit) ?? [])
            for (const key of row) keys.add(key);
        node.args.forEach(visit);
        break;
    }
  };
  visit(ast);
  return keys;
}
function affected(
  formulas: ReadonlyMap<string, Ast>,
  touched: ReadonlySet<string>,
  limit: number,
): Set<string> {
  const reverse = new Map<string, Set<string>>();
  for (const [key, ast] of formulas)
    for (const dep of dependencyKeys(ast, limit)) {
      const users = reverse.get(dep) ?? new Set<string>();
      users.add(key);
      reverse.set(dep, users);
    }
  const pending = [...touched];
  const result = new Set<string>();
  while (pending.length) {
    const key = pending.pop()!;
    for (const user of reverse.get(key) ?? [])
      if (!result.has(user)) {
        result.add(user);
        pending.push(user);
      }
  }
  for (const key of touched) if (formulas.has(key)) result.add(key);
  return result;
}
export const createSession = (
  options: SessionOptions = {},
): Effect.Effect<FormulaSession, never, ReferenceResolver | FunctionRegistry> =>
  Effect.gen(function* () {
    const external = yield* ReferenceResolver;
    const functions = yield* FunctionRegistry;
    const semaphore = yield* Effect.makeSemaphore(1);
    let inputs = new Map<string, Value>();
    let formulas = new Map<string, Ast>();
    let results = new Map<string, Value>();
    let revision = 0;
    const get = (key: string) =>
      semaphore.withPermits(1)(
        Effect.suspend(() =>
          inputs.has(key)
            ? Effect.succeed(inputs.get(key)!)
            : results.has(key)
              ? Effect.succeed(results.get(key)!)
              : external.get(key),
        ),
      );
    const snapshot = () => semaphore.withPermits(1)(Effect.sync(() => new Map(results)));
    const update = (updates: readonly Update[]) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const nextInputs = new Map(inputs);
          const nextFormulas = new Map(formulas);
          const nextResults = new Map(results);
          const touched = new Set<string>();
          for (const entry of updates) {
            if (
              !entry.key ||
              !/^(?:cell:[A-Z]+[1-9][0-9]*|field:[A-Za-z_][A-Za-z0-9_.-]*|name:[A-Z_][A-Z0-9_.]*)$/.test(
                entry.key,
              )
            )
              return yield* Effect.fail(
                new EvaluationFailure({ message: `Invalid reference key: ${entry.key}` }),
              );
            touched.add(entry.key);
            switch (entry._tag) {
              case "Input": {
                const decoded = Schema.decodeUnknownEither(ValueSchema)(entry.value);
                if (decoded._tag === "Left")
                  return yield* Effect.fail(
                    new EvaluationFailure({ message: `Invalid value at ${entry.key}` }),
                  );
                if (decoded.right._tag === "Range") {
                  const width = decoded.right.rows[0]?.length ?? 0;
                  if (!width || decoded.right.rows.some((row) => row.length !== width))
                    return yield* Effect.fail(
                      new EvaluationFailure({ message: `Invalid range at ${entry.key}` }),
                    );
                }
                nextInputs.set(entry.key, decoded.right);
                nextFormulas.delete(entry.key);
                nextResults.delete(entry.key);
                break;
              }
              case "Formula": {
                const ast = yield* Effect.try({
                  try: () => parseSync(entry.formula, options),
                  catch: (cause) =>
                    cause instanceof ParseError
                      ? cause
                      : new ParseError({ message: String(cause), offset: 0 }),
                });
                nextFormulas.set(entry.key, ast);
                nextInputs.delete(entry.key);
                break;
              }
              case "Remove":
                nextInputs.delete(entry.key);
                nextFormulas.delete(entry.key);
                nextResults.delete(entry.key);
                break;
            }
          }
          const dirty = affected(nextFormulas, touched, options.maxRangeCells ?? 10000);
          const active = new Set<string>();
          const computed = new Map<string, Value>();
          const compute = (
            key: string,
          ): Effect.Effect<Value, ResolutionFailure | EvaluationFailure> =>
            Effect.gen(function* () {
              if (nextInputs.has(key)) return nextInputs.get(key)!;
              const ast = nextFormulas.get(key);
              if (!ast) return yield* external.get(key);
              if (active.has(key)) return error("#CYCLE!");
              if (computed.has(key)) return computed.get(key)!;
              if (!dirty.has(key) && nextResults.has(key)) return nextResults.get(key)!;
              active.add(key);
              const local: ReferenceResolverService = { get: compute };
              const registry: FunctionRegistryService = functions;
              const value = yield* evaluate(ast, options).pipe(
                Effect.provide(Layer.succeed(ReferenceResolver, local)),
                Effect.provide(Layer.succeed(FunctionRegistry, registry)),
              );
              active.delete(key);
              computed.set(key, value);
              return value;
            });
          for (const key of dirty) yield* compute(key);
          for (const [key, value] of computed) nextResults.set(key, value);
          const changed = new Map<string, Value>();
          for (const key of touched) {
            const value = nextInputs.get(key) ?? nextResults.get(key) ?? error("#REF!");
            if (JSON.stringify(value) !== JSON.stringify(inputs.get(key) ?? results.get(key)))
              changed.set(key, value);
          }
          for (const [key, value] of computed)
            if (JSON.stringify(value) !== JSON.stringify(results.get(key))) changed.set(key, value);
          inputs = nextInputs;
          formulas = nextFormulas;
          results = nextResults;
          revision++;
          return { revision, changed };
        }),
      );
    return { update, get, snapshot };
  });

import { Effect, Layer } from "effect";
import {
  EvaluationFailure,
  emptyFunctions,
  FunctionRegistry,
  ReferenceResolver,
  type ResolutionFailure,
} from "./Engine.js";
import type { ParseError } from "./Parser.js";
import {
  createSession,
  type FormulaSession,
  type Revision,
  type SessionOptions,
  type Update,
} from "./Session.js";
import { blank, error, type Scalar, type Value } from "./Value.js";

export type Entry = Scalar | { readonly formula: string } | null;
export interface HostRevision {
  readonly revision: number;
  readonly changed: ReadonlyMap<string, Value>;
}
export interface FormulaHost {
  readonly set: (
    entries: Readonly<Record<string, Entry>>,
  ) => Effect.Effect<HostRevision, EvaluationFailure | ParseError | ResolutionFailure>;
  readonly get: (name: string) => Effect.Effect<Value, EvaluationFailure | ResolutionFailure>;
  readonly snapshot: () => Effect.Effect<ReadonlyMap<string, Value>>;
}
const fieldName = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function cellKey(name: string): string | undefined {
  const upper = name.toUpperCase();
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(upper);
  return match &&
    Number.isSafeInteger(Number(match[2])) &&
    Number.isSafeInteger(
      [...match[1]!].reduce((col, letter) => col * 26 + letter.charCodeAt(0) - 64, 0),
    )
    ? `cell:${upper}`
    : undefined;
}
function fieldKey(name: string): string | undefined {
  return fieldName.test(name) ? `field:${name}` : undefined;
}
function host(
  session: FormulaSession,
  keyOf: (name: string) => string | undefined,
  prefix: string,
): FormulaHost {
  const validate = (name: string): Effect.Effect<string, EvaluationFailure> => {
    const key = keyOf(name);
    return key
      ? Effect.succeed(key)
      : Effect.fail(new EvaluationFailure({ message: `Invalid ${prefix} name: ${name}` }));
  };
  return {
    set: (entries) =>
      Effect.gen(function* () {
        const updates: Update[] = [];
        for (const [name, entry] of Object.entries(entries)) {
          const key = yield* validate(name);
          if (entry === null) updates.push({ _tag: "Remove", key });
          else if ("formula" in entry)
            updates.push({ _tag: "Formula", key, formula: entry.formula });
          else updates.push({ _tag: "Input", key, value: entry });
        }
        const result: Revision = yield* session.update(updates);
        const changed = new Map<string, Value>();
        for (const [key, value] of result.changed) changed.set(key.slice(prefix.length + 1), value);
        return { revision: result.revision, changed };
      }),
    get: (name) => Effect.flatMap(validate(name), (key) => session.get(key)),
    snapshot: () =>
      Effect.map(
        session.snapshot(),
        (values) =>
          new Map([...values].map(([key, value]) => [key.slice(prefix.length + 1), value])),
      ),
  };
}

/** A1 cells are blank until assigned. Formulas and values share the same session. */
export const createSpreadsheet = (
  options: SessionOptions = {},
): Effect.Effect<FormulaHost, never, FunctionRegistry> =>
  Effect.gen(function* () {
    const functions = yield* FunctionRegistry;
    const resolver = Layer.succeed(ReferenceResolver, {
      get: (key: string) =>
        Effect.succeed(
          key.startsWith("cell:") ? blank : error(key.startsWith("name:") ? "#NAME?" : "#REF!"),
        ),
    });
    const registry = Layer.succeed(FunctionRegistry, functions);
    const session = yield* createSession(options).pipe(
      Effect.provide(Layer.merge(resolver, registry)),
    );
    return host(session, cellKey, "cell");
  });

/** Declared fields are blank until assigned; references to unknown fields return #REF!. */
export const createForm = (
  fields: readonly string[],
  options: SessionOptions = {},
): Effect.Effect<FormulaHost, EvaluationFailure, FunctionRegistry> =>
  Effect.gen(function* () {
    const declared = new Set<string>();
    for (const name of fields) {
      const key = fieldKey(name);
      if (!key)
        return yield* Effect.fail(
          new EvaluationFailure({ message: `Invalid field name: ${name}` }),
        );
      if (declared.has(key))
        return yield* Effect.fail(
          new EvaluationFailure({ message: `Duplicate field name: ${name}` }),
        );
      declared.add(key);
    }
    const functions = yield* FunctionRegistry;
    const resolver = Layer.succeed(ReferenceResolver, {
      get: (key: string) =>
        Effect.succeed(
          declared.has(key) ? blank : error(key.startsWith("name:") ? "#NAME?" : "#REF!"),
        ),
    });
    const registry = Layer.succeed(FunctionRegistry, functions);
    const session = yield* createSession(options).pipe(
      Effect.provide(Layer.merge(resolver, registry)),
    );
    const base = host(session, fieldKey, "field");
    const checked = (name: string) =>
      declared.has(`field:${name}`)
        ? Effect.succeed(name)
        : Effect.fail(new EvaluationFailure({ message: `Unknown field: ${name}` }));
    return {
      set: (entries: Readonly<Record<string, Entry>>) =>
        Effect.gen(function* () {
          for (const name of Object.keys(entries)) yield* checked(name);
          return yield* base.set(entries);
        }),
      get: (name: string) => Effect.flatMap(checked(name), () => base.get(name)),
      snapshot: base.snapshot,
    } satisfies FormulaHost;
  });

export const spreadsheet = (options: SessionOptions = {}) =>
  createSpreadsheet(options).pipe(Effect.provide(emptyFunctions));
export const form = (fields: readonly string[], options: SessionOptions = {}) =>
  createForm(fields, options).pipe(Effect.provide(emptyFunctions));

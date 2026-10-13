import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  createSession,
  defineFormulaFunction,
  emptyFunctions,
  error,
  memory,
  number,
  ReferenceResolver,
  typedFormula,
  type Update,
  type Value,
} from "../src/index.js";

// Deferred gates make cancellation happen during host evaluation, independently of wall-clock speed.
const fixture = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const gate = yield* Deferred.make<void>();
  const cancelled = yield* Deferred.make<void>();
  const resolver = Layer.succeed(ReferenceResolver, {
    get: (key: string) =>
      key === "cell:Z1"
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Deferred.await(gate)),
            Effect.as(number(10)),
            Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
          )
        : Effect.succeed(error("#REF!")),
  });
  const session = yield* createSession().pipe(
    Effect.provide(Layer.merge(resolver, emptyFunctions)),
  );
  const initial = yield* session.update([
    { _tag: "Input", key: "cell:A1", value: number(2) },
    { _tag: "Formula", key: "cell:B1", formula: "=A1*2" },
    { _tag: "Formula", key: "cell:C1", formula: "=B1+1" },
    { _tag: "Formula", key: "cell:D1", formula: "=99" },
  ]);
  expect(initial.revision).toBe(1);
  const before = yield* session.snapshot();
  const batch: readonly Update[] = [
    { _tag: "Input", key: "cell:A1", value: number(10) },
    { _tag: "Remove", key: "cell:D1" },
    { _tag: "Formula", key: "cell:E1", formula: "=Z1+1" },
    { _tag: "Formula", key: "cell:B1", formula: "=A1*3" },
  ];
  return { session, entered, gate, cancelled, before, batch };
});

const interrupted = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
};

describe("session cancellation", () => {
  it("aborts a partly evaluated batch, keeps reads atomic, and accepts a later update", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { session, entered, gate, cancelled, before, batch } = yield* fixture;
          let deliveries = 0;
          const updating = yield* Effect.forkScoped(
            session.update(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  deliveries++;
                }),
              ),
            ),
          );
          yield* Deferred.await(entered);
          const reading = yield* Effect.forkScoped(session.get("cell:A1"));
          const snapshot = yield* Effect.forkScoped(session.snapshot());
          yield* Effect.yieldNow();
          expect(Option.isNone(yield* Fiber.poll(reading))).toBe(true);
          expect(Option.isNone(yield* Fiber.poll(snapshot))).toBe(true);

          interrupted(yield* Fiber.interrupt(updating));
          expect(Option.isSome(yield* Deferred.poll(cancelled))).toBe(true);
          expect(deliveries).toBe(0);
          expect(yield* Fiber.join(reading)).toEqual(number(2));
          expect(yield* Fiber.join(snapshot)).toEqual(before);
          expect(yield* session.get("cell:D1")).toEqual(number(99));
          expect(yield* session.get("cell:E1")).toEqual(error("#REF!"));

          // Even a late resolver completion cannot commit the abandoned copies.
          yield* Deferred.succeed(gate, undefined);
          const next = yield* session.update([{ _tag: "Input", key: "cell:A1", value: number(3) }]);
          expect(next).toEqual({
            revision: 2,
            changed: new Map([
              ["cell:A1", number(3)],
              ["cell:B1", number(6)],
              ["cell:C1", number(7)],
            ]),
          });
          expect(yield* session.get("cell:D1")).toEqual(number(99));
          expect((yield* session.snapshot()).has("cell:E1")).toBe(false);
        }),
      ),
    );
  });

  it("runs queued updates against the prior revision after interrupting the active update", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { session, entered, batch } = yield* fixture;
          const active = yield* Effect.forkScoped(session.update(batch));
          yield* Deferred.await(entered);
          const second = yield* Effect.forkScoped(
            session.update([{ _tag: "Input", key: "cell:A1", value: number(4) }]),
          );
          yield* Effect.yieldNow();
          const third = yield* Effect.forkScoped(
            session.update([{ _tag: "Input", key: "cell:A1", value: number(5) }]),
          );
          yield* Effect.yieldNow();
          expect(Option.isNone(yield* Fiber.poll(second))).toBe(true);
          expect(Option.isNone(yield* Fiber.poll(third))).toBe(true);
          interrupted(yield* Fiber.interrupt(active));
          expect(yield* Fiber.join(second)).toEqual({
            revision: 2,
            changed: new Map([
              ["cell:A1", number(4)],
              ["cell:B1", number(8)],
              ["cell:C1", number(9)],
            ]),
          });
          expect(yield* Fiber.join(third)).toEqual({
            revision: 3,
            changed: new Map([
              ["cell:A1", number(5)],
              ["cell:B1", number(10)],
              ["cell:C1", number(11)],
            ]),
          });
          expect(yield* session.snapshot()).toEqual(
            new Map([
              ["cell:B1", number(10)],
              ["cell:C1", number(11)],
              ["cell:D1", number(99)],
            ]),
          );
        }),
      ),
    );
  });

  it("cancels a waiting update without cancelling the active batch or blocking later waiters", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { session, entered, gate } = yield* fixture;
          const active = yield* Effect.forkScoped(
            session.update([{ _tag: "Formula", key: "cell:E1", formula: "=Z1+1" }]),
          );
          yield* Deferred.await(entered);
          const waiting = yield* Effect.forkScoped(
            session.update([{ _tag: "Input", key: "cell:A1", value: number(100) }]),
          );
          yield* Effect.yieldNow();
          const next = yield* Effect.forkScoped(
            session.update([{ _tag: "Input", key: "cell:A1", value: number(4) }]),
          );
          yield* Effect.yieldNow();
          interrupted(yield* Fiber.interrupt(waiting));
          expect(Option.isNone(yield* Fiber.poll(active))).toBe(true);
          yield* Deferred.succeed(gate, undefined);
          expect(yield* Fiber.join(active)).toEqual({
            revision: 2,
            changed: new Map([["cell:E1", number(11)]]),
          });
          expect(yield* Fiber.join(next)).toEqual({
            revision: 3,
            changed: new Map([
              ["cell:A1", number(4)],
              ["cell:B1", number(8)],
              ["cell:C1", number(9)],
            ]),
          });
          expect(yield* session.get("cell:A1")).toEqual(number(4));
        }),
      ),
    );
  });

  it("rolls back a timeout during evaluation and releases the update permit", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { session, entered, cancelled, before, batch } = yield* fixture;
          const timed = yield* Effect.forkScoped(
            session.update(batch).pipe(Effect.timeout("1 second"), Effect.exit),
          );
          yield* Deferred.await(entered);
          yield* TestClock.adjust("1 second");
          const exit = yield* Fiber.join(timed);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.failureOption(exit.cause)).toMatchObject({
              _tag: "Some",
              value: { _tag: "TimeoutException" },
            });
          expect(Option.isSome(yield* Deferred.poll(cancelled))).toBe(true);
          expect(yield* session.snapshot()).toEqual(before);
          const next = yield* session.update([{ _tag: "Input", key: "cell:A1", value: number(3) }]);
          expect(next.revision).toBe(2);
          expect(next.changed.get("cell:C1")).toEqual(number(7));
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    );
  });

  it("ignores a late Promise resolver response and signals host cancellation", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          let release: ((value: Value) => void) | undefined;
          const response = new Promise<Value>((resolve) => {
            release = resolve;
          });
          let aborted = false;
          const resolver = Layer.succeed(ReferenceResolver, {
            get: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.zipRight(
                  Effect.promise((signal) => {
                    signal.addEventListener(
                      "abort",
                      () => {
                        aborted = true;
                      },
                      { once: true },
                    );
                    return response;
                  }),
                ),
              ),
          });
          const session = yield* createSession().pipe(
            Effect.provide(Layer.merge(resolver, emptyFunctions)),
          );
          yield* session.update([{ _tag: "Input", key: "cell:A1", value: number(2) }]);
          const updating = yield* Effect.forkScoped(
            session.update([
              { _tag: "Input", key: "cell:A1", value: number(10) },
              { _tag: "Formula", key: "cell:B1", formula: "=Z1+1" },
            ]),
          );
          yield* Deferred.await(entered);
          yield* Effect.yieldNow();
          interrupted(yield* Fiber.interrupt(updating));
          expect(aborted).toBe(true);
          release?.(number(30));
          yield* Effect.promise(() => response);
          yield* Effect.yieldNow();
          expect(yield* session.get("cell:A1")).toEqual(number(2));
          expect(yield* session.snapshot()).toEqual(new Map());
          expect(
            yield* session.update([{ _tag: "Input", key: "cell:A1", value: number(3) }]),
          ).toEqual({ revision: 2, changed: new Map([["cell:A1", number(3)]]) });
        }),
      ),
    );
  });

  it("preserves typed session contracts after interruption in an async custom function", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          const slow = defineFormulaFunction(
            "SLOW",
            [Schema.Number] as const,
            Schema.Number,
            ([value]) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.zipRight(Deferred.await(gate)),
                Effect.as(value * 3),
              ),
          );
          const contract = typedFormula({ amount: Schema.Number, total: Schema.Number }, [slow]);
          const session = yield* contract.createSession().pipe(Effect.provide(memory(new Map())));
          yield* session.update([
            { _tag: "Input", key: "field:amount", value: number(2) },
            { _tag: "Formula", key: "field:total", formula: "=[amount]*2" },
          ]);
          const updating = yield* Effect.forkScoped(
            session.update([
              { _tag: "Input", key: "field:amount", value: number(10) },
              { _tag: "Formula", key: "field:total", formula: "=SLOW([amount])" },
            ]),
          );
          yield* Deferred.await(entered);
          interrupted(yield* Fiber.interrupt(updating));
          expect(yield* session.get("field:amount")).toEqual(number(2));
          expect(yield* session.get("field:total")).toEqual(number(4));
          const next = yield* session.update([
            { _tag: "Input", key: "field:amount", value: number(3) },
          ]);
          expect(next).toEqual({
            revision: 2,
            changed: new Map([
              ["field:amount", number(3)],
              ["field:total", number(6)],
            ]),
          });
        }),
      ),
    );
  });
});

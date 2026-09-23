# effect-formula

An Effect-first TypeScript formula engine for products that need spreadsheet-style calculations. A spreadsheet can supply cells and ranges; a form builder can supply fields and records. Both use the same parser, value model, function registry, and evaluator.

This repository contains a working first slice. [SPEC.md](SPEC.md) defines its behavior and limits; [PLAN.md](PLAN.md) tracks the remaining work.

## Direction

- Build a small, usable formula language first, then expand measured compatibility.
- Keep evaluation independent of any particular grid or form UI. Hosts resolve references and control updates.
- Use Effect for typed failures, host services, cancellation, and resource control. Formula errors such as `#DIV/0!` remain formula values, not Effect failures.
- Make semantics and supported functions explicit. “Excel-like” is a usability goal, not a claim of full Excel compatibility.

Supported examples include `=SUM(A1:A5)` in a spreadsheet and `=IF([quantity]>0;[price]*[quantity];0)` in a form. The default dialect uses semicolons between function arguments. Pass `{ dialect: "excel" }` to parse comma-separated calls.

## Use

Requires Node 22 or newer. Run `pnpm install` and `pnpm check` to build and verify the package.

```ts
import { Effect, Layer } from "effect"
import { createSession, emptyFunctions, memory, number } from "effect-formula"

const services = Layer.merge(memory(new Map()), emptyFunctions)
const session = await Effect.runPromise(createSession().pipe(Effect.provide(services)))

await Effect.runPromise(session.update([
  { _tag: "Input", key: "field:quantity", value: number(3) },
  { _tag: "Input", key: "field:price", value: number(12) },
  { _tag: "Formula", key: "field:total", formula: "=[quantity]*[price]" },
]))

console.log(await Effect.runPromise(session.get("field:total")))
// { _tag: "Number", value: 36 }
```

For one-shot evaluation, use `parse` and `evaluate` with a `ReferenceResolver` and `FunctionRegistry` layer. `memory(map)` and `emptyFunctions` provide simple defaults. Reference keys use `cell:A1` and `field:quantity`. `session.update` accepts a batch of `Input`, `Formula`, and `Remove` operations; its result includes a revision and changed values. The session serializes updates and accepts asynchronous reference resolvers.

## Standards and compatibility

[OpenFormula, ODF 1.4 Part 4](https://docs.oasis-open.org/office/OpenDocument/os/v1.4-os.html) is the primary public specification for formula types, syntax, operators, functions, and evaluator conformance groups. Its Small, Medium, and Large groups are useful targets, but this project must pass every requirement in a group before claiming conformance. The initial milestone is a documented subset, **not** an OpenFormula conforming evaluator.

Excel and OOXML compatibility is a separate track. [Microsoft's formula documentation](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-formulas) points to ISO/IEC 29500 for syntax, while Excel behavior and newer functions can go beyond that format. We will maintain a function and behavior matrix with explicit differences and tests, rather than treating one implementation as the specification.

## HyperFormula and licensing

HyperFormula is useful for understanding the product surface and for optional, independently authored behavioral comparisons. Its [license documentation](https://hyperformula.handsontable.com/docs/guide/license-key.html) offers GPLv3 or a proprietary license. We will not copy its source, tests, documentation text, or bundled data into this implementation. A product that embeds HyperFormula under GPLv3 or a commercial license needs its own license review. This repository is public but has **no open-source license**; permission to reuse its code has not been granted. Choose a license before publishing an installable package or inviting outside contributions. This paragraph describes a project boundary, not legal advice.

## Proposed shape

```text
formula text -> dialect/parser -> typed AST -> evaluator -> formula value
                                    |              |
                               dependencies   host services
                                               references, functions
```

The public API exposes parsing, one-shot evaluation, and a stateful calculation session for changed inputs. Hosts can add functions and reference resolvers through Effect services without depending on spreadsheet data structures.

## Status

The parser, evaluator, range and field references, custom functions, and recalculation session are implemented. See [COMPATIBILITY.md](COMPATIBILITY.md) for the precise supported subset and [PLAN.md](PLAN.md) for expansion work. No conformance group is claimed.

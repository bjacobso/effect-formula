# effect-formula

An Effect-first TypeScript formula engine for products that need spreadsheet-style calculations. A spreadsheet can supply cells and ranges; a form builder can supply fields and records. Both use the same parser, value model, function registry, and evaluator.

This repository contains a working engine and a growing OpenFormula compatibility corpus. [SPEC.md](SPEC.md) defines its behavior and limits; [PLAN.md](PLAN.md) tracks the remaining work.

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

### Inspect formula inputs

`parse` returns an AST through Effect. `formulaInputs` walks that AST and returns the canonical keys a formula may read. It expands ranges into cells and includes references in every conditional branch.

```ts
import { Effect, Schema } from "effect"
import { analyzeFormulaTypes, formulaInputSchema, formulaInputs, parse } from "effect-formula"

const ast = await Effect.runPromise(parse("=[price]*[quantity]", { captureSpans: true }))
const inputs = await Effect.runPromise(formulaInputs(ast))
// ["field:price", "field:quantity"]

const schema = await Effect.runPromise(formulaInputSchema(ast, {
  "field:price": Schema.Number,
  "field:quantity": Schema.Number,
}))
const values = await Effect.runPromise(Schema.decodeUnknown(schema)({
  "field:price": 12,
  "field:quantity": 3,
}))

const analysis = await Effect.runPromise(analyzeFormulaTypes(ast, {
  "field:price": "Number",
  "field:quantity": "Number",
}))
// { types: ["Number"], diagnostics: [] }
```

The host supplies a schema for every referenced key. `analyzeFormulaTypes` separately uses host-declared value categories to analyze literals, references, arithmetic, comparisons, `IF`, and functions with known signatures. It returns possible result categories and diagnostics; a Text reference in arithmetic may convert or fail, while an invalid Text literal definitely fails. Functions without a signature and undeclared references return `Unknown`. With `captureSpans: true`, each AST node and type diagnostic has a source span. Offsets are zero-based UTF-16 positions in the original formula, including any leading `=`; the end is exclusive. Parsing without this option keeps the existing compact AST shape. This pass does not replace runtime validation or evaluation. The generated schema validates the host's input object; the host still converts accepted inputs into tagged formula values before evaluation. Whole-row and whole-column ranges require `formulaInputs(ast, { grid: { rows, columns } })`. Unexpandable ranges fail with `FormulaAnalysisError`.

For several formulas, `analyzeFormulaGraph` resolves formula references in dependency order and passes each formula's possible types to its dependents:

```ts
import { Effect } from "effect"
import { analyzeFormulaGraph, parseSync } from "effect-formula"

const formulas = new Map([
  ["field:subtotal", parseSync("=[price]*[quantity]", { captureSpans: true })],
  ["field:total", parseSync("=[subtotal]+[tax]", { captureSpans: true })],
])
const graph = await Effect.runPromise(analyzeFormulaGraph(formulas, {
  "field:price": "Number",
  "field:quantity": "Number",
  "field:tax": "Number",
}))
// graph.formulas.get("field:total")?.types is ["Number"]
```

The result includes dependencies and cycles. A cycle gives its members an `Error` result and a diagnostic. Analysis includes references in every branch, so it may report a cycle that runtime `IF` skips. Function results without signatures remain `Unknown`. Range expansion uses the same grid and size limits as `formulaInputs`.

OpenFormula references such as `[Sales.A1]`, `['Sales West'.A1]`, `[Sales.A1:.B2]`, `[Sales.A:.B]`, and `[Sales.1:.2]` use keys like `cell:Sales!A1` and `cell:Sales%20West!A1`. Pass `{ grid: { rows, columns } }` to `evaluate` or `createSession` when using whole rows or columns; expansion also obeys `maxRangeCells`. A formula stored at `cell:Sales!B1` resolves local `[.A1]` and `A1` against `Sales`. Cross-sheet range spans and external IRI references are not supported yet.

Reference geometry helpers such as `rangeKeys` return `Option`: `Some` contains cell keys, while `None` means the address is invalid or exceeds the configured range limit. Formula evaluation still returns tagged formula values, including errors; operational failures stay in Effect's error channel. Optional configuration fields remain ordinary TypeScript optional inputs.

`VALUE` parses OpenFormula's required number, time, and ISO date text, plus common en-US formats. Its dates use `dateEpoch` (UTC, default `1899-12-30`). Other implicit numeric conversion accepts invariant decimal text only.

### Function profiles

Use `configureFunctions` to add Effect functions, override a built-in, or remove a function from a host's formula language. Names are case-insensitive. The profile is fixed when an evaluation or session receives its Effect layer.

```ts
import { Effect, Layer } from "effect"
import { configureFunctions, memory, number } from "effect-formula"

const functions = configureFunctions({
  register: {
    TRIPLE: ([value]) => Effect.succeed(number(value?._tag === "Number" ? value.value * 3 : 0)),
  },
  signatures: {
    TRIPLE: { parameters: ["Number"], returns: "Number" },
  },
  remove: ["NOW", "TODAY"],
})
const services = Layer.merge(memory(new Map()), functions)
```

Provide `functions` to `createSpreadsheet()` or `createForm(fields)` to use the profile in a host adapter. The `spreadsheet()` and `form(fields)` shortcuts use the default function set. Registered functions receive evaluated arguments. An override of a lazy built-in such as `IF` receives all evaluated arguments; the built-in retains its lazy behavior when not overridden. A removed name returns `#NAME?`, even if also registered.

Signatures are optional metadata for `analyzeFormulaTypes`. They describe exact arity, assumed argument conversions, and a result category; they do not change or validate the runtime implementation. A custom function must honor its declared signature. Supply the same profile's `FunctionRegistry` service as the third analysis argument to apply registered signatures, overrides, and removals. The analyzer currently includes signatures for `ABS`, `LEN`, `LOWER`, `NOT`, and `UPPER`; other built-ins remain `Unknown` until their signatures are audited.

### Host adapters

`spreadsheet()` and `form(fields)` provide small host APIs over the same session:

```ts
import { Effect } from "effect"
import { form, number, spreadsheet } from "effect-formula"

const sheet = await Effect.runPromise(spreadsheet())
await Effect.runPromise(sheet.set({ A1: number(2), B1: { formula: "=A1*3" } }))
console.log(await Effect.runPromise(sheet.get("B1"))) // Number 6

const builder = await Effect.runPromise(form(["price", "quantity", "total"]))
await Effect.runPromise(builder.set({
  price: number(12),
  quantity: number(3),
  total: { formula: "=[price]*[quantity]" },
}))
console.log(await Effect.runPromise(builder.get("total"))) // Number 36
```

Inputs use tagged formula values. A `{ formula: "=..." }` entry is calculated; `null` clears an entry. Spreadsheet addresses are case insensitive and empty cells are blank. Form field names are case sensitive; declared empty fields are blank and unknown fields return `#REF!`. Each `set` call is one atomic batch and returns changed values keyed by host names.

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

The parser, evaluator, references, function profiles, recalculation session, and host adapters are implemented. Every function listed in the ODF 1.4 Small Group now has an implementation path and at least one passing example, including database, date, finance, lookup, statistical, and text functions. The [OpenFormula conformance tracker](conformance/README.md) also has a passing example for every tracked Small Group syntax, conversion, limit, and operator entry. Run `pnpm conformance:report` for the coverage summary. `pnpm conformance:full` remains red because no entry has completed a full section audit. See [COMPATIBILITY.md](COMPATIBILITY.md) for known gaps and [PLAN.md](PLAN.md) for expansion work. No conformance group is claimed.

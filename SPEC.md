# Formula engine specification (draft)

Status: first-slice contract, 2026-09-23. [COMPATIBILITY.md](COMPATIBILITY.md) records the implemented subset. Open questions are marked **Decision to validate**. Passing tests, not this document, establishes supported behavior.

## 1. Goals and boundaries

The engine evaluates formulas in TypeScript applications using Effect. It serves a grid, a form, and other hosts through the same core. It supports scalar values, rectangular ranges, recalculation, and sampled implementations of the Small Group functions. It does not promise complete Excel or OpenFormula compatibility, workbook file import/export, formatting, macros, external links, or dynamic array spilling.

## 2. Reference standards

The normative reference for standard behavior is [ODF 1.4 Part 4, OpenFormula](https://docs.oasis-open.org/office/OpenDocument/os/v1.4-os.html), especially sections 2 (conformance), 3 (processing), 4 (types), 5 (syntax), and 6 (operators/functions). [ODF 1.3 Part 4](https://docs.oasis-open.org/office/OpenDocument/v1.3/OpenDocument-v1.3-part4-formula.html) is retained as a comparison point for interoperability. [Microsoft's OOXML formula overview](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/working-with-formulas) is a secondary reference for Excel-facing syntax. Each implemented behavior will cite its governing section or be labeled as an extension.

OpenFormula defines Small, Medium, and Large evaluator groups; even Small includes substantially more syntax and functions than the first release. We will publish a support matrix and claim a group only after auditing all its requirements, including limits and conversions. There is no single universal “Excel conformance suite” that this project can claim to pass.

## 3. Formula language and dialects

The parser accepts a leading `=` and an expression. The first core dialect uses invariant function names and decimal point, semicolon-separated arguments, and OpenFormula-inspired operators and coercion. It is a **subset**, not a full ODF formula interchange parser. An Excel-style comma separator and A1 spelling may be exposed as an explicit dialect; dialect selection is part of the parse options, never guessed from a formula. Locale-specific input and display are host responsibilities until specified separately.

The current grammar covers finite numeric literals, double-quoted strings with doubled quote escapes, `TRUE` and `FALSE`, parentheses, unary `+` and `-`, `+ - * / ^ &`, `= <> < <= > >=`, function calls, cell references such as `A1` and `$A$1`, rectangular ranges such as `A1:B5`, OpenFormula bracket references with quoted or unquoted sheet names and whole rows or columns, and form field references such as `[quantity]`. Function names are case insensitive and normalized in the AST. Whitespace is insignificant except inside strings, quoted sheet names, and field names. Parser errors include an offset and expected token information.

Precedence and associativity follow the selected dialect and are tested with ambiguous examples. The default OpenFormula dialect places unary signs above exponentiation and associates exponentiation left to right, following the ODF operator precedence table. The Excel option preserves its separate precedence behavior, but remains a partial parser profile without an Excel compatibility claim.

Field references are an extension for form products. They identify stable field keys, not visible labels. Bracket content ending in an uppercase address is reserved for OpenFormula references, so ambiguous field names should be avoided. Sheet-qualified cells and ranges on one sheet are supported; spans across sheets, external IRI sources, subtable locators, named ranges, unions/intersections, array literals, structured table references, and locale syntax remain later milestones. The `currentSheet` parse option supplies context for local references. A session derives it from a formula key such as `cell:Sales!B1`.

## 4. Values, errors, and conversions

The public result is a tagged value: `Blank`, `Number`, `Text`, `Boolean`, `Error`, or a two-dimensional `Range` when an API explicitly requests a range. Numbers use finite JavaScript doubles; non-finite arithmetic returns a formula error. Date and time functions use numeric serial values with a default UTC epoch of 1899-12-30. `EvalOptions.dateEpoch` selects a different ISO epoch and `EvalOptions.clock` supplies a deterministic clock for `NOW` and `TODAY`. Locale-sensitive date parsing, time zones, and Excel's 1900 date behavior remain outside the audited contract.

Cell keys are `cell:A1` on the default sheet or `cell:<percent-encoded-sheet>!A1` for an explicit sheet. Whole-row and whole-column references require `EvalOptions.grid` with positive `rows` and `columns`; expansion above `maxRangeCells` returns `#REF!`. This bound also defines the extent used for dependency tracking in sessions. The one-sheet `spreadsheet()` adapter remains a default-sheet host; multi-sheet hosts can use `createSession` with qualified keys and their own resolver.

Error values include at least `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#NUM!`, and `#CYCLE!` (the last is a project extension). Formula errors propagate through calculations unless a function specifies handling. Host resolution failures, malformed input payloads, cancellation, and unexpected function defects are typed Effect failures; they are never silently converted to a blank or a formula error. Explicit host configuration may map a missing reference to `#REF!`.

Conversions are centralized. The current first-slice rules are:

| Context | Blank | Number | Text | Boolean | Error |
| --- | --- | --- | --- | --- | --- |
| Arithmetic | `0` | unchanged | finite invariant decimal text converts; other text gives `#VALUE!` | `0` or `1` | propagates |
| Logical argument | `FALSE` | zero is `FALSE`; nonzero is `TRUE` | `#VALUE!` | unchanged | propagates |
| Concatenation | empty text | decimal text | unchanged | `TRUE` or `FALSE` | propagates |
| Direct aggregate argument | ignored | included | finite invariant decimal text included; other text gives `#VALUE!` | included as `0` or `1` | propagates |
| Range aggregate entry | ignored | included | ignored | ignored | propagates |

Equality compares like types, with case-insensitive text comparison; different types compare unequal. Ordering uses numeric ordering when both inputs are Numbers and text ordering otherwise. These rules describe current behavior; [conformance/rules.json](conformance/rules.json) marks the relevant OpenFormula sections `partial`. Locale-dependent numeric text and mixed-type ordering need further audit.

`AND` and `OR` accept direct logical or numeric arguments. Range arguments use the OpenFormula NumberSequence behavior: Number and Error cells participate; Blank, Text, and distinct Boolean cells are skipped. An Error cell propagates. Their full function sections remain sampled pending broader argument and array-context audits.

Numeric aggregates convert direct Logical and numeric Text arguments, while references contribute only Number cells (and Error cells where the function propagates errors). `COUNT` ignores errors. The current numeric Text conversion accepts invariant decimal syntax; OpenFormula leaves Text-to-Number conversion implementation-defined.

`NPV` and `IRR` use the same NumberSequence conversion: direct Logical and numeric Text cash flows convert to Number, while referenced Logical and Text cells are skipped without consuming a cash-flow period. Invalid direct Text returns `#VALUE!` under the engine's invariant decimal conversion policy.

`AVERAGE`, `STDEV`, `STDEVP`, `VAR`, and `VARP` scale intermediate calculations so representable results can survive large or tiny finite inputs. Results outside the finite Number domain return `#NUM!`.

`VALUE` implements OpenFormula's required invariant numbers, en-US numeric grouping and currency, mixed fractions, times, ISO dates and datetimes, and common en-US dates. Text-to-Number conversion elsewhere uses the narrower invariant decimal grammar. Dates use the configured epoch and UTC arithmetic; two-digit en-US years use a 1930–2029 window. Other locales and date formats remain to do. `0^0` and `POWER(0;0)` return `#NUM!` per the power constraint.

ISO date-time text accepted by date and time functions validates hour, minute, and second ranges before conversion; out-of-range fields return `#VALUE!`.

## 5. Evaluation and Effect API

The first-slice API is implemented. `parseSync` is also available for pure parsing.

```ts
parse(formula: string, options?: ParseOptions): Effect.Effect<Ast, ParseError>
evaluate(ast: Ast, options?: EvalOptions): Effect.Effect<Value, ResolutionFailure | EvaluationFailure, ReferenceResolver | FunctionRegistry>
createSession(options?: SessionOptions): Effect.Effect<FormulaSession, never, ReferenceResolver | FunctionRegistry>
```

`FormulaEnvironment` supplies a reference resolver and function registry through Effect services/layers. Parsing also exposes the synchronous `parseSync`. Passing `{ captureSpans: true }` adds half-open source spans to AST nodes; offsets count UTF-16 code units from the start of the original formula. Type diagnostics include those spans when available. Evaluation uses Effect so a resolver or custom function can be synchronous or asynchronous and can be cancelled. Session input values are validated with Effect Schema; resolver and custom-function outputs currently rely on their TypeScript contracts. Pure arithmetic inside the evaluator remains plain functions.

`formulaInputs` statically collects canonical reference keys from an AST, expanding cell ranges and conditional aggregate result offsets. It includes all conditional branches, so the set is a conservative input requirement. `formulaInputSchema` builds an Effect Schema from host-declared schemas for those keys and fails if any key lacks a schema. It validates host input shape. `analyzeFormulaTypes` uses separately declared value categories to infer possible result categories for literals, references, arithmetic, comparisons, `IF`, `IFERROR`, `CHOOSE`, and functions with known signatures. It narrows known choices and reports definite and possible conversion problems. An `IFERROR` fallback remains possible for nonliteral first arguments because value-dependent errors are not exhaustively represented by type categories. Function profiles may include signatures with required and optional trailing parameters for registered functions; disabled names yield Error, overrides use their declared signature or remain Unknown. Signatures are advisory metadata, not runtime enforcement. Functions without signatures and undeclared reference types remain `Unknown`; the analysis does not replace evaluation.

`analyzeFormulaGraph` takes a map of canonical formula keys to ASTs and declared types for external inputs. It expands static dependencies, analyzes formulas in dependency order, and passes each possible result category to dependent formulas. Its result includes per-formula analysis, dependency keys, and cycles. Members of a static cycle get an Error category and diagnostic; this may overreport cycles through lazy branches. Unexpandable ranges fail analysis. A formula key takes precedence over a declared external input type with the same key.

Type analysis of `SUM`, `AVERAGE`, `MIN`, and `MAX` follows NumberSequence distinctions: direct Text may convert, while Text and Boolean cells in references are ignored; Error cells propagate. `COUNT` ignores conversion errors, and `COUNTA` and `COUNTBLANK` report Number results based on their counting semantics. Range cell types come from the host declarations or upstream formula analyses. `AVERAGE` includes Error when no numeric entry is guaranteed. Whole-row and whole-column ranges need grid bounds in the analysis options.

Internal absence is represented with `Option`, including function dispatch, parsed dates, reference geometry, and host key validation. `None` means no match or no valid value; a formula error remains an explicit tagged `Error` value. Session state is held in an Effect `Ref` and committed after successful batch evaluation. Public configuration objects keep optional fields for ergonomic calls, and the host `set` API keeps `null` as its explicit remove operation.

The host owns source values and reference identity. `spreadsheet()` maps A1 cells; `form(fields)` maps declared field keys. Both expose `set`, `get`, and `snapshot` over a calculation session. Unset spreadsheet cells and declared empty form fields are Blank; undeclared form fields give `#REF!`. The core neither stores UI state nor assumes all references are cells. The host decides how to authorize and scope data exposed to formula resolvers. Repeated form records and multiple sheets remain future work.

Built-in functions have explicit arity and evaluation behavior in the evaluator. `configureFunctions` creates an Effect function profile: registered functions override built-ins, removed names return `#NAME?`, and removal takes precedence over registration. Registered functions receive eager values; built-in `IF` and `CHOOSE` evaluate only selected branches. Aggregates visit range entries in row-major order. Custom functions may return a formula value or typed Effect failure. The evaluator has configurable limits on expression length, parser nesting, range cells visited, and evaluation steps. Defaults are 65,536 characters, 100 parser levels, 10,000 range cells, and 100,000 evaluation steps.

## 6. Dependencies and recalculation

One-shot evaluation resolves references on demand. A session stores parsed formulas, tracks dependencies by stable host reference keys, invalidates downstream formulas after an input change, and emits changed results. Cycles are detected and reported as `#CYCLE!`; a later milestone may offer iterative calculation as an explicit option. Formula updates and input batches must publish a consistent result snapshot. Async resolver responses from an earlier revision must not overwrite newer results. Dependency tracking must account for conditional functions and dynamic references when those are introduced.

The session recalculates affected formulas eagerly and serializes update batches. `snapshot()` returns stored formula results. Performance optimizations such as persistent range indexes, lazy caching, and worker execution require measured benchmarks and must preserve results.

## 7. First function set

Every function listed in the ODF 1.4 Small Group has at least one passing example. Database functions operate on rectangular ranges with a header row and criteria rows. Conditional aggregates share whole-cell, case-insensitive criterion matching; regular expressions and wildcards are not enabled. Financial functions use numeric solvers for `IRR` and `RATE`, which can return `#NUM!` when they do not converge. `IFERROR` is defined in OpenFormula 1.4 section 6.15.5; field references are a project extension. [COMPATIBILITY.md](COMPATIBILITY.md) summarizes status, and the [group tracker](conformance/README.md) lists required functions and independently written examples. Fuller function edge-case tests remain compatibility work.

Approximate lookup uses OpenFormula's Number, Text, Logical ordering. A Logical lookup can select a preceding Text value; the specified Text-to-Number fallback for ascending searches and Number-to-Text fallback for descending MATCH return `#N/A`.

Conditional aggregate criteria use the engine's invariant decimal Text-to-Number conversion, so prefixes such as `0x` remain Text. `SUMIF` ignores expanded result cells beyond configured grid bounds. `AVERAGEIF` uses the same scaled average calculation as `AVERAGE`.

## 8. Verification and compatibility claims

Checked semantic rules have table-driven cases with source section, input values, and expected result. The current suite covers parser precedence, escapes, reference resolution, coercion, error propagation, lazy branches, cycles, incremental updates, and an asynchronous update race. Cancellation and full section-level edge cases remain future work. Differential runs against other engines may help discover mismatches, but their output is diagnostic rather than an oracle.

Publish a compatibility matrix with statuses `supported`, `partial`, `unsupported`, and `extension`, plus links to tests. A release may say “supports these OpenFormula features” when proven. It may say “ODF 1.4 OpenFormula Small Group evaluator” only after every requirement in that group passes an explicit audit.

## 9. Open decisions

1. Define whether an Excel profile should differ beyond the explicit comma argument separator.
2. Define escaping for `]` in form field keys; the current adapter accepts only `[A-Za-z_][A-Za-z0-9_.-]*` keys.
3. Select a package license and contribution policy before an installable package release or outside contributions.
4. Define locale input, cross-sheet references, date time zones, and Excel profile scope after the scalar milestone.

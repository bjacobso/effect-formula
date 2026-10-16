# Compatibility status

This project implements an independent subset of [OpenFormula 1.4](https://docs.oasis-open.org/office/OpenDocument/os/v1.4-os.html). No OpenFormula evaluator conformance group or full Excel compatibility is claimed. Bracket references on a default or named sheet are accepted, while grid-style `A1` and `[field]` are product syntax; this is not a full ODF formula interchange parser. [conformance/rules.json](conformance/rules.json) is the original focused rule matrix. The [group tracker](conformance/README.md) inventories the listed ODF evaluator group capabilities and distinguishes passing samples from audited requirements.

| Area | Status | Notes |
| --- | --- | --- |
| Scalars and formula errors | Supported subset | Blank, finite number, text, boolean, and common error values. Dates and times use numeric serials with a configurable epoch; complex numbers are absent. |
| Operators | Supported subset | Unary signs, arithmetic, exponentiation, concatenation, and comparisons. Coercion uses the first-slice rules in `Value.ts`. |
| References | Supported subset | Qualified cells and same-sheet ranges, including whole rows and columns with explicit grid bounds, plus form fields. Cross-sheet spans, external IRI sources, and subtable locators remain unsupported. |
| Functions | Sampled | All 110 Small Group functions have passing examples. `VALUE` accepts invariant numbers and common en-US numeric, date, and time formats. Lookup samples cover exact and approximate ordering, duplicates, case-insensitive text, errors, source shape, and omitted `INDEX` coordinates. Lookup functions require a reference or a range value as their data source. Text samples cover character positions, integer conversion, and fractional `REPLACE` arguments. The Medium Group `SEARCH` function is case-insensitive and treats `?`, `*`, and `~` as wildcard syntax. Time samples cover rollover, negative components, and exact hour and minute round trips. Numeric samples cover decimal half ties and extreme digit counts for `ROUND` and `TRUNC`. Date, finance, lookup, database, aggregate, and text semantics still need section-level edge audits. Criteria use whole-cell matching without regular expressions or wildcards. Host profiles can register, override, or remove names. |
| Recalculation | Project behavior | Batch updates, affected formula recalculation, cycles, async update serialization. |
| Host adapters | Project behavior | Spreadsheet cells default to blank; declared form fields default to blank; unknown form fields produce `#REF!`. |
| ODF Small Group | Incomplete | All 141 tracked entries have passing samples; `FALSE`, `TRUE`, `PI`, and `NA` have completed section audits. Full ODF reference syntax, host-defined locale behavior, and function boundary cases remain gaps. |
| Excel compatibility | Partial | Explicit comma-argument parse option; no Excel compatibility claim. |
| HyperFormula compatibility | Production subset | `compatibility: "hyperformula"` matches the recorded production corpus below. Other HyperFormula behavior is not claimed. |

The cases in `conformance/rules.json` run through `test/conformance.test.ts`; the group examples run through `test/openformula-cases.test.ts`. Host behavior is tested in `test/adapters.test.ts`. Run `pnpm conformance:report` for the group status or `pnpm check` for all passing checks. Differential comparisons against other engines are diagnostic only.

## Production formula parity

`test/production-formula.fixtures.ts` contains the supplied production expressions sampled on 2026-10-13 with synthetic answers and recorded HyperFormula results. `test/production-formula.test.ts` runs the original comma-separated expressions through one-shot evaluation (browser-style name binding) and stored session formulas (server-style binding). It also tests a dependent quiz total registered before its score formulas and recalculation after answer changes.

The test host binds omitted answers to Blank, joins multi-select arrays with commas, converts canonical safe integer strings to Number, and preserves other strings, including leading-zero identifiers, long account numbers, and ISO dates. This policy covers the supplied inputs; the application's `convertValue` implementation was not supplied, so these checks do not establish general input-conversion parity. Bare `null` remains a named reference: browser mode binds it to Blank, while server mode leaves it unresolved, preserving the recorded `#NAME?` differences. These modes model binding and evaluation styles, not browser or server runtimes.

The suite evaluates with `compatibility: "hyperformula"`, and all 201 expectation checks pass. That mode changes two OpenFormula rules that these formulas depend on:

| Rule | Default (OpenFormula) | `compatibility: "hyperformula"` |
| --- | --- | --- |
| Comparing Blank with a non-Blank value | Different types compare unequal, so `[x]=""` is false for a blank `x`. | Blank becomes the other operand's empty value (`0`, `""`, or `FALSE`), so `[x]=""` and `[x]=0` are true. |
| `name:` references in `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, and NumberSequence functions | References: Text and Boolean values are ignored. | Direct values: numeric Text converts and other Text gives `#VALUE!`. Cell references and ranges keep reference rules. |

Without the mode, three fixture cases (six checks across both binding modes) return the OpenFormula results instead. `SEARCH` is available in both modes. The ordinary test suite can still record a future difference as a named `it.fails` gap; an unexpected parity pass then fails the suite until the gap entry is removed. Run `pnpm conformance:production` for the strict gate, which treats any recorded gap as a failure. `pnpm conformance` includes the production suite alongside the standards samples. This corpus does not establish complete HyperFormula compatibility.

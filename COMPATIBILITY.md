# Compatibility status

This project implements an independent subset of [OpenFormula 1.4](https://docs.oasis-open.org/office/OpenDocument/os/v1.4-os.html). No OpenFormula evaluator conformance group or full Excel compatibility is claimed. Bracket references on a default or named sheet are accepted, while grid-style `A1` and `[field]` are product syntax; this is not a full ODF formula interchange parser. [conformance/rules.json](conformance/rules.json) is the original focused rule matrix. The [group tracker](conformance/README.md) inventories the listed ODF evaluator group capabilities and distinguishes passing samples from audited requirements.

| Area | Status | Notes |
| --- | --- | --- |
| Scalars and formula errors | Supported subset | Blank, finite number, text, boolean, and common error values. Dates and times use numeric serials with a configurable epoch; complex numbers are absent. |
| Operators | Supported subset | Unary signs, arithmetic, exponentiation, concatenation, and comparisons. Coercion uses the first-slice rules in `Value.ts`. |
| References | Supported subset | Qualified cells and same-sheet ranges, including whole rows and columns with explicit grid bounds, plus form fields. Cross-sheet spans, external IRI sources, and subtable locators remain unsupported. |
| Functions | Sampled | All 110 Small Group functions have at least one passing example. Date, finance, lookup, database, aggregate, and text semantics still need section-level edge audits. Criteria use whole-cell matching without regular expressions or wildcards. Host profiles can register, override, or remove names. |
| Recalculation | Project behavior | Batch updates, affected formula recalculation, cycles, async update serialization. |
| Host adapters | Project behavior | Spreadsheet cells default to blank; declared form fields default to blank; unknown form fields produce `#REF!`. |
| ODF Small Group | Incomplete | All 141 tracked entries have passing samples; none has completed a full section audit. Full ODF reference syntax, host-defined locale behavior, and function boundary cases remain gaps. |
| Excel compatibility | Partial | Explicit comma-argument parse option; no Excel compatibility claim. |

The cases in `conformance/rules.json` run through `test/conformance.test.ts`; the group examples run through `test/openformula-cases.test.ts`. Host behavior is tested in `test/adapters.test.ts`. Run `pnpm conformance:report` for the group status or `pnpm check` for all passing checks. Differential comparisons against other engines are diagnostic only.

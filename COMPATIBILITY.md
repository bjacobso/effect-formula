# Compatibility status

This project implements a small, independent subset of [OpenFormula 1.4](https://docs.oasis-open.org/office/OpenDocument/os/v1.4-os.html). No OpenFormula evaluator conformance group or full Excel compatibility is claimed. The grid-style `A1` references and `[field]` references are product syntax; they are not an ODF formula interchange parser. [conformance/rules.json](conformance/rules.json) is the machine-readable rule matrix. Each checked rule records its standard section, status, and independently written executable cases. `partial` means the listed cases pass; it does not claim the entire standard section is implemented.

| Area | Status | Notes |
| --- | --- | --- |
| Scalars and formula errors | Supported subset | Blank, finite number, text, boolean, and common error values. Dates and complex numbers are absent. |
| Operators | Supported subset | Unary signs, arithmetic, exponentiation, concatenation, and comparisons. Coercion uses the first-slice rules in `Value.ts`. |
| References | Supported subset | One-sheet A1 cells, rectangular ranges, and form fields. No cross-sheet, named, or external references. |
| Functions | Supported subset | `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `IF`, `AND`, `OR`, `NOT`, `IFERROR`. |
| Recalculation | Project behavior | Batch updates, affected formula recalculation, cycles, async update serialization. |
| Host adapters | Project behavior | Spreadsheet cells default to blank; declared form fields default to blank; unknown form fields produce `#REF!`. |
| ODF Small Group | Unsupported | Requires a full requirement-by-requirement audit and many more functions. |
| Excel compatibility | Partial | Explicit comma-argument parse option; no Excel compatibility claim. |

The cases in `conformance/rules.json` run through `test/conformance.test.ts`; host behavior is tested in `test/adapters.test.ts`. Run `pnpm conformance` for the rule cases or `pnpm check` for all checks. Differential comparisons against other engines are diagnostic only.

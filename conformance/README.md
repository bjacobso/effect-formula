# OpenFormula conformance work

The source of truth is [ODF 1.4 Part 4, section 2.3](https://docs.oasis-open.org/office/OpenDocument/os/v1.4-os.html). `openformula-1.4-inventory.json` records the functions explicitly listed for the Small, Medium, and Large evaluator groups, plus the separately listed syntax, conversion, limit, and operator requirements. Medium and Large inherit the earlier groups. The inventory has 141, 164, and 122 entries respectively, for 427 cumulative entries. These are tracking units, not a claim that one case can prove a whole section.

`openformula-cases.json` contains independently written examples linked to inventory IDs. `audits.json` lists requirements that have undergone a complete section-level semantic audit. `FALSE` (§6.15.3), `TRUE` (§6.15.9), `PI` (§6.16.45), and `NA` (§6.13.27) have been audited for their constant return, zero-parameter constraint, and applicable conversion or error behavior. Passing an example alone leaves other requirements **sampled**; add an audit entry only after reviewing the full section and its applicable boundary, error, reference, and type behavior.

The Small Group currently has a passing sample for each of its 141 tracked entries. The corpus supports reusable cell-binding presets, a fixed clock for date functions, and explicit numeric tolerances for iterative calculations. A sample proves only the stated example; it does not establish full support for the referenced section.

Run:

```sh
pnpm conformance:report                  # diagnostic Small Group summary, exit 0
pnpm conformance:full                    # Small Group gate, exits nonzero until audited
pnpm build
node scripts/conformance-full.mjs --group medium --report --json
node scripts/conformance-full.mjs --group large --report --json
```

The runner labels each tracked entry `verified`, `sampled`, `failing`, `missing`, or `uncovered`. `missing` means a no-argument presence probe returned `#NAME?`; a different result only establishes that a function name was recognized. `uncovered` means there is no semantic example. The full gate passes only when every selected entry is `verified` and its examples pass. The Vitest corpus runs the examples in ordinary `pnpm test`.

To regenerate the function list from the official OASIS HTML, run `python3 scripts/import-openformula.py`. The script stores names and section identifiers, not specification prose, and checks the published group function counts. The nonfunction requirement identifiers are maintained in that script and need manual review when the source standard changes. Group-level and general evaluator provisions also need explicit audit before any conformance claim. The current harness is a complete *tracking inventory of the listed group capabilities*, not an exhaustive test suite for their semantics.

# Implementation plan

Status: in progress. The first executable slice is implemented; the checklist below records completed and remaining work.

## Phase 0 — lock the baseline

- Choose a package license before distribution or outside contributions. The public source repository currently grants no reuse license. Keep HyperFormula out of runtime and test dependencies unless a separate license decision explicitly allows it.
- [x] Pin Effect 3 and TypeScript/toolchain versions. Create the package, typecheck, test, and formatting commands.
- [x] Document current dialect and context-by-context coercion behavior in [SPEC.md](SPEC.md). Audit mixed-type comparisons and locale-dependent conversion before a compatibility claim.
- [x] Add [conformance/rules.json](conformance/rules.json), a machine-readable matrix keyed to [ODF 1.4 OpenFormula](https://docs.oasis-open.org/office/OpenDocument/os/v1.4-os.html) sections. The checked cases remain `partial` until each full section is audited.

**Exit:** a buildable package skeleton and a reviewed, testable first-slice contract.

## Phase 1 — one-shot evaluator

- [x] Define tagged formula values, formula errors, typed operational failures, schemas, and AST nodes.
- [x] Implement tokenizer and parser with error offsets, an explicit dialect option, and opt-in AST source spans.
- [x] Implement central conversions and operators, then the first functions from SPEC section 7.
- [x] Define Effect services for reference resolution and custom functions. Provide an in-memory resolver and spreadsheet/form adapters.
- [x] Expose parse and evaluate APIs with examples for a cell range and a form field.
- [x] Expose AST input extraction, host-supplied input schemas, and a first type analysis pass for operators and `IF`.
- [x] Add exact-arity function signature metadata for registered functions and an initial set of built-ins.
- [x] Include source spans in type diagnostics when parsing with `captureSpans`.
- [x] Analyze a graph of formulas in dependency order, propagating possible types and reporting static cycles.
- [ ] Expand audited function signatures so type diagnostics cover more calls.

**Exit:** both examples run against the same core; table-driven tests cover precedence, coercion, blank/error behavior, ranges, and `IF` branch laziness. Unsupported syntax fails clearly.

## Phase 2 — recalculation session

- [x] Add stable dependency keys, formula/input registration, invalidation, batch updates, and changed-result delivery.
- [x] Detect cycles and serialize async updates. Explicit cancellation policy remains to do.
- [x] Exercise multi-step spreadsheet and form scenarios, including changed inputs and an async update race.

**Exit:** a host can update inputs and receive consistent affected results without rebuilding the whole engine. Tests prove cycle and revision behavior.

## Phase 3 — compatibility expansion

- [x] Extract the ODF 1.4 Small, Medium, and Large group function lists and listed nonfunction requirements into an auditable inventory.
- [x] Add executable OpenFormula examples and a strict gate that remains red while requirements lack a full semantic audit.
- [x] Add a shared criterion matcher and `COUNTIF`, `SUMIF`, and `AVERAGEIF`; support host function profiles that register, override, and remove names.
- [x] Provide implementation paths and passing examples for all 110 listed Small Group functions and all 31 tracked nonfunction entries.
- [ ] Complete ODF 5.8 reference syntax. Sheet-qualified references and bounded whole-row/column ranges work; cross-sheet spans, external IRI sources, and subtable locators remain.
- [ ] Audit date epochs, locale and time zone behavior, volatile recalculation, finance solver bounds, and lookup matching.
- [ ] Audit criterion matching against host wildcard, regular-expression, and whole-cell settings before a conformance claim.
- [ ] Expand examples into boundary, error, type, reference, and locale cases for every required function and operator; review all general evaluator provisions.
- [ ] Audit each tracked requirement against the full normative section before moving it to `verified`.
- Fill the remaining unsupported matrix entries from product needs, prioritizing dates, lookup/reference functions, cross-sheet references, and locale or Excel dialect support based on actual consumers.
- Build independent fixtures from OpenFormula rules and run optional differential comparisons. Record mismatches with the rule, dialect, and chosen behavior.
- Audit the full ODF 1.4 Small Group requirements before making any conformance claim. Treat Medium and Large as separate later targets.
- Benchmark large ranges, dependency fan-out, and update latency before changing data structures.

**Exit:** published support matrix, versioned compatibility notes, and benchmarks for the supported workloads.

## Release gates

- The README examples compile and run.
- Public API and behavior match SPEC or the SPEC is updated with an explicit decision.
- Every `supported` matrix entry has a semantic test; errors and async behavior have scenario tests.
- License, package metadata, and third-party notices are set before package publication.

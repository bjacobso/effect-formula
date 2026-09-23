# Implementation plan

Status: in progress. The first executable slice is implemented; the checklist below records completed and remaining work.

## Phase 0 — lock the baseline

- Choose a package license before distribution or outside contributions. The public source repository currently grants no reuse license. Keep HyperFormula out of runtime and test dependencies unless a separate license decision explicitly allows it.
- [x] Pin Effect 3 and TypeScript/toolchain versions. Create the package, typecheck, test, and formatting commands.
- Document final dialect and coercion decisions in [SPEC.md](SPEC.md), including a context-by-context coercion table and error mapping.
- Expand [COMPATIBILITY.md](COMPATIBILITY.md) into a machine-readable feature matrix keyed to [ODF 1.4 OpenFormula](https://docs.oasis-open.org/office/OpenDocument/os/v1.4-os.html) sections. Mark every entry unsupported until a test proves it.

**Exit:** a buildable package skeleton and a reviewed, testable first-slice contract.

## Phase 1 — one-shot evaluator

- [x] Define tagged formula values, formula errors, typed operational failures, schemas, and AST nodes.
- [x] Implement tokenizer and parser with error offsets and an explicit dialect option. Full source spans remain to do.
- [x] Implement central conversions and operators, then the first functions from SPEC section 7.
- [x] Define Effect services for reference resolution and custom functions. Provide an in-memory resolver and grid/form examples.
- [x] Expose parse and evaluate APIs with examples for a cell range and a form field.

**Exit:** both examples run against the same core; table-driven tests cover precedence, coercion, blank/error behavior, ranges, and `IF` branch laziness. Unsupported syntax fails clearly.

## Phase 2 — recalculation session

- [x] Add stable dependency keys, formula/input registration, invalidation, batch updates, and changed-result delivery.
- [x] Detect cycles and serialize async updates. Explicit cancellation policy remains to do.
- [x] Exercise multi-step spreadsheet and form scenarios, including changed inputs and an async update race.

**Exit:** a host can update inputs and receive consistent affected results without rebuilding the whole engine. Tests prove cycle and revision behavior.

## Phase 3 — compatibility expansion

- Fill the feature matrix from product needs, prioritizing dates, lookup/reference functions, cross-sheet references, and locale or Excel dialect support based on actual consumers.
- Build independent fixtures from OpenFormula rules and run optional differential comparisons. Record mismatches with the rule, dialect, and chosen behavior.
- Audit the full ODF 1.4 Small Group requirements before making any conformance claim. Treat Medium and Large as separate later targets.
- Benchmark large ranges, dependency fan-out, and update latency before changing data structures.

**Exit:** published support matrix, versioned compatibility notes, and benchmarks for the supported workloads.

## Release gates

- The README examples compile and run.
- Public API and behavior match SPEC or the SPEC is updated with an explicit decision.
- Every `supported` matrix entry has a semantic test; errors and async behavior have scenario tests.
- License, package metadata, and third-party notices are set before package publication.

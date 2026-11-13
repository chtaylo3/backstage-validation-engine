# Cleanup phase: existing defects

The seven remediation phases preserved four defects on purpose, because those phases were
structural. This phase fixes them. Each defect has its own plan:

| Order | Plan                                                                      | Defect                                                          |
| ----- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1     | [Interruption priority](defect-1-interruption-priority.md)                | Source validation overwrites the interruption it should merge   |
| 2     | [Deterministic fix budget](defect-2-deterministic-fix-budget.md)          | Which findings receive generated fixes depends on worker timing |
| 3     | [Contract errors in rule execution](defect-3-contract-errors-in-rules.md) | A contract error inside a rule is reported as a worker failure  |
| 4     | [Position encoding rejection](defect-4-initialize-encoding-rejection.md)  | `initialize` rejects with an internal error after writing state |

Work through them in this order. Defects 2 and 3 touch the same rule-execution modules, so finish
and verify 2 before starting 3.

## Baseline

At the start of this phase the verification gate passes with 1587 tests in `npm test`, none
skipped, and 48 client tests. `npm run check` fails only at `format:check`, because of the
unrelated untracked `out/` directory.

## Rules

The rules in [the remediation README](../README.md) apply, with these changes for this phase.

1. **Behavior changes are the point, and they are limited.** Change only the behavior that the
   defect plan names. Everything else stays as it is, including messages, limits, and the order of
   findings and coverage rows.
2. **Test first.** For each defect, write the new tests before the fix and confirm that the tests
   which describe the corrected behavior fail on the current code. Record that in the report.
3. **Existing tests.** You may change an existing assertion only when it asserts the defective
   behavior itself. Each plan lists the ones I know of. List every assertion you change, with the
   old and the new expectation. Do not delete or skip a test.
4. **Golden files.** `test/fixtures/pipeline-golden.json`, `test/fixtures/lsp-capabilities.json`,
   `test/fixtures/lsp-lifecycle.json`, and `test/fixtures/lsp-handlers.json` stay byte-identical
   unless a plan says an entry may change. When an entry changes, regenerate with the documented
   environment variable, and show in the report exactly which scenarios or cases changed and why
   each change follows from the fix. An unexplained change is a defect in the fix.
5. **Public surface.** `test/fixtures/public-api.json` and `schemas/*.schema.json` do not change.
   If a fix needs a new exported name, stop and report it.
6. **Architecture rules.** `npm run architecture:check` must pass. Function-size ceilings may only
   go down.
7. **Version control.** Do not commit, stash, reset, restore, clean, push, or switch branches.

## Verification

Run the affected test files after each defect. After all four, run the full gate from
[the remediation README](../README.md#verification-gate).

## Final report

One section per defect, each with:

1. What changed, by file.
2. Each success criterion from the plan, marked met or not met, with evidence.
3. The tests that failed before the fix and pass after it.
4. Every existing assertion or golden entry that changed, with the reason.
5. Deviations from the plan and the reason.

Then the gate output tail with test counts, and any problem found but not fixed.

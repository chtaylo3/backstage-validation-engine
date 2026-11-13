# Cleanup phase: existing defects

The seven remediation phases preserved a set of defects on purpose, because those phases were
structural. This phase fixes them. Each defect has its own plan:

| Order | Plan                                                                             | Defect                                                            |
| ----- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1     | [Interruption priority](defect-1-interruption-priority.md)                       | Source validation overwrites the interruption it should merge     |
| 2     | [Deterministic fix budget](defect-2-deterministic-fix-budget.md)                 | Which findings receive generated fixes depends on worker timing   |
| 3     | [Errors in rule execution](defect-3-contract-errors-in-rules.md)                 | Contract and unknown errors inside a rule become a worker failure |
| 4     | [Position encoding rejection](defect-4-initialize-encoding-rejection.md)         | `initialize` rejects with an internal error after writing state   |
| 5     | [Document notification parameters](defect-5-document-notification-parameters.md) | Document notifications throw on missing parameters                |
| 6     | [Custom notifications before initialization](defect-6-notification-admission.md) | `bve/recordSelection` is dropped without a stated rule            |
| 7     | [Oversized watched-files notifications](defect-7-oversized-watched-files.md)     | A large notification always refreshes, admitted or not            |
| 8     | [Missing catalog observation check](defect-8-missing-observation-check.md)       | A rejection in reference preparation appears unreachable          |
| 9     | [Unknown errors in the source stage](defect-9-source-stage-unknown-errors.md)    | An unknown error is reported as an unavailable adapter            |

## Status and order

- Defects 1 and 4 are independent and are implemented first.
- Defects 5, 6, and 7 change the language server handlers. Do them after defect 4, in that order.
- Defect 8 is independent.
- Defects 2, 3, and 9 share one decision about internal errors, recorded in
  [defect 3](defect-3-contract-errors-in-rules.md#unknown-errors): contain the error, report it
  in detail, keep every other finding, keep validating the rest of the run, and fail the run
  overall. Do them in the order 2, 3, 9. Defect 2 adds the step after the subject lanes and the
  observer; defect 3 defines the internal-error finding and uses that step; defect 9 applies the
  same finding to the source stage.

## Outcome

All nine defects are implemented and reviewed. At the end of the phase the verification gate
passes with 1696 tests in `npm test`, none skipped, and 48 client tests. The pipeline golden, the
handler and lifecycle goldens, the public API snapshot, and the generated schemas are unchanged.
The capabilities golden changed only in the three entries that defect 4 names.

Two points were added during review and are part of the implemented behavior:

- An internal error while the baseline snapshot is validated adds a required, blocked coverage
  row (`overlay` / `baseline-sources`), so the run ends `incomplete`. It adds no finding, because
  a baseline document may not exist in the proposed snapshot.
- An unknown error that still escapes validation is logged for the operator by the CLI and the
  language server as `internal_error stage=validation`, with the same redaction and the same
  `BVE_INTERNAL_ERROR_DETAIL` switch as a contained internal error.

The VS Code Electron, SSH/remote, and Backstage container suites were not run in this phase.

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
5. **Public surface.** `test/fixtures/public-api.json` and `schemas/*.schema.json` do not change
   unless a plan names the change. If a fix needs a new exported name that no plan names, stop and
   report it.
6. **Architecture rules.** `npm run architecture:check` must pass. Function-size ceilings may only
   go down.
7. **Version control.** Do not commit, stash, reset, restore, clean, push, or switch branches.

## Verification

Run the affected test files after each defect. After the defects assigned to you, run the full
gate from [the remediation README](../README.md#verification-gate).

## Final report

One section per defect, each with:

1. What changed, by file.
2. Each success criterion from the plan, marked met or not met, with evidence.
3. The tests that failed before the fix and pass after it.
4. Every existing assertion or golden entry that changed, with the reason.
5. Deviations from the plan and the reason.

Then the gate output tail with test counts, and any problem found but not fixed.

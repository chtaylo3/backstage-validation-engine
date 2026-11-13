# Defect 2: The fix budget depends on worker timing

Read [the cleanup rules](README.md) first.

## Defect

A failing schema rule can carry a generated scalar fix. One run generates at most
`SCALAR_FIX_LIMITS.generated` (64) fixes. The counter (`fixes.generated` on the rule run context)
is shared by the concurrent subject lanes, and each lane takes from it as it reaches a failing
schema rule.

When the policy has no CEL selector or expression, the lanes do not yield, subjects are processed
in sorted order, and the first 64 eligible findings receive the fixes. When a CEL evaluation is
awaited, lanes interleave by worker completion time. With more than 64 eligible findings, which
findings receive a fix then varies between runs of the same request. The report, its digest, and
the editor's quick fixes are not reproducible.

## Fix

Assign fixes after all lanes finish, in a fixed order.

1. **Record candidates, do not build edits, during evaluation.** In
   `src/pipeline/rules/schema-rule.ts` the evaluator pushes its finding without an edit and
   records a fix candidate beside it: the finding, the subject, the validation issue, the source
   document, and the subject's substitutions. Keep both existing `throwIfInterrupted` checks in
   the evaluator, so a rule that is interrupted still ends as it does today.
2. **Assign in order after the lanes.** After `scheduleLanes` returns in
   `src/pipeline/cel-rules.ts`, walk the subject reports in sorted subject order and each
   subject's candidates in rule order. While fewer than 64 fixes have been generated, call
   `scalarConstEdit` for the candidate. A returned edit is attached to its finding and counts
   against the limit. A candidate that yields no edit does not count, as today.
3. **Interruption.** If the request budget is interrupted, stop assigning. Do not throw. The
   findings stay without edits and the report's `interrupted` value is computed as today.
4. **Errors while building a fix.** A fix is optional and must not change a rule's result. A
   `ContractError` propagates. Any other error leaves that finding without an edit.
5. **Remove the shared counter** from the rule run context. The line-index cache
   (`fixes.indexes`) moves to the assignment step.

The order in step 2 equals the order that a policy without CEL already produces, so those runs do
not change.

Keep the candidate list internal. `RuleExecutionReport` and every exported type keep their shape.
Put the assignment step in its own module under `src/pipeline/rules/` and keep every function
within the size limits.

## What changes for callers

- With at most 64 eligible findings: nothing.
- With more than 64 and no CEL in the policy: nothing.
- With more than 64 and CEL in the policy: the same 64 findings receive fixes on every run, namely
  the first 64 eligible ones in sorted subject order and rule order.
- An unexpected error while building a fix no longer turns a failed rule into an incomplete one.

## Success criteria

1. For a fixed request, the report is identical across runs, whatever order the CEL evaluations
   complete in. The new determinism test proves this with at least three completion orders.
2. Exactly `min(64, eligible)` findings carry an edit, and they are the first eligible findings in
   sorted subject order and rule order.
3. `fixes.generated`, or any other counter shared between lanes, no longer exists in
   `src/pipeline/rules/`.
4. `test/fixtures/pipeline-golden.json` is byte-identical. If a scenario changes, the report lists
   it and shows that the policy in that scenario awaits CEL and exceeds the limit.
5. The exported types and `test/fixtures/public-api.json` are unchanged.
6. The new tests below fail before the fix where marked, and pass after it.
7. The full gate passes, and `npm run benchmark:cel` shows no warm p95 regression above 15% for
   the 100-entity case. Report the numbers before and after.

## Test cases

Add a new file in `test/engine/`. Use a stub `CelRuntime` whose `evaluate` returns promises that
the test resolves in a chosen order. No test waits on a timer.

1. **Adversarial completion order** (fails before the fix): 70 subjects, each failing one schema
   rule with a fixable scalar, and a selector on that rule so every subject awaits the runtime.
   Run three times with the selector promises resolved in ascending, descending, and a seeded
   shuffled order. The three reports are equal as canonical JSON, and the subjects with an edit are
   exactly the first 64 by sorted ID.
2. **Two rules per subject**: subjects with two failing schema rules. Fixes follow subject order
   first, then rule order.
3. **Limit boundaries**: 63, 64, and 65 eligible findings give 63, 64, and 64 edits.
4. **Ineligible candidates do not consume the budget**: findings whose issue is not a scalar
   `const` mismatch, or whose location is not authored, are interleaved with eligible ones. All
   eligible findings up to 64 still receive an edit.
5. **No CEL**: a schema-only policy with more than 64 eligible findings produces the same report
   as the current code. Capture the expected report from the current code first.
6. **Interrupted before assignment**: the budget is aborted after the lanes finish and before
   assignment. No finding carries an edit, the findings and rule states are otherwise unchanged,
   and `interrupted` is reported.
7. **Error while building a fix**: a candidate whose edit construction throws a plain `Error`
   leaves that finding without an edit, keeps the rule `failed`, and does not affect other
   findings. A `ContractError` propagates.
8. **Concurrency**: case 1 with one, two, and four lanes gives the same report.

## Out of scope

Changing the limit, the fix content, or which findings are eligible.

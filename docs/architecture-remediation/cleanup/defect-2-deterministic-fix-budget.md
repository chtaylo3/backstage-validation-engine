# Defect 2: The fix budget depends on worker timing

Read [the cleanup rules](README.md) first, and read
[defect 3, "Unknown errors"](defect-3-contract-errors-in-rules.md#unknown-errors): step 4 below
reports an error through the finding, the observer, and the limit that are defined there.
Implement this plan first. Defect 3 then reuses the step that this plan adds after the lanes.

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

A second fault sits in the same code. If building a fix throws, the surrounding rule is recorded
as `incomplete` with a worker failure and its finding is lost, although the schema check itself
had already completed and failed.

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
4. **Errors while building a fix (decided: keep the verdict, drop the fix, report the error in
   detail, and fail the run overall).** A fix is optional, and by the time it is built the rule's
   verdict is known. An error here must not change the rule state or remove the finding.
   - A `ContractError` with the code `limit` leaves that finding without an edit. It is an
     expected bound on optional output, like the 64-fix limit, and is not reported as an error.
   - Any other `ContractError` propagates and fails the run, as in defect 3.
   - Any other error leaves that finding without an edit and keeps the rule `failed`. It is
     reported as an internal error exactly as defect 3 specifies: an `engine/internal_error`
     finding at the original finding's location whose message says a suggested fix for the rule
     could not be built, an `internal_error` failure entry, and a call to the `onInternalError`
     observer with the thrown value. The finding's category is `execution`, so the run's outcome
     becomes `error` (exit code 2). Assignment continues with the next candidate.
   - The internal-error findings from this step count against the same limit of 64 per run as
     those from rule evaluation, in the same sorted order.
5. **Remove the shared counter** from the rule run context. The line-index cache
   (`fixes.indexes`) moves to the assignment step.

The order in step 2 equals the order that a policy without CEL already produces, so those runs do
not change.

Keep the candidate list internal. `RuleExecutionReport` and every exported type keep their shape,
apart from what defect 3's reporting channel adds. Put the assignment step in its own module under
`src/pipeline/rules/` and keep every function within the size limits.

## What changes for callers

- With at most 64 eligible findings: nothing.
- With more than 64 and no CEL in the policy: nothing.
- With more than 64 and CEL in the policy: the same 64 findings receive fixes on every run, namely
  the first 64 eligible ones in sorted subject order and rule order.
- An unexpected error while building a fix no longer turns a failed rule into an incomplete one
  and no longer removes its finding. The rule stays `failed`, its finding stays without a fix, an
  `engine/internal_error` finding is added, and the run's outcome is `error`. Before, the run was
  `incomplete`. Both are exit code 2.
- `executePolicyRules` and `validatePolicySources` accept the optional `onInternalError` observer
  that defect 3 defines. Add it here, since this plan is implemented first.

## Success criteria

1. For a fixed request, the report is identical across runs, whatever order the CEL evaluations
   complete in. The new determinism test proves this with at least three completion orders.
2. Exactly `min(64, eligible)` findings carry an edit, and they are the first eligible findings in
   sorted subject order and rule order.
3. `fixes.generated`, or any other counter shared between lanes, no longer exists in
   `src/pipeline/rules/`.
4. An error while building a fix never changes a rule state, a finding other than its `edits`, or
   a coverage row. An unknown error adds one `engine/internal_error` finding that names the rule,
   adds an `internal_error` failure entry, reaches the observer, and makes the outcome `error`.
   The thrown error's message and stack appear nowhere in the report.
5. `test/fixtures/pipeline-golden.json` is byte-identical. If a scenario changes, the report lists
   it and shows that the policy in that scenario awaits CEL and exceeds the limit.
6. `test/fixtures/public-api.json` is byte-identical. The observer is an optional option field,
   not an exported name.
7. The new tests below fail before the fix where marked, and pass after it.
8. The full gate passes, and `npm run benchmark:cel` shows no warm p95 regression above 15% for
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
7. **Unknown error while building a fix** (fails before): one candidate's edit construction throws
   a plain `Error` whose message is a marker string. That finding has no edit, its rule is still
   `failed`, its coverage row is unchanged, and the candidates after it still receive edits. The
   report has one `engine/internal_error` finding at that finding's location that names the rule,
   and one `internal_error` failure entry. The outcome is `error` and the exit code is 2. The
   marker appears nowhere in the serialized report; the observer receives the original error.
8. **Contract errors while building a fix**: a `limit` error leaves the finding without an edit and
   reports nothing; an `integrity` error rejects the run.
9. **Concurrency**: case 1 with one, two, and four lanes gives the same report.
10. **Shared limit**: with 70 candidates whose edit construction throws, exactly 64 internal-error
    findings are added, for the first 64 in sorted subject and rule order, and all 70 findings
    stay without an edit.

To make edit construction throw in a test without changing its behavior, give the assignment step
an injectable edit builder that defaults to `scalarConstEdit`. Keep it internal.

## Out of scope

Changing the limit, the fix content, or which findings are eligible.

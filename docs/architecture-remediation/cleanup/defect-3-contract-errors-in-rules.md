# Defect 3: A contract error inside a rule is reported as a worker failure

Read [the cleanup rules](README.md) first. Finish [defect 2](defect-2-deterministic-fix-budget.md)
before this one; both change rule execution.

## Defect

`evaluateSubject` in `src/pipeline/rules/subject.ts` catches every error thrown while a rule is
evaluated. Anything that is not a `CelError` becomes `new CelError('worker_failure')`, so the rule
is recorded as `incomplete` with the reason `worker_failure`.

A `ContractError` reports an invalid contract, an invalid policy, a limit, or an integrity
violation. It is not a transient worker problem. Recording it as one hides the real cause, tells
the caller that a retry may help, and lets the run continue on inputs that failed a contract
check. The source stage already does the right thing: it rethrows a `ContractError` and maps only
other errors to coverage.

## Fix

1. **Propagate contract errors.** In the `catch` of `evaluateSubject`, rethrow when the failure is
   a `ContractError`. The mapping of `CelError` and of every other error stays exactly as it is.
2. **Stop the lanes cleanly.** When a subject throws, `scheduleLanes`
   (`src/pipeline/rules/lanes.ts`) must stop handing out new subjects, wait for the lanes that are
   in flight to settle, and then reject with the first error. A subject that is in flight in
   another lane must not start another rule evaluation once a lane has failed. After
   `executePolicyRules` rejects, no rule work for that request is still running.
3. **Let the existing paths report it.** `validatePolicySources` already observes an unexpected
   failure through `onFailure` with the stage `rules` and rethrows. The CLI already turns a
   `ContractError` into an error result with its code. The language server already publishes an
   incomplete diagnostic with the failure evidence. Do not add new reporting.

Before changing the code, list every place a `ContractError` can be thrown from inside the rule
loop today (the evaluators, the selector, finding construction, and anything they call). Put the
list in the report, with one line on what triggers each. If any of them can be triggered by
ordinary repository content, as opposed to configuration, policy, or an integrity violation, stop
and report it before going on: propagating it would turn a contained rule failure into a failed
run for every document.

## What stays the same

- An error that is neither a `CelError` nor a `ContractError` is still contained to its rule and
  recorded as `incomplete` with `worker_failure`. One unexpected exception must not take down a
  whole validation, and the run still fails closed. Distinguishing such errors from real worker
  failures needs a new failure code, which is not part of this fix.
- The `CelError` code table in `src/pipeline/rules/failure-state.ts`.
- The blocked-processor path and every report shape.

## What changes for callers

A `ContractError` raised during rule evaluation now rejects `executePolicyRules` and
`validatePolicySources` with that error. Before, they resolved with a report in which one rule was
incomplete.

## Success criteria

1. A `ContractError` thrown during rule evaluation rejects `executePolicyRules` with the same
   error object: same code, same issues.
2. `validatePolicySources` calls `onFailure` once with the stage `rules` and rejects with the same
   error.
3. After the rejection settles, the runtime receives no further `evaluate` call for that request.
4. Other errors and every `CelError` code produce exactly the rule state, coverage, failure entry,
   and interruption they produce today. `test/engine/core-failure-mapping.test.ts` passes
   unchanged.
5. `test/fixtures/pipeline-golden.json` is byte-identical.
6. The report contains the list of `ContractError` sources described above.
7. The new tests below fail before the fix where marked, and pass after it.
8. The full gate passes.

## Test cases

Add a new file in `test/engine/`. Use a stub `CelRuntime`. No test waits on a timer.

1. **Contract error propagates** (fails before the fix): the runtime throws a `ContractError` with
   the code `integrity` for one subject. `executePolicyRules` rejects with that error.
2. **Each contract code**: the same for `invalid_contract`, `invalid_policy`, and `limit`.
3. **Pipeline observer** (fails before): through `validatePolicySources`, `onFailure` receives one
   evidence row with the stage `rules`, and the call rejects with the error.
4. **Unknown error is contained**: a `TypeError` from the runtime gives that rule `incomplete` with
   `worker_failure`, blocked coverage, a `worker_failure` failure entry, and leaves the other
   subjects' results unchanged.
5. **CEL errors are unchanged**: one representative code from each row of the failure-state table.
6. **Lanes stop** (fails before): with two lanes and controllable promises, subject A throws a
   `ContractError` while subject B is awaiting an evaluation. Resolve B. The call rejects only
   after B's evaluation settles, B's next rule is never evaluated, and no subject after B starts.
7. **First error wins**: two lanes throw different `ContractError`s. The rejection is the first one
   thrown.
8. **Contract error in a later rule**: the first rule passes and the second throws. The call
   rejects, and no partial report is returned.

## Out of scope

A new failure code for unexpected errors, and any change to the source stage or to the language
server's failure diagnostics.

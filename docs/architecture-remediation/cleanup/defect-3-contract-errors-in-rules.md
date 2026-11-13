# Defect 3: Errors inside a rule are reported as a worker failure

Read [the cleanup rules](README.md) first. Finish [defect 2](defect-2-deterministic-fix-budget.md)
before this one; both change rule execution.

**Status: on hold.** The handling of contract errors is decided. The handling of unknown errors is
not; see [Unknown errors](#unknown-errors). Do not implement any part of this plan until that
section records a decision.

## Defect

`evaluateSubject` in `src/pipeline/rules/subject.ts` catches every error thrown while a rule is
evaluated. Anything that is not a `CelError` becomes `new CelError('worker_failure')`, so the rule
is recorded as `incomplete` with the reason `worker_failure`.

Two different kinds of error are mislabelled this way:

- A `ContractError` reports an invalid contract, an invalid policy, a limit, or an integrity
  violation. It is not a transient worker problem.
- An unknown error, such as a `TypeError`, is a programming fault. It is not a worker problem
  either, and recording it as one hides the fault.

In both cases the caller is told that a retry may help, and the run continues.

## Contract errors (decided: split by code)

1. **`integrity`, `invalid_contract`, `invalid_policy`, and any other code except `limit`
   propagate.** In the `catch` of `evaluateSubject`, rethrow. The run fails with that error.
2. **`limit` is contained and recorded truthfully.** A limit reached while evaluating one rule for
   one subject is a property of that subject's content. Record it exactly as a CEL `input_limit`
   is recorded today: the rule is `incomplete` with the reason `resource_limit`, its coverage row
   is `blocked`, a failure entry is added, and the subject's interruption merges
   `resource_limit`. The run continues. `src/runtime/cel/input.ts` already converts a `limit`
   contract error to `input_limit` for the same reason; this applies the same rule to the rest of
   the loop.
3. **Stop the lanes cleanly when an error propagates.** `scheduleLanes`
   (`src/pipeline/rules/lanes.ts`) must stop handing out new subjects, wait for the lanes that are
   in flight to settle, and then reject with the first error. A subject that is in flight in
   another lane must not start another rule evaluation once a lane has failed. After
   `executePolicyRules` rejects, no rule work for that request is still running.
4. **Let the existing paths report a propagated error.** `validatePolicySources` already observes
   an unexpected failure through `onFailure` with the stage `rules` and rethrows. The CLI already
   turns a `ContractError` into an error result with its code. The language server already
   publishes an incomplete diagnostic with the failure evidence.

### Error sources found by the investigation

The rule loop was searched for every place a `ContractError` or another non-`CelError` exception
can be thrown. The split above is consistent with what was found:

| Source                                                  | Error                    | Triggered by                                   |
| ------------------------------------------------------- | ------------------------ | ---------------------------------------------- |
| `createFindingId` → `digestJson` → `canonicalJson`      | `ContractError('limit')` | An identity string beyond the JSON ceilings;   |
|                                                         |                          | not reachable through the request size limits  |
| An injected `CelRuntime`                                | Anything                 | The host or caller that supplied it            |
| The built-in CEL pool                                   | `CelError` only          | `snapshotCelInput` already converts `limit`    |
| `CelWorkerPool.evaluate`                                | `RangeError`             | An invalid request ID or deadline; a clock far |
|                                                         |                          | from real time without an injected runtime     |
| The CEL pool scheduler                                  | `Error`                  | An internal invariant violation                |
| `locateParsedPath`, `SourceLineIndex`                   | `RangeError`             | An invalid pointer or offset from our own code |
| A `RuleSubject` without `location` from a direct caller | `TypeError`              | Public API input, not repository content       |
| An injected `Clock`                                     | Anything                 | The host that supplied it                      |

No `ContractError` inside the loop can be triggered by ordinary repository content. Every unknown
error comes from a programming fault, an injected dependency, or malformed input from a direct
API caller. If the implementation finds a source that is not in this table, stop and report it.

## Unknown errors

**Decision pending.** The owner has rejected the current behavior, in which an unknown error is
contained to its rule and recorded as a worker failure. A survey of how comparable engines handle
an unexpected exception inside one rule is in progress. This section will record:

- whether an unknown error fails the run, is contained to its rule, or is contained to its
  subject, and whether that differs between `ci` and `ide` mode;
- how it is classified, so that it is never reported as a worker failure;
- the channel through which it is reported (for example a failure code, failure evidence, a SARIF
  tool-execution notification), which [defect 2](defect-2-deterministic-fix-budget.md) also uses
  for an error while building a fix;
- whether the wire contract changes.

## What stays the same

- The `CelError` code table in `src/pipeline/rules/failure-state.ts`.
- The blocked-processor path.

## What changes for callers

- A `ContractError` other than `limit` raised during rule evaluation now rejects
  `executePolicyRules` and `validatePolicySources` with that error. Before, they resolved with a
  report in which one rule was incomplete with a worker failure.
- A `limit` contract error raised during rule evaluation is reported for that rule as a resource
  limit, where it was reported as a worker failure.
- Unknown errors: to be recorded with the decision above.

## Success criteria

Criteria for unknown errors will be added with the decision.

1. A `ContractError` with the code `integrity`, `invalid_contract`, or `invalid_policy` thrown
   during rule evaluation rejects `executePolicyRules` with the same error object: same code, same
   issues.
2. `validatePolicySources` calls `onFailure` once with the stage `rules` and rejects with the same
   error.
3. After the rejection settles, the runtime receives no further `evaluate` call for that request.
4. A `ContractError` with the code `limit` thrown during rule evaluation produces, for that rule,
   the same state, coverage status, and interruption as a CEL `input_limit`. Other rules and
   subjects are unaffected.
5. Every `CelError` code produces exactly the rule state, coverage, failure entry, and
   interruption it produces today. `test/engine/core-failure-mapping.test.ts` passes unchanged.
6. `test/fixtures/pipeline-golden.json` is byte-identical.
7. The report contains the list of error sources and confirms the assumption in the last
   paragraph of "Contract errors".
8. The new tests below fail before the fix where marked, and pass after it.
9. The full gate passes.

## Test cases

Tests for unknown errors will be added with the decision. Add a new file in `test/engine/`. Use a
stub `CelRuntime`. No test waits on a timer.

1. **Contract error propagates** (fails before the fix): the runtime throws a `ContractError` with
   the code `integrity` for one subject. `executePolicyRules` rejects with that error.
2. **Each propagating code**: the same for `invalid_contract` and `invalid_policy`.
3. **Limit is contained as a resource limit** (fails before): a `ContractError` with the code
   `limit` for one subject gives that rule `incomplete` with `resource_limit`, blocked coverage,
   and a report `interrupted` value of `resource_limit`. The other subjects' results equal a run
   without the error.
4. **Limit equals CEL input limit**: the rule state, coverage status, and interruption in case 3
   equal those of a `CelError('input_limit')` thrown at the same point.
5. **Pipeline observer** (fails before): through `validatePolicySources`, an `integrity` error
   makes `onFailure` receive one evidence row with the stage `rules`, and the call rejects.
6. **CEL errors are unchanged**: one representative code from each row of the failure-state table.
7. **Lanes stop** (fails before): with two lanes and controllable promises, subject A throws an
   `integrity` error while subject B is awaiting an evaluation. Resolve B. The call rejects only
   after B's evaluation settles, B's next rule is never evaluated, and no subject after B starts.
8. **First error wins**: two lanes throw different propagating errors. The rejection is the first
   one thrown.
9. **Contract error in a later rule**: the first rule passes and the second throws `integrity`.
   The call rejects, and no partial report is returned.
10. **Dependent rule after a contained limit**: a rule that requires the limited rule is blocked
    with `prerequisite_blocked`, as it is after any incomplete prerequisite.

## Out of scope

Any change to the source stage or to the language server's failure diagnostics, beyond what the
unknown-errors decision requires.

# Defect 3: Errors inside a rule are reported as a worker failure

Read [the cleanup rules](README.md) first. Finish [defect 2](defect-2-deterministic-fix-budget.md)
before this one; both change rule execution, and this plan uses the step that defect 2 adds after
the subject lanes.

## Defect

`evaluateSubject` in `src/pipeline/rules/subject.ts` catches every error thrown while a rule is
evaluated. Anything that is not a `CelError` becomes `new CelError('worker_failure')`, so the rule
is recorded as `incomplete` with the reason `worker_failure`.

Two different kinds of error are mislabelled this way:

- A `ContractError` reports an invalid contract, an invalid policy, a limit, or an integrity
  violation. It is not a transient worker problem.
- An unknown error, such as a `TypeError`, is a programming fault. It is not a worker problem
  either, and recording it as one hides the fault.

In both cases the caller is told that a retry may help, and nothing in the result says what
actually happened.

## Contract errors (decided: split by code)

1. **`integrity`, `invalid_contract`, `invalid_policy`, and any other code except `limit`
   propagate.** In the `catch` of `evaluateSubject`, rethrow. The run fails with that error.
2. **`limit` is contained and recorded truthfully.** Record it exactly as a CEL `input_limit` is
   recorded today: the rule is `incomplete` with the reason `resource_limit`, its coverage row is
   `blocked`, a failure entry is added, and the subject's interruption merges `resource_limit`.
   The run continues. `src/runtime/cel/input.ts` already converts a `limit` contract error to
   `input_limit` for the same reason; this applies the same rule to the rest of the loop.
3. **Stop the lanes cleanly when an error propagates.** `scheduleLanes`
   (`src/pipeline/rules/lanes.ts`) must stop handing out new subjects, wait for the lanes that are
   in flight to settle, and then reject with the first error. A subject that is in flight in
   another lane must not start another rule evaluation once a lane has failed. After
   `executePolicyRules` rejects, no rule work for that request is still running.
4. **Let the existing paths report a propagated error.** `validatePolicySources` already observes
   an unexpected failure through `onFailure` with the stage `rules` and rethrows. The CLI turns a
   `ContractError` into an error result with its code. The language server publishes an
   incomplete diagnostic with the failure evidence.

## Unknown errors

**Decided by the owner: contain the error, report it in detail, keep every other finding, keep
evaluating the rest of the run, and fail the run overall.**

This is the model that Kubernetes admission policies, Kyverno, and Semgrep use: the faulty unit
gets its own error status, the rest of the run is reported, and the run as a whole fails. The
engine already works this way for one case. A parser failure becomes a finding with the category
`execution` (`yaml/parser_failure`), and any `execution` finding makes the outcome `error`, which
is exit code 2.

### Behavior

When an error that is neither a `CelError` nor a `ContractError` is thrown while a rule is
evaluated for a subject:

1. **The rule state is `error`.** Use `status: 'error'` with no reason. Do not use `incomplete`
   and do not use `worker_failure`. A rule state of `error` makes the outcome `error` whether or
   not the rule is required, so an optional rule's crash cannot end in `allow`.
2. **The coverage row is `blocked`**, with a fixed reason that says an internal error occurred.
3. **Evaluation continues** with the subject's next rule and with the other subjects. A rule that
   requires the crashed rule is blocked with `prerequisite_blocked`, as after any rule that did
   not pass.
4. **A failure entry is added** with the new code `internal_error`. `failures[].code` is not part
   of the wire contract; add the value to its type.
5. **The subject's interruption does not change.** An internal error is not a resource
   interruption.
6. **An internal-error finding is added**, as described next.

### The internal-error finding

One shape, used here, by [defect 2](defect-2-deterministic-fix-budget.md) for an error while
building a fix, and by [defect 9](defect-9-source-stage-unknown-errors.md) for the source stage.

| Field         | Value                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| `ruleId`      | `engine/internal_error` (rule stage) or `backstage/internal_error` (sources) |
| `ruleVersion` | The policy rule's ID and version joined as `<id>@<version>` (rule stage)     |
| `subjectId`   | The subject                                                                  |
| `category`    | `execution`                                                                  |
| `severity`    | `error`                                                                      |
| `enforcement` | `blocking` in `ci` mode, `advisory` in `ide` mode                            |
| `location`    | The subject's location                                                       |
| `message`     | Fixed text plus the activity, the policy rule ID, and the error's type name  |
| `edits`       | Empty                                                                        |

- The message names what was being done ("evaluating rule `<id>`", "building a suggested fix for
  rule `<id>`"), states that the result for that rule is unknown or that the fix is unavailable,
  and says that this is a fault in the validation engine. It includes the error's `name` (for
  example `TypeError`). It never includes the error's message or stack, because results are
  redacted: an exception message can contain entity content.
- Finding IDs must be distinct for different policy rules on one subject, and must not collide
  with the rule's ordinary finding. Carrying the policy rule in `ruleVersion` achieves that with
  `createFindingId`. If you find a consumer that requires `ruleVersion` to have another meaning,
  stop and report it.
- **Deterministic and bounded.** At most 64 internal-error findings are added per stage in one
  run. Record the errors during evaluation and add the findings in the step that runs after the
  lanes (from defect 2), in sorted subject order and rule order, so the same 64 are chosen on
  every run. Every crashed rule still gets its `error` state, its blocked coverage row, and its
  failure entry, whether or not it received a finding. Name the limit as a constant.

### Detail for the operator

The result is redacted, so the raw error goes to the host and not into the result.

- Add an optional observer, `onInternalError`, to the options of `executePolicyRules` and
  `validatePolicySources`. It is called once per internal error, up to the same limit of 64, with
  the stage, the activity, the policy rule ID, the subject ID, the location, and the thrown value.
  An observer that throws is ignored, as `onFailure` is.
- The CLI passes an observer that writes one line per error to standard error: the code
  `internal_error`, the activity, the rule ID, the source URI and document, and the error's type
  name. When the environment variable `BVE_INTERNAL_ERROR_DETAIL` is `1`, it also writes the
  error's message and stack.
- The language server passes an observer that logs the same line through the connection's
  console, with the same switch for the message and stack.
- Failure evidence: when a rule report contains an `internal_error` failure,
  `validatePolicySources` adds one evidence row for the stage `rules` with the existing cause
  `unknown`. Do not add a new cause value.

### SARIF

`src/reporting/sarif.ts` already reports an unsuccessful run with `executionSuccessful: false` and
one generic notification. Add one `toolExecutionNotifications` entry for each finding whose
category is `execution`, with `level: 'error'`, a `descriptor` whose `id` is the finding's
`ruleId`, the finding's message, and the finding's location. The findings themselves stay in
`results`. Keep the generic notification.

### The CLI's label for an error that still escapes

Unknown errors in the rule loop no longer escape, but an unknown error elsewhere in validation
still can. `src/cli/main.ts` labels every error that is not a `ContractError` as `input_error`,
"Validation input or trusted configuration could not be loaded", which is false for an error
raised after the inputs were loaded. Label an error that is thrown by `validatePolicySources` or
`createVerifiedPolicyResult` and is not a `ContractError` as `internal_error`, with the message
"Validation failed with an internal error.", in both the JSON envelope and the SARIF error.
Errors raised while reading and parsing the inputs keep `input_error`.

## Error sources found by the investigation

The rule loop was searched for every place a `ContractError` or another non-`CelError` exception
can be thrown:

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

## What stays the same

- The `CelError` code table in `src/pipeline/rules/failure-state.ts`, including `worker_failure`
  for real worker faults.
- The blocked-processor path.
- The wire contract and the generated schemas. No enum gains a value.

## What changes for callers

- A `ContractError` other than `limit` raised during rule evaluation rejects `executePolicyRules`
  and `validatePolicySources` with that error.
- A `limit` contract error raised during rule evaluation is reported for that rule as a resource
  limit.
- An unknown error raised during rule evaluation gives that rule the state `error`, adds an
  `engine/internal_error` finding, and makes the run's outcome `error` (exit code 2). All other
  rules and subjects are evaluated and reported. Before, the rule was `incomplete` with
  `worker_failure`, and the run was `incomplete`.
- In the editor, a run with an internal error offers no quick fixes, because the language server
  already withholds fixes from a run that has an `execution` finding.
- `executePolicyRules` and `validatePolicySources` accept `onInternalError`. This is the one
  permitted addition to the public surface: an optional option field. No exported name is added.

## Success criteria

1. A `ContractError` with the code `integrity`, `invalid_contract`, or `invalid_policy` thrown
   during rule evaluation rejects `executePolicyRules` with the same error object, and
   `validatePolicySources` calls `onFailure` once with the stage `rules` and rejects with it.
2. After such a rejection settles, the runtime receives no further `evaluate` call for that
   request.
3. A `ContractError` with the code `limit` produces, for that rule, the same state, coverage
   status, and interruption as a CEL `input_limit`.
4. An unknown error produces, for that rule and subject: the state `error` with no reason, a
   blocked coverage row, an `internal_error` failure entry, and one `engine/internal_error`
   finding with the fields above. No rule state anywhere has the reason `worker_failure` because
   of it.
5. After an unknown error, every other rule of that subject and every other subject is evaluated,
   and their states, findings, and coverage equal those of a run without the error, apart from
   rules that require the crashed rule.
6. A run that contains an unknown error has the outcome `error` and exit code 2 in `ci` mode, for
   a required rule and for an optional rule.
7. The report is identical across runs for a fixed request, whatever order the evaluations
   complete in, including which 64 errors receive a finding.
8. No finding, coverage row, failure entry, or evidence row contains the thrown error's message or
   stack. The observer receives the thrown value.
9. The SARIF output of such a run has `executionSuccessful: false`, the findings in `results`, and
   one error-level notification per `execution` finding.
10. Every `CelError` code produces exactly what it produces today.
    `test/engine/core-failure-mapping.test.ts` passes unchanged.
11. `test/fixtures/pipeline-golden.json`, `test/fixtures/public-api.json`, and `schemas/` are
    byte-identical.
12. The CLI reports a non-contract error thrown during validation as `internal_error`, and an
    unreadable or unparsable input as `input_error`.
13. The new tests below fail before the fix where marked, and pass after it.
14. The full gate passes.

## Test cases

Add new files in `test/engine/` (and `test/cli/` for case 20). Use a stub `CelRuntime`. No test
waits on a timer.

Contract errors:

1. **Contract error propagates** (fails before the fix): the runtime throws a `ContractError` with
   the code `integrity` for one subject. `executePolicyRules` rejects with that error.
2. **Each propagating code**: the same for `invalid_contract` and `invalid_policy`.
3. **Limit is contained as a resource limit** (fails before): the rule is `incomplete` with
   `resource_limit`, coverage is blocked, and the run's `interrupted` is `resource_limit`. The
   other subjects' results equal a run without the error.
4. **Limit equals CEL input limit**: the state, coverage status, and interruption in case 3 equal
   those of a `CelError('input_limit')` thrown at the same point.
5. **Pipeline observer** (fails before): through `validatePolicySources`, an `integrity` error
   makes `onFailure` receive one evidence row with the stage `rules`, and the call rejects.
6. **Lanes stop** (fails before): with two lanes and controllable promises, subject A throws an
   `integrity` error while subject B is awaiting an evaluation. Resolve B. The call rejects only
   after B's evaluation settles, B's next rule is never evaluated, and no subject after B starts.
7. **First error wins**: two lanes throw different propagating errors. The rejection is the first
   one thrown.

Unknown errors:

8. **Truthful state** (fails before): a `TypeError` from the runtime for one subject and rule
   gives the state `error`, blocked coverage, an `internal_error` failure entry, and no
   `worker_failure` reason anywhere in the report.
9. **The finding** (fails before): one `engine/internal_error` finding with the category
   `execution`, the subject's location, the rule ID and `TypeError` in the message, and
   enforcement `blocking` in `ci` and `advisory` in `ide`.
10. **Redaction**: the thrown error's message is a marker string. The marker appears nowhere in
    the serialized report, the serialized SARIF, or the failure evidence. The observer receives
    the original error object.
11. **The rest of the run continues** (fails before, where it asserts the truthful state): three
    subjects and three rules; the second rule crashes for the second subject. The other eight
    rule results equal a run without the crash.
12. **Dependent rules**: a rule that requires the crashed rule is `blocked` with
    `prerequisite_blocked`. A rule that does not require it is evaluated.
13. **Overall failure** (fails before for the optional rule): the outcome is `error` and the exit
    code is 2 when the crashed rule is required, and when it is optional and every other rule
    passes.
14. **Mixed with violations**: a run with one crash and one ordinary failed rule reports both
    findings, and the outcome is `error`.
15. **Determinism and the limit**: 70 subjects whose rule crashes, with the evaluations rejected in
    ascending, descending, and a seeded shuffled order. The three reports are equal. Exactly 64
    internal-error findings exist, for the first 64 subjects by sorted ID. All 70 rule states are
    `error`. The observer is called 64 times.
16. **Observer failure is ignored**: an `onInternalError` that throws does not change the report.
17. **Evidence**: through `validatePolicySources`, a run with an internal error has one evidence
    row with the stage `rules` and the cause `unknown`.
18. **SARIF**: the run in case 14 formats to SARIF with `executionSuccessful: false`, both findings
    in `results`, and one error-level notification whose descriptor ID is `engine/internal_error`.
19. **CEL errors are unchanged**: one representative code from each row of the failure-state
    table, including a real `worker_failure`.
20. **CLI label** (fails before): a validation that throws a plain `Error` after the inputs are
    loaded prints `internal_error` in the JSON envelope and in the SARIF error, and exits with 2.
    An unreadable input file still prints `input_error`. If the CLI cannot be made to throw
    inside validation without a new test hook, test the labelling function directly and say so.
21. **Language server**: through the validation run with a stub validation service, a report with
    an internal-error finding publishes that finding as a diagnostic on its document, keeps the
    other documents' diagnostics, and offers no fixes.

## Out of scope

A new value in the rule-state `reason` enum or in `resources.interrupted`. Separating an internal
error from a CEL evaluation error on the wire needs a contract revision; until then the
`engine/internal_error` finding carries the distinction.

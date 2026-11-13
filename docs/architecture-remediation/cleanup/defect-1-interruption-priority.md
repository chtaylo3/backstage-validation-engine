# Defect 1: Source validation overwrites the interruption

Read [the cleanup rules](README.md) first.

## Defect

The source stage records why it stopped in `state.interrupted`. Six sites assign that field
directly, so the last writer wins. A later, lower-priority cause can replace an earlier,
higher-priority one. The rule stage and the pipeline composition already merge by priority with
`mergeInterruption` (`none` < `resource_limit` < `worker_failure` < `cancelled` < `timeout`).

Example: a document times out, and afterwards the competing-claims check emits more than 64
findings. The report says `interrupted: 'resource_limit'`. The request actually timed out, and the
failure evidence built from this field names the wrong cause.

## Sites

All under `src/compatibility/stages/`:

| File                    | Site                                                     |
| ----------------------- | -------------------------------------------------------- |
| `prepare.ts`            | Adapter preparation interrupted by timeout or cancel     |
| `document.ts`           | Substitution resource limit                              |
| `document.ts`           | Per-document failure mapped to timeout, cancel, or limit |
| `locations.ts`          | Interruption of an included-source report                |
| `locations.ts`          | Location discovery resource limit                        |
| `identity-conflicts.ts` | More than 64 competing-claim findings                    |

## Fix

Replace each direct assignment with
`state.interrupted = mergeInterruption(state.interrupted, next)`. Import `mergeInterruption` from
`src/core/stage-report.ts`.

Do not change anything else at those sites:

- `state.unavailable`, `state.unresolvedIncludes`, and `state.blockedReason` keep their current
  logic. `blockedReason` still describes the most recent cause, because it is the reason shown on
  the blocked rows of the documents that follow.
- The initial value (`parsed.interrupted`) and the processing-gate path are unchanged.
- No finding, coverage row, or message changes.

Update any comment or reference document that says the source stage assigns its interruption.

## What changes for callers

Only the reported cause, and only when two different causes occur in one run:

- `BackstageCompatibilityReport.interrupted` and the values derived from it: the pipeline report's
  `interrupted`, `ValidationResult.resources.interrupted`, and the `sources` failure evidence cause
  in `validatePolicySources`.
- Outcome, enforcement, and exit code do not change, because any interruption already makes the
  run incomplete.

## Success criteria

1. `grep -rn "state.interrupted = " src/compatibility/stages` shows only assignments whose right
   side is a `mergeInterruption` call.
2. For every pair of causes that the source stage can produce in one run, the reported interruption
   is the higher-priority one, whatever the order of occurrence.
3. Runs with one cause, or with none, report exactly what they reported before.
4. `test/fixtures/pipeline-golden.json` is byte-identical. If a scenario changes, the report lists
   it and shows that the old value was a lower-priority cause replacing a higher one.
5. The new tests below fail before the fix where marked, and pass after it.
6. The full gate passes.

## Test cases

Add to `test/engine/pipeline-stages.test.ts` or a new file in `test/engine/`. Use the injectable
adapter loader and the stage functions directly, as the existing stage tests do. No test waits on
a timer.

1. **Timeout, then conflict cap** (fails before the fix): a document failure maps to `timeout`,
   then `resolveIdentityConflicts` exceeds 64 findings. Expect `timeout`.
2. **Cancel, then conflict cap** (fails before): expect `cancelled`.
3. **Included reports in descending priority** (fails before): one Location whose discovery
   returns two reports, the first interrupted by `timeout` and the second by `resource_limit`.
   Expect `timeout`.
4. **Included report, then discovery limit** (fails before): a report interrupted by `cancelled`
   and a discovery issue with `resource_limit`. Expect `cancelled`.
5. **Ascending priority still rises**: `resource_limit` followed by `timeout` gives `timeout`.
6. **Single causes are unchanged**: one case per site, each asserting the same value as before.
7. **Side effects are unchanged**: in case 1, `blockedReason`, `unavailable`, the findings, and the
   coverage rows equal what the current code produces. Capture them from the current code first.
8. **End to end**: a `validatePolicySources` run that reproduces case 1 through stubs reports
   `interrupted: 'timeout'`, and its `sources` failure evidence has the cause `request_timeout`.

If an existing assertion in `test/engine/pipeline-stages.test.ts` encodes the overwrite, update it
and list it in the report.

## Out of scope

Changing which cause is recorded as `blockedReason`, changing priorities, and any change to the
rule stage.

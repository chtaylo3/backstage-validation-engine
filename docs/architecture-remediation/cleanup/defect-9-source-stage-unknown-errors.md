# Defect 9: Unknown errors in the source stage are reported as an unavailable adapter

Read [the cleanup rules](README.md) first, and read
[defect 3, "Unknown errors"](defect-3-contract-errors-in-rules.md#unknown-errors). Implement this
plan after defect 3; it applies the same decision to the source stage and reuses the finding
shape, the limit, and the observer defined there.

## Defect

`recordDocumentFailure` in `src/compatibility/stages/document.ts` maps a failure while one source
document is validated. A `SourceResolutionError`, a `CelError`, and a `BackstageRuntimeError` each
have a truthful mapping. Every other error is labelled `adapter_unavailable`: the document gets a
`backstage/adapter_unavailable` finding with the category `dependency`, the message "Pinned native
adapter is unavailable.", and blocked coverage.

That label is wrong for a programming fault or an unexpected exception from a library. It also has
a second effect: the handler sets `state.unavailable`, so every document after the faulty one is
blocked without being validated. One unexpected exception in one document stops the validation of
all the documents that follow, and the result blames a dependency.

## Decision

The owner's decision for unknown errors applies here: contain the error, report it in detail, keep
every other finding, keep validating the rest of the run, and fail the run overall.

## Investigate first

Before changing code, list every error that can reach the final branch of
`recordDocumentFailure`, and every error that the preparation step in `prepare.ts` maps to
`adapter_unavailable`. Read the stage modules, `src/compatibility/adapter.ts`,
`src/compatibility/native-errors.ts`, `src/compatibility/substitutions.ts`,
`src/compatibility/references.ts`, and `src/compatibility/custom-schemas.ts`. For each source,
record what triggers it and which of these it is:

- **A real unavailable adapter.** For example the pinned package cannot be loaded. This keeps the
  `adapter_unavailable` label. If such a condition reaches the per-document handler as a plain
  `Error`, make its source throw `BackstageRuntimeError('adapter_unavailable')` so the handler can
  tell it apart, and keep the current behavior for it, including blocking later documents.
- **Triggered by the content of a document.** For example a native Backstage validator that
  throws on an unusual entity instead of returning issues. This is not an internal error. It must
  become a finding on that document that says the entity could not be validated by the native
  validator, with a truthful category, and it must not fail the run by itself. Stop and report
  each such source with a proposal before implementing it; the right finding depends on what the
  validator was checking.
- **An internal error.** Everything else: a programming fault, a broken invariant, an injected
  dependency that throws.

Put the list in the report.

## Fix

For an internal error while one document is validated:

1. **Report it as an internal error.** Add a finding with the rule ID `backstage/internal_error`,
   the category `execution`, severity `error`, enforcement `blocking` in `ci` mode and `advisory`
   in `ide` mode, at the document's location. The message names the phase that was running
   (substitution, native validation, reference extraction, or Location discovery), says that the
   document could not be validated because of a fault in the validation engine, and includes the
   error's type name. It never includes the error's message or stack. Use the existing
   `sourceFinding` factory and add the message to the message table.
2. **Block that document's coverage** for the stage that was running, as the handler does today,
   with the internal-error reason.
3. **Do not mark the run unavailable.** Leave `state.unavailable`, `state.blockedReason`, and
   `state.interrupted` unchanged. The documents that follow are validated normally.
4. **Keep the conservative identity guard.** The faulty document produces no entity. Its source
   claim stays as it is at that point, so an unresolved identity still makes
   `unresolvedSourceIdentities` true, and references to it stay blocked.
5. **During Location discovery**, set `state.unresolvedIncludes`, as the handler does today for
   any failure in that phase.
6. **Bound and order the findings.** At most 64 `backstage/internal_error` findings are added in
   one run. Documents are processed in a fixed order, so the first 64 are the same on every run.
   Later internal errors still block their document's coverage.
7. **Tell the operator.** Add the optional `onInternalError` observer to the options of
   `validateBackstageSources`, and have `validatePolicySources` and
   `prepareBackstageReferenceData` pass theirs down. It receives the stage `sources`, the phase,
   the document's URI and index, and the thrown value, up to the same limit.

An `execution` finding makes the run's outcome `error`, which is exit code 2. Because the faulty
document's coverage is blocked, the result is not `allow` in any case.

The preparation step keeps its mapping. An adapter that cannot be loaded is unavailable, and
nothing can be validated without it.

## What changes for callers

- An internal error in one document no longer blocks the documents after it. They are validated
  and reported.
- The faulty document gets a `backstage/internal_error` finding with the category `execution`,
  where it got `backstage/adapter_unavailable` with the category `dependency`.
- The run's outcome is `error`, where it was `incomplete`. Both are exit code 2.
- `validateBackstageSources` accepts `onInternalError`. No exported name is added.

## Success criteria

1. The report contains the list of error sources, each classified as described above.
2. An internal error in one document produces one `backstage/internal_error` finding with the
   fields above and one blocked coverage row for that document, and no
   `backstage/adapter_unavailable` finding.
3. Every other document in the run is validated, and its findings, coverage, entity, and
   references equal those of a run without the error.
4. The run's outcome is `error` and the exit code is 2.
5. `state.unavailable` and `state.interrupted` are unchanged by an internal error.
6. A real unavailable adapter still produces `backstage/adapter_unavailable`, the category
   `dependency`, and blocked coverage for every document, as today.
7. The thrown error's message and stack appear nowhere in the report. The observer receives the
   thrown value.
8. `test/fixtures/pipeline-golden.json` is byte-identical. If a scenario reaches the final branch
   of `recordDocumentFailure` today, list it, show the old and new values, and explain them.
9. `test/fixtures/public-api.json` and `schemas/` are byte-identical.
10. The new tests below fail before the fix where marked, and pass after it.
11. The full gate passes.

## Test cases

Add to `test/engine/pipeline-stages.test.ts` or a new file in `test/engine/`, using the injectable
adapter loader and the stage functions. No test waits on a timer.

1. **Truthful finding** (fails before the fix): the stub adapter's `normalizeEntity` throws a
   `TypeError` for the second of three documents. That document has one
   `backstage/internal_error` finding with the category `execution` that names native validation
   and `TypeError`, and no `backstage/adapter_unavailable` finding.
2. **The run continues** (fails before): in case 1 the first and third documents produce entities,
   coverage, and references equal to a run without the error. Before the fix the third document
   is blocked.
3. **Each phase**: an internal error during substitution, native validation, reference extraction,
   and Location discovery each produces the finding with that phase in its message and the blocked
   coverage row that the handler produces for that phase today.
4. **State is untouched**: after case 1, `unavailable` is `false`, `interrupted` is `none`, and
   `blockedReason` is unchanged.
5. **Identity guard**: the faulty document's claim keeps `unresolvedSourceIdentities` true when it
   has no entity reference, and a reference to it from another document is not qualified.
6. **Location discovery**: an internal error in that phase sets `unresolvedIncludes`.
7. **Redaction**: the thrown error's message is a marker string that appears nowhere in the
   serialized report. The observer receives the original error.
8. **The limit**: 70 documents that each throw give exactly 64 findings, for the first 64
   documents, and 70 blocked coverage rows.
9. **Real unavailable adapter**: a loader that fails gives `backstage/adapter_unavailable` and
   blocks every document, as today. A `BackstageRuntimeError('adapter_unavailable')` from a
   document-level call keeps today's behavior.
10. **Typed errors are unchanged**: a timeout, a cancellation, a resource limit, and a
    `SourceResolutionError` each produce what they produce today.
11. **Contract error**: a `ContractError` from a stage still propagates.
12. **End to end**: through `validatePolicySources` with a stub adapter path or an equivalent
    injection, a run with one internal error has the outcome `error`, the exit code 2, the other
    documents' findings, and one evidence row for the stage `sources` with the cause `unknown`.

## Out of scope

The preparation step's mapping, the typed error mappings, and a new value in any wire enum.

# Phase 2: Explicit pipeline stages

Read [the shared rules](README.md) first. This plan uses the paths that Phase 1 creates.

## Goal

Turn the pipeline's stages into separate modules behind one small report contract, so that a stage
can be read, tested, and replaced on its own, and so that a new stage or rule kind is added as a
module instead of as an edit inside a long function.

## Current state

| Function                        | Lines | File                             |
| ------------------------------- | ----- | -------------------------------- |
| `validateBackstageSources`      | 648   | `src/compatibility/sources.ts`   |
| `executePolicyRules`            | 372   | `src/pipeline/cel-rules.ts`      |
| `prepareBackstageReferenceData` | 250   | `src/pipeline/reference-data.ts` |
| `validatePolicySources`         | 160   | `src/pipeline/policy-sources.ts` |

- `validateBackstageSources` holds one 360-line loop per document. Substitution, native
  normalization, admission, custom schemas, kind validation, reference extraction, and location
  discovery exist only as positions inside that loop. One `catch` maps errors for all of them by
  reading a `phase` variable.
- `executePolicyRules` evaluates schema, catalog, and expression rules in one nested `if` chain
  inside a scheduling closure.
- Interruption priority is defined twice (`policy-sources.ts` and `cel-rules.ts`). Coverage merging
  and failure evidence are assembled inline.
- Finding construction is repeated with small differences in five places.

## Target design

### Shared stage contract (`src/core/stage-report.ts`)

Place it in `core` so that `compatibility` and `pipeline` can both use it.

- `Interruption` type, the single `INTERRUPTION_PRIORITY` table, and `mergeInterruption`.
- `StageReport`: `findings`, `coverage`, `interrupted`. The existing report types extend it.
- `mergeCoverage(rows)`: the de-duplication by `[stage, subject]` with conflict rejection that
  `validatePolicySources` performs today.

### Source validation (`src/compatibility/`)

`sources.ts` keeps the exported `validateBackstageSources` with the same signature and becomes an
orchestrator. Suggested modules under `src/compatibility/stages/`:

| Module                  | Responsibility (current lines in `sources.ts`)                                |
| ----------------------- | ----------------------------------------------------------------------------- |
| `state.ts`              | Run accumulator and the finding factory (155–207)                             |
| `processing-gate.ts`    | Early return when the profile requires processors (82–137)                    |
| `prepare.ts`            | Adapter load, settings check, custom kinds, reference context check (221–274) |
| `substitution.ts`       | Snapshot-local resolution and its coverage                                    |
| `native.ts`             | Normalization, size limit, kind validation                                    |
| `admission.ts`          | Kind admission and custom schema validation                                   |
| `references.ts`         | Identity check and reference extraction                                       |
| `locations.ts`          | Location discovery and included-source reports                                |
| `document.ts`           | Per-document driver and the error-to-coverage mapping (563–623)               |
| `identity-conflicts.ts` | Competing claims and the accepted-entity filter (632–698)                     |

Module names may differ. The boundaries may not: each row is one module with one exported
function, and the driver does not contain stage logic.

### Rule execution (`src/pipeline/rules/`)

`src/pipeline/cel-rules.ts` keeps the exports `executePolicyRules` and `executeCelRules`.

- `schema-rule.ts`, `catalog-rule.ts`, `expression-rule.ts`: one evaluator per rule kind with a
  common signature that returns the state change, findings, coverage changes, and failures.
- A dispatch table typed as `Record<Rule['kind'], RuleEvaluator>`. Adding a rule kind to the
  contract must fail compilation until an evaluator is registered.
- `failure-state.ts`: `failureState` and `stateInterruption`.
- `findings.ts`: the rule finding factory.
- `lanes.ts` (or inside the orchestrator): the subject scheduler.

### Reference preparation and composition

- Split `prepareBackstageReferenceData` into named steps in the same directory.
- `validatePolicySources` uses `mergeInterruption` and `mergeCoverage` from the shared contract.
  Move its failure-evidence assembly into a named function.

### Function size guard

Add a function-length rule to `scripts/architecture-boundaries.mjs` (or a sibling script that
`npm run architecture:check` also runs):

- Any function, method, or arrow function in `src/` or `extensions/vscode/src/` longer than 150
  lines fails.
- A committed allowlist records each existing offender outside this phase's scope with its current
  length as a ceiling. An allowlisted function that grows past its ceiling fails. An allowlist
  entry for a function that is now within 150 lines also fails, so the list only shrinks.
- After this phase the allowlist contains no entry under `src/compatibility/sources.ts`,
  `src/compatibility/stages/`, or `src/pipeline/`.

## Behavior that must be preserved exactly

Outputs are order-sensitive arrays that feed digests. Preserve all of the following:

1. The order in which findings and coverage rows are appended, including rows from included
   sources and rows added in `catch` paths.
2. Every early `continue`, including which coverage rows have already been appended before it.
3. `documents` grows during iteration when a Location entity discovers included documents.
4. After `unavailable` becomes true, every later document receives one blocked coverage row with
   the most recent `blockedReason`.
5. In `sources.ts`, `interrupted` is **assigned**, not merged by priority. Keep assignment
   semantics at each of those sites. Do not replace them with `mergeInterruption`. If you believe a
   site is a defect, report it and leave it.
6. The competing-claims loop stops adding findings after 64 and sets `resource_limit`.
7. In rule execution, `generatedFixes` and `fixIndexes` are shared across lanes, reports are
   ordered by sorted subject ID, and a prerequisite that did not pass blocks the dependent rule.
8. Severity and enforcement formulas differ between finding sites. Merge two sites only when their
   formulas are identical for every input.
9. `ContractError` propagates from every stage; other errors map to coverage as today.

## Work order

1. **Characterize first.** Add the golden test below and generate the golden file from the
   untouched code. Confirm that it passes twice in a row.
2. Add `src/core/stage-report.ts` and switch the two existing priority definitions to it.
3. Extract rule evaluators. Run the golden test after each extraction.
4. Extract source stages one at a time, in pipeline order. Run the golden test after each.
5. Split reference preparation and the composition helper.
6. Add the function size guard and its allowlist.
7. Add the stage unit tests.
8. Run the verification gate.

## Success criteria

1. The golden file generated in step 1 is byte-identical at the end of the phase.
2. `validateBackstageSources`, `executePolicyRules`, `validatePolicySources`, and
   `prepareBackstageReferenceData` are each at most 120 lines. No function under
   `src/compatibility/stages/` or `src/pipeline/` exceeds 120 lines.
3. `INTERRUPTION_PRIORITY` (or any equivalent priority table) is defined once in `src/`.
4. Each rule kind is evaluated in its own module and selected through the typed dispatch table.
5. The function size guard runs in `npm run architecture:check`, and its allowlist has no entry
   for the files in this phase's scope.
6. The public API snapshot from Phase 1 is unchanged.
7. No existing test file changes except for import paths.
8. `npm run benchmark:cel` is run before and after. Report both sets of numbers. A warm p95
   regression above 15% for the 100-entity case needs an explanation in the report.
9. The verification gate passes with zero skipped tests.

## Test cases

### New: `test/pipeline-characterization.test.ts` with `test/fixtures/pipeline-golden.json`

Runs `validatePolicySources` (and `validateBackstageSources` directly where the scenario has no
rules) for each scenario, removes volatile fields (the request's run IDs and times, and
`failureEvidence` timings), and compares the canonical JSON of the remaining report with the golden
file. Reuse the builders in `test/harness/` and the existing fixtures. Scenarios, each in `ci` and
`ide` mode unless noted:

1. All entities valid; expression rules pass.
2. An expression rule fails; a mandatory rule and an advisory rule.
3. A selector excludes a subject (`not_applicable`).
4. A rule whose prerequisite failed (`prerequisite_blocked`).
5. A schema rule: passing, failing with a generated scalar fix, failing without one, and with the
   schema artifact unavailable.
6. More failing schema rules than the scalar-fix generation limit.
7. A catalog rule with facts present, missing, unavailable, and with no catalog configured.
8. A CEL expression that fails to parse (`invalid_policy`) and one that fails at evaluation.
9. A multi-document file with one document that fails to parse; another file that is wholly
   invalid.
10. A substitution that resolves, one that is unsupported, and one that is missing.
11. A Location entity that includes another file; an include that fails to parse; an include cycle.
12. A disallowed kind, a kind admitted by a location rule, a custom kind that is valid, invalid,
    and one whose schema artifact is unavailable.
13. A stock kind with an unrecognized `apiVersion`; a native policy violation; a normalization
    change.
14. An invalid reference, an invalid reference shape, and an invalid identity.
15. Two documents that claim one identity; more than 64 competing claims; a conflicted Location
    whose included entities are dropped.
16. A profile with required processors (the blocked path in both stages).
17. An empty source snapshot.
18. An entity larger than `expandedEntityBytes`.

Do not include scenarios that depend on wall-clock timeouts. Existing tests cover those.

### New: stage unit tests (`test/pipeline-stages.test.ts`, `test/rule-evaluators.test.ts`)

1. `mergeInterruption`: every ordered pair of the five values returns the higher priority.
2. `mergeCoverage`: identical duplicates collapse; a conflicting duplicate rejects with
   `integrity`; first-seen order is kept.
3. Processing gate: an unknown or duplicate `uris` selection rejects; the blocked coverage rows
   cover the five stages; the entity limit truncates the findings.
4. Preparation: an unavailable adapter yields one `unavailable` coverage row; a reference context
   with ambiguous defaults throws `ContractError`.
5. Admission: a global allowance, a location-prefix allowance, an exact-URI allowance, a
   case-insensitive match, and a rejection.
6. Identity conflicts: no conflict, one pair, the 64-finding cap, and the related-location cap of 16.
7. Error mapping in the document driver: for each phase (`substitution`, `native`, `references`,
   `locations`), a thrown timeout, cancellation, resource limit, and unknown error produce the
   expected coverage stage, subject, and interruption.
8. Each rule evaluator, called directly with a stub runtime: pass, fail, not applicable, and
   dependency unavailable; the finding's severity and enforcement in `ci` and `ide` mode.
9. Dispatch table: a compile-time test (`satisfies`) that every `Rule['kind']` has an evaluator.

### New: function size guard tests (extend `test/architecture-boundaries.test.ts`)

1. A 151-line function fails; a 150-line function passes.
2. An allowlisted function at its ceiling passes; one line above fails.
3. A stale allowlist entry fails.
4. Methods, arrow functions, and nested functions are each measured.

### Existing suites that must stay green

All. The most relevant are `backstage-*.test.ts`, `cel-rules.test.ts`, `schema-rules.test.ts`,
`catalog-rules.test.ts`, `fixture-matrix.test.ts`, `independent-conformance.test.ts`,
`core-failure-mapping.test.ts`, and `failure-evidence.test.ts`.

## Risks

- **Silent reordering.** The golden test is the control. Extend it if you find a path it does not
  reach before you refactor that path.
- **Closure state.** The current loop shares many mutable locals. Put them in one explicit state
  object instead of passing a dozen parameters, and keep ownership of each field clear.
- **Lower-layer placement.** `src/core/stage-report.ts` must not import `runtime` or above.

## Out of scope

New stages, new rule kinds, changes to messages, changes to limits, and performance work.

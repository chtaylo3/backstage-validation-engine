# Phase 3: Rule evaluation

Read [the plan overview](README.md) first. This plan uses the resolved trees from Phase 2.

## Goal

Evaluate a CEL rule with its resolved bindings, in the aggregate mode and the per-reference mode,
with fail-closed results for every target that the engine could not read.

## Current state

- `createCelEvaluator` in `src/runtime/cel/evaluator.ts` registers one variable, `entity`. The
  worker protocol in `src/runtime/cel/protocol.ts` and the pool carry `entity` as the only input.
- `snapshotCelInput` in `src/runtime/cel/input.ts` applies the input ceilings (256 KiB, 10,000
  values, depth 64) to that one value.
- The receiver methods `all`, `exists`, `exists_one`, `map`, `filter`, and `size` are in the
  profile allow-lists.
- `evaluateExpressionRule` reports one fixed finding at the subject's location when the
  expression is `false`.
- `evaluateCatalogRule` shows the established handling of unavailable facts: the rule is
  `incomplete` with `dependency_unavailable`, the coverage is `unavailable` or `blocked`, and a
  dependency finding sits at the reference.
- `test/fixtures/cel-qualification.json` is the frozen `bve-cel/1` corpus.

## Target design

### Variables

The runtime accepts a variables object in place of the single entity value. The input ceilings
apply to the whole object.

| Variable | Present when                    | Value                                            |
| -------- | ------------------------------- | ------------------------------------------------ |
| `entity` | Always                          | The normalized subject entity, as today          |
| `refs`   | The rule declares `bindings`    | One property per binding name                    |
| `target` | The rule has `forEachReference` | The bound item of the reference under evaluation |

A bound item is `{ ref, entity, refs }`:

- `ref` is the canonical entity reference string.
- `entity` holds `apiVersion`, `kind`, `metadata.name`, `metadata.namespace`, and the values at
  the binding's `fields` pointers, placed at the same paths. A pointer that the target does not
  have is absent, so `has()` works.
- `refs` holds the nested bindings and is absent when the binding declares none.

A binding without `one` is a list in declared reference order. A binding with `one: true` is the
single item, and the property is absent when the parent has no reference at the path. More than
one reference under `one: true` is an evaluation error of the rule.

An expression that names `refs` or `target` without the matching declaration is an invalid
policy, as an unknown variable is today. Compile programs per variable set, and include the
variable set in the program cache key.

### Aggregate mode

Evaluate the expression once per subject. On `false`, report the existing fixed finding. Take the
first-hop binding whose name sorts first. Place the finding at the subject's first reference of
that binding when one exists, and at the subject otherwise. Binding names have no declared order,
because canonical JSON sorts object keys.

### Per-reference mode

Evaluate the expression once per reference at `forEachReference.path`, with `target` bound. The
rule passes when every evaluation is `true`. Each `false` evaluation adds one finding at that
reference's source location, with the included-file ranges that reference findings carry today.
A subject with no reference at the path is `not_applicable`. Evaluations share the rule's
subject budget and stop at the first interruption.

### Unreadable targets

Decide the rule state from the resolved tree before any evaluation:

| Tree contains                                | Rule state and coverage                                    |
| -------------------------------------------- | ---------------------------------------------------------- |
| An `unavailable`, `blocked`, or expired node | `incomplete`, `dependency_unavailable`; dependency finding |
| A `missing` node below the first hop         | `incomplete`, `dependency_unavailable`; dependency finding |
| A recorded resource limit for the rule       | `incomplete` with the resource-limit reason                |
| Only `present` nodes                         | Evaluate                                                   |

A missing first-hop node cannot reach this step, because Phase 1 requires an existence rule as a
prerequisite and a failed prerequisite blocks the rule. Keep an assertion for that case which
records the rule as blocked. The dependency finding sits at the first-hop reference that leads to
the unreadable node and uses the fixed message of the `catalog` rule.

A variables object over the CEL input ceiling is the existing `input_limit`. No path through
this step records `passed` without evaluating the expression over a complete tree.

### Expiry

A rule result that used bound entities expires no later than the earliest expiry of those
entries. Reuse the mid-run expiry check of the `catalog` rule.

### Qualification corpus

Add `test/fixtures/cel-bindings-qualification.json` with cases for `refs` and `target`: list
macros over bound items, `has()` on absent projected fields, absent `one` bindings, and missing
versus null values. Run every case through the production workers, as the existing corpus runs.
The pinned CEL-Go comparison stays on the frozen corpus.

## Work order

1. Change the runtime, the pool, and the worker protocol to carry variables. Keep the existing
   single-entity call form working for selectors and for rules without bindings.
2. Build the variables object from the resolved tree and the pinned data, with projection.
3. Implement the two modes and the unreadable-target table in the expression evaluator, and
   remove the Phase 1 unsupported guard.
4. Add the qualification fixture and its runner.
5. Add pipeline, CLI, SARIF, and language server tests.
6. Update `docs/cel-runtime.md`, `docs/contracts.md`, and `docs/lsp.md`.

## Success criteria

1. Both rules of the [motivating example](README.md#motivating-example) give the expected pass
   and violation results through the CLI and through a stdio language server session.
2. The per-reference rule reports one finding per offending `dependsOn` entry, at that entry.
3. Every row of the unreadable-target table has a test that ends with exit code 2 and no
   `passed` state for the rule.
4. The frozen `bve-cel/1` corpus and the pipeline characterization output are unchanged.
5. A bound item exposes only the identity fields and the declared `fields`.
6. Worker fairness, cancellation, and crash-recovery tests pass with the variables input.

## Test cases

- **Counting rule.** Zero, two, and three cross-zone dependencies: pass, pass, violation.
- **Per-reference rule.** Three dependencies with the second one cross-zone: one finding at index
  1. An included `dependsOn` list keeps the payload range and the inclusion site.
- **Projection.** `d.entity.spec.owner` is absent when `fields` omits `/spec/owner`.
- **Absent values.** A dependency without `spec.system`, with and without a `has()` guard: `false`
  result and evaluation error, respectively.
- **Cardinality.** Two references under `one: true` give an evaluation error.
- **Undeclared variables.** `refs` without `bindings`, and `target` without `forEachReference`,
  are invalid policy.
- **Unreadable targets.** Unavailable at hops 1, 2, and 3; missing at hops 2 and 3; expired entry
  between collection and evaluation; resource limit from Phase 2.
- **Input ceiling.** A tree whose variables object holds more than 10,000 values, and one over
  256 KiB, each give a resource limit.
- **Proposed precedence.** A dependency whose zone changes in the same workspace is evaluated
  with the proposed zone.
- **Determinism.** Two runs over the same pinned request produce identical findings and order.

## Exit criteria

The phase is complete, and Phase 4 may start, when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. The Phase 1 unsupported guard is removed, and no test depends on it.
3. The new qualification fixture runs through the production workers in the gate.
4. `npm run test:packaged` passes, because the worker protocol changed.
5. The report lists every way a binding rule can reach `passed`, and each one evaluates the
   expression over a tree of `present` nodes only.

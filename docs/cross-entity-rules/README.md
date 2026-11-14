# Cross-entity rules plan

This directory holds the implementation plans for CEL rules that read the entities an entity
refers to, and for editor completion that respects those rules. The plans are for the engineers
and agents who implement and review the work. Each phase is one independently reviewable change,
and the phases run in order.

| Phase | Plan                                                    | Outcome                                                            |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| 1     | [Rule contract](phase-1-rule-contract.md)               | Policy can declare bindings; admission enforces the bounds         |
| 2     | [Reference collection](phase-2-reference-collection.md) | The engine resolves binding trees in bounded rounds and pins them  |
| 3     | [Rule evaluation](phase-3-rule-evaluation.md)           | CEL receives the resolved entities, in aggregate and per reference |
| 4     | [Editor candidates](phase-4-editor-candidates.md)       | Completion demotes and labels candidates that would fail a rule    |
| 5     | [Qualification](phase-5-qualification.md)               | Example, reference documents, packaged and cross-platform evidence |

The [distribution plan](../distributions/README.md) depends on phases 1 to 3.

## Motivating example

An enterprise assigns a `zone` to every System. A Component may depend on at most two Components
whose System is in a different zone. The rule needs two hops: from the Component to each
dependency, and from each dependency to its System.

```json
{
  "id": "limit-cross-zone-dependencies",
  "kind": "cel",
  "version": "1",
  "mandatory": true,
  "severity": "error",
  "requires": ["dependencies-exist", "system-exists"],
  "bindings": {
    "system": { "path": "/spec/system", "one": true, "fields": ["/spec/zone"] },
    "deps": {
      "path": "/spec/dependsOn/*",
      "fields": [],
      "bindings": {
        "system": { "path": "/spec/system", "one": true, "fields": ["/spec/zone"] }
      }
    }
  },
  "expression": "refs.deps.filter(d, d.refs.system.entity.spec.zone != refs.system.entity.spec.zone).size() <= 2"
}
```

The stricter rule "every dependency is in the same zone" uses the per-reference mode, so that the
finding points at the offending `dependsOn` entry:

```json
{
  "id": "same-zone-dependencies",
  "kind": "cel",
  "version": "1",
  "mandatory": true,
  "severity": "error",
  "requires": ["dependencies-exist", "system-exists"],
  "bindings": {
    "system": { "path": "/spec/system", "one": true, "fields": ["/spec/zone"] }
  },
  "forEachReference": {
    "path": "/spec/dependsOn/*",
    "fields": [],
    "bindings": {
      "system": { "path": "/spec/system", "one": true, "fields": ["/spec/zone"] }
    }
  },
  "expression": "target.refs.system.entity.spec.zone == refs.system.entity.spec.zone"
}
```

## Decisions

The owner made these decisions on 2026-11-13. A phase plan does not reopen them.

1. **Binding trees.** A CEL rule declares a tree of named bindings. Each binding follows one
   declared reference context from the entity it sits under. Nesting adds a hop.
2. **Two evaluation modes.** The aggregate mode evaluates the expression once with the lists in
   `refs`. The per-reference mode (`forEachReference`) evaluates it once per reference with that
   reference in `target`.
3. **Boolean results only.** An expression returns `true` or `false`. An aggregate rule therefore
   reports on the bound field as a whole. Expressions that return the offending references are
   out of scope.
4. **Bounds.** The engine enforces the ceilings in the next section. A deployment profile can
   lower them and cannot raise them.
5. **Unreadable targets never pass.** An unavailable, blocked, or expired target gives incomplete
   coverage and exit code 2. A missing first-hop target blocks the rule through its required
   existence rule, which reports the missing entity.
6. **Forward references only.** The engine follows references that an entity declares. Reverse
   lookups and catalog-wide totals belong to compiled plugins.
7. **Contract version.** The fields are optional additions to policy contract 0.2. An engine
   without this work rejects a policy that uses them, because the contract schemas are closed.
8. **Editor behavior.** A policy author opts in per rule through an editor artifact. Completion
   demotes and labels a candidate that would fail the rule. It never hides one.
9. **Late results.** The server prepares checks when validation completes, and it fills in the
   label of a highlighted item through `completionItem/resolve`. The bundled extension does not
   re-trigger the suggestion list.

## Design rules that this plan proposes

The plan author proposes these rules. The owner has not yet confirmed them; confirm or change
them before Phase 1 starts.

1. **Existence prerequisite.** A rule that binds a first-hop path must require an existence rule
   for that path (Phase 1). This is how decision 5 becomes a reported finding and not a silent
   block.
2. **Profile-level CEL version.** A deployment profile selects `bve-cel/2`; a policy with binding
   rules needs it (Phase 1).
3. **No derived properties.** A binding cannot project `/relations` or `/status` (Phase 1).
4. **Labels on failures only.** Completion labels a candidate that would fail the rule. A
   candidate that passes gets no label, because one rule does not prove policy compliance
   (Phase 4).
5. **Same artifact version.** The editor artifact stays `bve-editor/1` and gains optional
   properties, by the reasoning of decision 7 (Phase 4).

## Bounds

| Bound                                          | Ceiling | Reason                                                                  |
| ---------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| Hops from the subject                          | 3       | Each hop is a round of catalog lookups inside the 5-second request time |
| Bindings per rule, counting `forEachReference` | 8       | Keeps a rule reviewable                                                 |
| Projected fields per binding                   | 16      | Keeps the CEL input small and names the data a rule depends on          |
| Targets per binding, per parent entity         | 64      | Covers large `dependsOn` lists                                          |
| Resolved entities per rule and subject         | 256     | Must fit the CEL input ceiling of 256 KiB and 10,000 values             |
| Distinct catalog references per request        | 1,000   | The existing `CATALOG_LIMITS.references` and refresh inventory ceiling  |
| Candidates checked per completion request      | 32      | Bounds background catalog reads and CEL jobs while the user types       |

A request that exceeds a bound records a resource limit for the affected rule. The engine never
shortens a list to fit, because a shortened list can turn a violation into a pass.

## Rules for every phase

The [architecture remediation rules](../architecture-remediation/README.md#rules-for-every-phase)
apply, with these differences:

1. **Behavior.** Each phase plan names the behavior it adds. Everything else stays as it is: a
   policy without bindings produces byte-identical findings, coverage, rule states, exit codes,
   and wire messages.
2. **Public API and schemas.** A phase may add the exports and schema properties that its plan
   names. It must not remove or rename an existing one.
3. **Frozen fixtures.** Do not modify `test/fixtures/cel-qualification.json`. The `bve-cel/1`
   corpus stays frozen. New qualification cases go in a new fixture.
4. **Dependencies.** Do not add, remove, or upgrade a dependency.

## Success criteria and exit criteria

Each phase plan has both. A success criterion states an outcome that the change must achieve,
and the implementer shows evidence for it. An exit criterion states a condition for closing the
phase and starting the next one.

### Exit criteria for every phase

1. Every success criterion of the phase is marked met, with its evidence, in the final report.
2. Every test case of the phase exists as an automated test and passes.
3. The verification gate passes, the test count is at least the count before the phase plus the
   new tests, and no test is skipped.
4. No existing test was deleted, skipped, or weakened. A changed assertion is named in the
   report with its reason.
5. The documents that the phase names are updated.
6. Every deviation from the plan, and every problem found but not fixed, is in the report.
7. An independent reviewer has read the change against the plan and has no open finding.

## Verification gate and report

The verification gate and the final report are the ones in the
[architecture remediation plan](../architecture-remediation/README.md#verification-gate). The
installed-editor suites run only in GitHub CI; say in the report which cases your change affects.

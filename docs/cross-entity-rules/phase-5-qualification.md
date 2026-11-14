# Phase 5: Qualification

Read [the plan overview](README.md) first. This plan follows Phases 1 to 4.

## Goal

Give policy authors a runnable example and accurate reference documents, and record the evidence
that the feature works in the packaged CLI and extension on every supported platform.

## Current state

- `examples/` holds runnable scripts such as `create-cli-release.mjs` and
  `validate-custom-kind.mjs`, with wire artifacts under `examples/contracts/`.
- `docs/README.md` lists every document in `docs/` once.
- GitHub CI runs the full harness, the packaged harness, and the installed-editor cases on
  Ubuntu, Windows, and macOS. The installed-editor suites do not run in a local agent session.
- `docs/plugin-capabilities-plan.md` describes value-producing CEL and external facts as future
  work.

## Target design

### Example

Add `examples/validate-zone-dependencies.mjs` and an npm script `example:zones`. The example
builds a signed release with the two rules of the
[motivating example](README.md#motivating-example), a profile with `bve-cel/2` and the
`/spec/dependsOn/*` reference context, and a source snapshot with a Component, its dependencies,
and their Systems as workspace entities. It needs no catalog connection.

- `npm run example:zones` exits with 0.
- `npm run example:zones -- --cross-zone 3` exits with 1 and prints the findings.

### Reference documents

Write one new reference document, `docs/cross-entity-rules.md`, for policy authors. It covers the
binding syntax, the two modes, the item shape, the bounds, the fail-closed results, the existence
prerequisite, and the editor opt-in. It states the operational consequence: a policy with binding
rules needs a reachable catalog in CI, and the CI credential must be able to read every
referenced entity.

Update the documents that the feature changes: `docs/contracts.md`, `docs/cel-runtime.md`,
`docs/lsp.md`, `docs/editor-features.md`, `docs/rule-editor-contributions.md`,
`docs/source-references.md`, and `docs/plugin-capabilities-plan.md`. Add the new document and
this plan directory to `docs/README.md`.

### Evidence

Record in `docs/implementation-status.md`, for the exact commit:

1. The verification gate result with test counts.
2. `npm run test:packaged` and `npm run cli:package` with a fresh installation that runs the
   example.
3. The GitHub CI run of the commit: full harness, packaged harness, and installed-editor jobs on
   the three platforms, with run identifiers.
4. Performance: the added request time for the two-hop example against a fake catalog with a
   fixed 50 ms response, and the completion latency of Phase 4 with a held catalog response.

State what was not run.

## Work order

1. Add the example and its npm script.
2. Write `docs/cross-entity-rules.md` and update the other documents.
3. Run the gate and the packaged checks.
4. Push and record the CI evidence.

## Success criteria

1. Both example commands produce the documented exit codes from the installed CLI package.
2. Every statement in `docs/cross-entity-rules.md` about a bound or a result matches a test.
3. `docs/README.md` lists every document once.
4. The recorded CI run passed on all three platforms, or the record names each failure and its
   cause.
5. `docs/plugin-capabilities-plan.md` no longer describes cross-entity facts in CEL as future
   work, and still describes value-producing CEL as future work.

## Test cases

- **Example.** A tooling test runs both example commands against the built package and asserts
  the exit codes and the finding count.
- **Documentation links.** The existing documentation checks pass for the new and changed files.
- **Packaged parity.** The cross-entity tests of Phases 1 to 3 run in the packaged harness.

## Exit criteria

The plan is complete when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. The evidence record names one commit, and the pull-request run and the push run of that
   commit both passed.
3. Every open point that an earlier phase reported is either closed or listed in
   `docs/cross-entity-rules.md` as a known limit.
4. The owner has accepted the evidence record.

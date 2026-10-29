# Native Backstage compatibility

Status: BC-01/BC-02 and declared BC-03 contexts implemented and locally tested,
2026-10-29. Source parsing is
implemented; this increment adds the exact native catalog-model adapters selected
by ADR 0002 in the planning repository.

| Case  | Required evidence                                                                                                                            | Status                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| BC-01 | Native envelope/kind parity for Component, API, Group, User, Resource, System, Domain and Location on 1.10.2 and 1.7.5                       | Passed locally                                        |
| BC-02 | Native namespace defaulting, field-format/root/schema policies and opt-in group-parent defaulting, preserving authored/normalized provenance | Passed locally                                        |
| BC-03 | Contextual native entity references and canonical identity                                                                                   | Passed locally for declared contexts                  |
| BC-04 | Safe local substitutions and Location targets, including missing/cyclic/traversal cases                                                      | Pending                                               |
| BC-05 | Kind/source admission and declared custom schemas                                                                                            | Pending                                               |
| BC-06 | Proposed catalog overlay, invalid replacements, deletions, renames and conflicts                                                             | Pending                                               |
| BC-07 | Required unavailable processors block dependent validation without speculative errors                                                        | Native-stage guard implemented; full pipeline pending |

Native schema/policy success covers declared stages only. It does not establish
complete deployment ingestion, organization policy, catalog persistence or hosted
authority. Missing required transformations must block checks that depend on them.

## Entry points and exact version selection

`loadBackstageAdapter(adapterId)` supports only
`@backstage/catalog-model@1.10.2` and `@backstage/catalog-model@1.7.5`. Dependencies
and the older npm alias are locked exactly. The loader checks the installed
package's version, imports only the selected public package, and caches its
adapter. Unknown IDs are configuration errors; an unavailable/mismatched package
does not fall back to another version. Backstage modules are not imported during
unrelated root-library initialization.

The [catalog HTTP harness](testing-harness.md) independently pins wire-contract
fixtures for Backstage umbrella releases 1.55.3 and 1.56.2. Their recorded backend
and model package versions are provenance, not additional native-validation adapter
support. Real deployed-backend smoke qualification remains open.

`adapter.checkEntity(json, execution)` runs the public native `entitySchemaValidator`
and the selected stock kind validator. The eight-kind fixture corpus compares
native acceptance with the wrapper on both pins, including empty specs, invalid
metadata and unsupported API versions. Public `KindValidator.check` returning
false is preserved as unrecognized support, while thrown validation failures are
invalid input. Extra kinds exported by newer native packages do not silently
expand the declared adapter surface.

`adapter.validate(json, profile.nativePolicies, execution)` runs the configured
native policy sequence and kind check. Both return a frozen record with authored
and normalized JSON, typed issues, native canonical identity when valid, and
normalization changes. Inputs are copied before any native policy mutates them.

## Native policy sequence

1. Always apply native `entityEnvelopeSchemaValidator` as a structural guard.
2. Apply configured `SchemaValidEntityPolicy` first.
3. Apply configured `DefaultNamespaceEntityPolicy` using its stock default.
4. Apply configured `FieldFormatEntityPolicy` with stock validators.
5. Apply configured `NoForeignRootFieldsEntityPolicy` with stock root fields.
6. Apply opt-in `GroupDefaultParentEntityPolicy` with the pinned parent reference.
7. Apply the native kind validator to the resulting entity.

`checkEntity` uses the complete native Entity schema instead of the policy
sequence. Kind schemas retain their native checks when a separate policy is
disabled; turning off the root-field policy, for example, cannot remove a stock
kind schema's own restrictions. The root-field policy is additionally stricter
than the Entity schema for machine-generated `relations`/`status` fields.

Group defaulting requires `nativePolicies.groupDefaultParentRef` whenever
`groupDefaultParent` is true. This optional field was added to the pre-release
0.2 profile schema, and its content participates in profile/activation digests.
Older producers with group defaulting disabled remain accepted. Consumers of the
new setting require the updated schema. Missing references and native references
whose kind is not Group are configuration errors, including on empty input.
Existing parents and the configured root group follow native behavior. A falsy
parent on a non-root group is defaulted before the kind check.

Each successful mutation records policy, JSON Pointer, before/after values, and
the originating authored location. Defaulted fields use their nearest source
ancestor while retaining the field's requested pointer. Arrays are recorded as
whole-value changes. Authored JSON, normalized JSON and source ranges remain
distinct; suggested edits are not emitted automatically.

## Parsing integration and incomplete work

`validateBackstageSources(request, { profile, policy, activation }, options)`
checks pinned bindings, parses the source snapshot with profile limits, and runs
the native adapter over valid parsed documents. It returns accepted entities,
normalization provenance/artifacts, findings, parse/native coverage and typed
interruption. This is a scoped compatibility report, not final enforcement or
GitHub approval.

Required processors are not available in the initial executable-processor
inventory. Their presence produces unsupported/blocked coverage before native
validation. Unresolved `$text`, `$json` or `$yaml` markers likewise block native
checks and record incomplete substitution coverage. Missing owners or other
fields that those transformations might supply are not reported speculatively.
This guard does not implement the substitutions themselves.

Native rejection after completed parsing produces blocking compatibility findings
in CI and advisory findings in IDE mode. Unrecognized kinds/API versions produce
unsupported coverage; kind/source admission and custom schemas remain BC-05 work.
Parser-rejected documents do not enter native validation. Their dependent native
checks are inapplicable, while parser findings still block CI. Parser resource
interruption blocks downstream native work. Invalid native entities never appear
in the accepted entity/artifact list.

Declared references are extracted after successful native checks, with canonical
targets separate from effective values and exact source provenance. See
[source references and preparation](source-references.md) for context bounds,
external observations and conservative fallback guards. Invalid references withhold
their subject; catalog absence is not an automatic native validation error.

Native errors are converted to fixed messages. A maintained prefix adapter
extracts only diagnostic paths from known public error formats; it does not
decide validity or expose raw native errors. Unknown formats fall back to a safe
ancestor/root location. Schema/policy updates must rerun both the native parity
and source-location/redaction tests.

## Budgets and tests

Native entry points share the original five-second request deadline and signal.
They yield between native operations and check cancellation/deadline before and
after calls and result construction. Input and normalized JSON are bounded.
Stock schema/policy calls are synchronous within their async wrappers; these are
cooperative limits, not CPU/RSS confinement or preemptive timeouts. Untrusted
programmable processors remain disabled.

The [native comparisons](../test/backstage-native.test.ts) and
[source integration checks](../test/backstage-sources.test.ts) add 130 checks to
the existing 138, for 268 local checks overall. They cover both pins, all eight
kinds, exact normalization, preserved authorship, source paths, optional policies,
group roots/defaults, unsupported transformations, cancellation and resource
limits. The historical 331-check comparison has not been claimed as a completed
production-engine regression run; its broader integrations remain future work.

```bash
npm run example:backstage
```

The example parses a catalog fixture, applies native policies/kind validation and
passes accepted normalized entities to managed CEL rules. Its output names the
limited scope. It does not attest catalog presence, substitution processing,
admission, catalog overlays or hosted authority. Earlier rules-only benchmark
captures predate these dependencies; full pipeline startup/latency requalification
remains an open pilot gate.

Next compatibility stages: BC-04 safe substitutions, BC-05 admission/custom kinds
and BC-06 qualified proposed-state overlays.

The production provider now uses `adapter.resolveReference` and
`adapter.entityReference` for pinned native parsing/stringification and envelope
identity checks. Both package pins and field-specific source contexts are tested.
[Explicit existence-rule bindings](lsp.md) are implemented alongside the thin LSP
transport. Qualified positive overlays remain separate BC-06 work.

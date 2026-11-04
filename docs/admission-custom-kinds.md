# Admission and custom kinds

BC-05 enforces the pinned deployment profile's kind/source allowances after native
normalization and before kind validation, reference extraction, catalog access and
organization rules. Both native catalog-model pins are supported. Schema
recognition and ingestion permission are separate checks.

## Global and source admission

`profile.admission.allowedKinds` grants global allowances. Each matching
`profile.admission.locations` entry adds its `allowedKinds`. An empty global list
denies every kind except those granted by matching source rules. An empty source
list adds no allowances and cannot revoke a global grant. This follows the
additive model in [Backstage catalog rules](https://backstage.io/docs/features/software-catalog/configuration/#catalog-rules).

```json
{
  "allowedKinds": ["Component", "API", "Location"],
  "locations": [
    { "sourcePrefix": "file:///workspace/org/", "allowedKinds": ["Group", "User"] },
    { "sourcePrefix": "file:///workspace/widget.yaml", "allowedKinds": ["Widget"] }
  ]
}
```

Kinds match without case sensitivity. The engine's explicit default profile
allows all eight supported stock kinds; it does not claim to mirror Backstage's
default deployment configuration. Profiles now enforce their existing admission
fields. Case-ambiguous duplicate allowances, duplicate prefixes and malformed
configuration are rejected.

Prefixes must be canonical file/HTTP(S) URIs without credentials, queries or
fragments. A trailing slash denotes a directory prefix; otherwise the rule matches
one exact URI. Sibling filenames/hosts, traversal spellings, encoded separators
and double-encoded escapes cannot obtain a grant. HTTP prefixes describe pinned
source names and do not enable network readers.

The admission source is the entity document's URI. Substituting a kind or whole
entity from an allowed payload directory does not move the entity into that
directory. Location-discovered entity documents use their own URIs. Rejected
Locations do not discover children. Entity annotations and editor initialization
options cannot select a more permissive profile or rule.

Disallowed kinds produce `backstage/admission/disallowed_kind`, verified admission
coverage and a CI violation (exit 1). They do not become accepted artifacts or
rule subjects. Allowed but undeclared kinds retain unsupported kind coverage
(exit 2). Required unavailable processors still block processing before admission,
preventing speculative rejection of data they might transform.

## Trusted schema artifacts

`profile.customKinds` declares exact API versions, kinds and immutable schema pins:

```json
{
  "apiVersion": "example.com/v1",
  "kind": "Widget",
  "schema": { "id": "example/widget", "version": "1", "digest": "sha256:..." }
}
```

Provide the body through the trusted context's optional `schemaArtifacts` array
to `validateBackstageSources`, `prepareBackstageReferenceData` or
`validatePolicySources`. Each `schema-artifact` has `contractVersion: "0.2"`, `id`,
`version`, `digest` and `schema`. The digest is `digestJson(schema)`, while ID and
version must also match the profile pin. `parseContract('schema-artifact', input)`
checks structural shape, JSON bounds and digest integrity, returning detached,
frozen data. Schema-language validation occurs when preparing the registry.

Missing artifacts produce `unsupported_custom_schema` dependency findings and
incomplete coverage for affected entities. Corrupt content, conflicting pins,
duplicate artifact identities, invalid schemas and unsupported schema features are
configuration/integrity errors. No source-provided schema is loaded implicitly.
Signatures and authoritative artifact assignment remain trusted-host work.

Native envelope and configured metadata policies run first, preserving defaults
and normalization provenance. The pinned schema then validates the complete
normalized entity. Custom kinds match kind names without case sensitivity and API
versions exactly; the schema can impose additional literal constraints. A schema
for one API version is never reused for another. Stock kind names cannot be
registered as custom kinds or have their validators replaced.

Accepted custom entities retain `customSchema` metadata and artifact provenance
with `custom-schema/<digest>`. Their declared references flow through the same
catalog policies as stock entities. Schema-invalid entities are withheld from
rules; invalid or denied local replacements retain identity claims and block
fallback to stale catalog entities. [BC-06 overlays](proposed-overlays.md) now
qualify positive local facts and baseline-relative identity removals.

## Declared schema surface

Custom validation uses the pinned Ajv dependency in synchronous draft-07 mode,
with no coercion, inserted defaults, removal of extra properties, custom keywords,
asynchronous validators, formats or network loaders. Defaults/examples/const/enum
payloads remain ordinary data rather than nested schema instructions.

An omitted `$schema` selects draft-07; explicit dialects must use
`http://json-schema.org/draft-07/schema#`. Bundle referenced schemas in
`definitions` and use fragment JSON Pointer `$ref`s. Missing, external and cyclic
references, nested `$id` scopes and newer recursive/dynamic constructs are rejected.
Root `$id` identifiers are labels and do not cause retrieval. Patterns and
`patternProperties` use the pinned RE2JS engine; unsupported regex features are
configuration errors. The custom format registry is currently empty. Native stock
schema/policy validation retains its own versioned behavior.

Ceilings are 64 artifacts, 64 KiB per schema, 256 KiB for the supplied artifact
array, schema JSON depth 32/8,192 values, 1,024 schema nodes, 256 local references,
combined schema/reference depth 32, 8,192 expanded schema visits (counting repeated
references) and 1,024 pattern characters. The compiled
validator cache is bounded to 64 content digests. Source/entity limits still apply.
Compilation/validation observe the original request deadline before and after
synchronous work; these are cooperative bounds, without preemptive CPU/RSS
confinement. Only centrally approved, pinned schema bodies belong in the host
configuration. Ajv documents its [schema security considerations](https://ajv.js.org/security.html).

The standalone adapter also exposes `normalizeEntity` and `validateKind` to compose
native stages without replacing stock validators. Its existing `validate` and
`checkEntity` APIs retain their stock behavior.

## LSP and examples

Trusted LSP launcher configuration accepts optional `schemaArtifacts` with the
same contracts and pins. Startup rejects invalid bodies/configuration. Open
buffers cannot change these artifacts. Admission/schema findings are versioned
errors, missing artifacts are dependency warnings, and repairs clear findings
before catalog rules run. Included fields retain payload ranges and their use
chain. Saved-file refresh and actual editor/backend qualification remain open.

```bash
npm run example:custom
# An invalid tier demonstrates a schema violation and exits with code 1:
npm run example:custom -- --invalid
```

The [wire artifact](../examples/contracts/schema-artifact.json) and
[runnable example](../examples/validate-custom-kind.mjs) use synthetic development
authority. [BC-05 tests](../test/backstage-admission.test.ts) and
[stdio tests](../test/lsp.test.ts) exercise admission, pins, native normalization,
custom schemas, source attribution, unsupported dependencies, catalog guards and
both model/API pins. Schema-defined Template-shaped data does not implement
scaffolder execution or arbitrary deployment processors. Organization schema
rules, policy inheritance and full deployment ingestion retain separate gates.

Local qualification on 2026-10-30: 60 admission/custom-schema checks and seven
added LSP checks passed, using loopback access for the pinned fake APIs. The full
`npm run check` passed all 552 tests and required static/schema/build checks.
The built example returned allow/exit 0 for valid input and a completed blocking
schema violation/exit 1 for an invalid tier.

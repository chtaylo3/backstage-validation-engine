# Production contracts 0.2

`src/contracts/schemas.ts` defines TypeBox schemas and their inferred TypeScript types. `schemas/`
contains generated draft-07 resources identified by versioned URNs. Register all resources with a
validator so cross-resource `$ref` references resolve. No remote schema retrieval is required.

`parseContract(name, unknown)` first enforces the JSON input profile, then runs strict structural
validation and applicable semantic checks. It returns a detached, deeply frozen value typed as
`Immutable<T>`. Unknown object properties are rejected. Optional fields are omitted rather than
populated with `undefined`. The generated schemas describe structure. Use production semantic
validation for digest integrity, temporal relationships, graph consistency, and outcome rules.

## Resources

| Resource              | Purpose                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation-request`  | Run/attempt/generation, execution mode/deadline, trusted identity reference, source/data snapshots, and pinned policy/profile/activation references  |
| `validation-result`   | Provenance, outcome/enforcement, findings, coverage, normalized artifacts, rule states, optional bypass receipt, and resource/freshness summary      |
| `deployment-profile`  | Exact adapter/CEL profile, native policies, admission, reference contexts, custom schema identities, declared readers/processors, and bounded limits |
| `coverage`            | Per-stage/subject requiredness, status, and optional explanation                                                                                     |
| `source-snapshot`     | Effective proposed source files, source revision, file/content digests, buffer versions, and change/deletion records                                 |
| `data-snapshot`       | Pinned provider observations with availability and authorization/freshness provenance                                                                |
| `policy-release`      | Signed bounded bundle closure, profile, schemas, activation and validity                                                                             |
| `policy-trust`        | Host-installed keys, identity, exact generation, mandatory baseline pins and maximum release age                                                     |
| `policy-bundle`       | Immutable declarative rules, mandatory flags, inherited bundle digests, schema/plugin references                                                     |
| `activation-manifest` | Installation/repository assignment, policy/profile/bypass digests, generation, activation time, and verification evidence reference                  |
| `json-value`          | Recursive JSON payload shared by provider data and normalized artifacts                                                                              |
| `schema-artifact`     | Trusted schema body with an ID/version and canonical schema-content digest                                                                           |

Timestamps are integer milliseconds since the Unix epoch. URIs are absolute URI strings. Positions
and ranges use zero-based UTF-16 coordinates. A range excludes its end position.

The contract checks coordinate order. The parser derives positions directly from authored text.
Adapters must enforce source digest/buffer version when applying edits. Findings use JSON Pointer
paths.

## Native policy configuration

The pre-release deployment profile now permits `nativePolicies.groupDefaultParentRef`. It is
required when the native group-parent policy is enabled and is included in the profile digest. Its
Group reference is checked using the selected native adapter. Disabled profiles do not need this
field. Regenerated profile schemas and consumers must accompany use of the new setting.

## Content addressing and immutability

BC-05 enforces the profile's existing admission/custom-kind pins and adds the pre-release
`schema-artifact` contract. Admission lists are bounded to 256 kinds/ source rules and custom
declarations to 64 pairs. Case-ambiguous duplicate kinds, noncanonical source prefixes, conflicting
schema pins and stock-kind overrides are rejected. Bodies arrive through optional trusted
`schemaArtifacts` context/ launcher fields, rather than entity documents or network retrieval. See
[admission and custom schemas](admission-custom-kinds.md) for supported draft-07 features,
compilation bounds and missing-versus-invalid behavior.

BC-06 adds optional `validation-request.baseline` (a source snapshot) and result
`provenance.baselineDigest`. Baselines must have no change records and share the proposed
repository/root. Baseline-relative source differences require coherent change records.
Baseline/proposed raw bytes share the assigned request budget. Updated producers/consumers must
include the new generated schemas when using these pre-release 0.2 fields. See
[overlay provenance](proposed-overlays.md).

A digest is a content fingerprint. Digests use `sha256:` plus 64 lowercase hexadecimal characters.
File digests hash the exact UTF-8 text. Snapshot digests hash all snapshot fields except the
snapshot `digest` field using project canonical JSON.

The canonicalizer sorts object keys by UTF-16 code units and serializes JSON scalars with ECMAScript
rules. It does not implement RFC 8785. Array order matters. Snapshot factories sort files and
changes by URI and provider entries by key.

Canonicalization rejects non-finite numbers, unsafe integral numbers, cycles, undefined, bigint,
non-JSON objects, sparse arrays, symbol/hidden properties, accessors, and callbacks. Its independent
admission budgets are depth 64, 100,000 values, and 32 MiB serialized UTF-8. Only plain in-process
JSON data is supported. Hostile JavaScript proxies require isolation in another process.

Source factories enforce a one-MiB per-file and 16-MiB aggregate raw UTF-8 ceiling. Buffer input
requires a document version. Changes must agree with effective files: additions/modifications exist
and deletions do not. Overlays preserve the base snapshot, reject competing URI claims, retain
deletion tombstones, and track new-file removal without fabricating a deletion of a repository file.
Readers that capture disk content must enforce their traversal/symlink boundaries.

Pre-release contract 0.2 now permits optional `rootUri` and `entrypoints` in source snapshots. A
root pins canonical contained local file URIs. Entrypoints must exist. They select catalog inputs
separately from payload files.

Without entrypoints, the parser processes all files. Both fields are hashed and retained by
overlays. Updated schemas and consumers are required when using them. See
[local resolution](substitutions.md).

`verifyRequestBindings` checks content digests, IDs, revisions, activation scope/ generation, and
the assigned profile's lower budgets. Hash integrity proves content consistency. It does not
establish who is authorized to supply that content. `verifyPolicyRelease` now verifies signatures
and resolves mandatory inheritance using separately installed host trust.

Authoritative assignment and trust/generation refresh remain host responsibilities. External
prerequisite references in inherited bundles are checked after resolution. `orderRules` checks the
complete resolved DAG with deterministic ordering and bounded depth.

## Availability and provenance

Provider observations have distinct `present`, `missing`, and `unavailable` variants. Only `present`
carries a value. That value can be null. Unavailable observations retain a typed reason. They cannot
represent missing data. Provenance includes provider/connection, installation, principal, permission
revision, scope, data revision, fetch time, and expiry.

Requests reject stale/future observations, installation mismatches, and permission revision
mismatches. Trusted host adapters must verify authorization for the principal and scope. The
contract parser checks consistency. It does not authenticate callers. The
[catalog provider](catalog-provider.md) implements bounded HTTP, credential bindings, scoped caches,
retries and rate limits. Data is pinned before evaluation using the original operation deadline.

## Decisions and enforcement

| Evidence                                                                                               | Outcome      | CI enforcement / exit |
| ------------------------------------------------------------------------------------------------------ | ------------ | --------------------- |
| Mandatory declared work verified with no blocking violations                                           | `completed`  | `allow` / 0           |
| Rule false or completed blocking findings                                                              | `completed`  | `block` / 1           |
| Invalid policy or execution error                                                                      | `error`      | `block` / 2           |
| Required unavailable/unsupported/blocked/skipped work, timeout, cancellation, or resource interruption | `incomplete` | `block` / 2           |
| Early repository emergency bypass with trusted receipt and bypassed coverage                           | `bypassed`   | `allow` / 0           |

An empty coverage list, or coverage containing no required work, is incomplete. Optional unsupported
work can coexist with a completed outcome. IDE results retain the same outcome but use advisory
enforcement. `resultExitCode` returns 2 for errors/incomplete execution even in IDE mode.

`createValidationResult` aggregates declared evidence. It does not run checks or prove that the
caller supplied every stage required by a deployment profile. The future engine must construct
complete coverage. If execution crosses the request deadline, the result records a timeout. Semantic
validation rejects contradictory success and enforcement states or inconsistent resource timestamps.

An emergency receipt must match installation/repository, be valid through completion, and include
authority evidence. Whole-run bypass rejects entity-scoped receipts and evidence of executed
rules/artifacts/findings. A JSON receipt is not cryptographic proof. Only trusted verifiers can
supply receipts.

Routine exception application is not implemented and cannot currently waive a failed mandatory rule.
Before publication, the controller must recheck the active generation, authority, and expiry. A
completed local result is not a merge approval.

Publication metadata is capped at authority-check time plus 60 seconds, provider expiry, and bypass
expiry. It records the available window and does not perform GitHub reconciliation. Stable finding
IDs include contract/rule/version, subject, path, and policy/profile digests. Message text, movable
coordinates, and document versions do not affect those IDs. Suggested edits carry source digest and
optional document version preconditions.

See [wire examples](../examples/contracts/README.md) for all required result cases.

Catalog-existence policies use the additional pre-release 0.2 `catalog` rule kind with
`check: "exists"` and a declared `referencePath`. See [catalog rules](lsp.md) for pinning,
applicability, missing versus unavailable semantics and compatibility.

## Signed policy loading

`policy-release` and `policy-trust` are new contract-0.2 resources. Structural parsing does not
establish authority. `verifyPolicyRelease` verifies Ed25519 signatures against separately installed
host trust, bounded inheritance, mandatory baseline presence, complete schema pins and activation
scope/generation. Execution pins the resolved bundle digest.

`createVerifiedPolicyResult` binds reports to that context and limits freshness to the release
validity window. Expiry adds incomplete required coverage. See
[policy and CLI semantics](policy-cli.md).

## Independent boundary and signature evidence

The [H3 controls](../test/engine/default-boundaries.test.ts) admit equality at each exercised count or byte ceiling.
They reject the first excess unit. UTF-8 bytes and UTF-16 character counts remain distinct.
Canonical JSON admits 32 MiB serialized UTF-8, 100,000 values, and depth 64.
The root is depth zero. Quotation marks count toward serialized string bytes.
The [independent vectors](../test/fixtures/conformance/README.md) retain supplementary-key ordering and fixed ECMAScript numeric strings.
Unsafe integral numbers remain excluded even when RFC 8785 lists their serialization.
The tests do not claim full RFC 8785 conformance.

Release verification admits a canonical signed package of exactly two MiB and rejects one extra byte.
The bundle inventory permits 64 members and an inheritance depth of 16 members.
Host trust permits a maximum age of 604,800,000 milliseconds, which is seven days.
Release validity ends at the earlier expiry or trusted maximum age. That end instant is exclusive.
The last preceding millisecond remains valid when all other authority conditions hold.
A larger host maximum age fails contract admission.
Independent `node:crypto` controls verify the RFC 8032 signature and separately constructed release signing bytes.
Tampering tests assert the specific structural or integrity rejection that occurs first.

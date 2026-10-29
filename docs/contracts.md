# Production contracts 0.2

`src/contracts/schemas.ts` defines TypeBox schemas and their inferred TypeScript
types. `schemas/` contains generated draft-07 resources identified by versioned
URNs. Register all resources with a validator so cross-resource `$ref` references
resolve. No remote schema retrieval is required.

`parseContract(name, unknown)` first enforces the JSON input profile, then runs
strict structural validation and applicable semantic checks. It returns a
detached, deeply frozen value typed as `Immutable<T>`. Unknown object properties
are rejected. Optional fields are omitted rather than populated with `undefined`.
The generated schemas describe structure; use production semantic validation for
digest integrity, temporal relationships, graph consistency, and outcome rules.

## Resources

| Resource              | Purpose                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation-request`  | Run/attempt/generation, execution mode/deadline, trusted identity reference, source/data snapshots, and pinned policy/profile/activation references  |
| `validation-result`   | Provenance, outcome/enforcement, findings, coverage, normalized artifacts, rule states, optional bypass receipt, and resource/freshness summary      |
| `deployment-profile`  | Exact adapter/CEL profile, native policies, admission, reference contexts, custom schema identities, declared readers/processors, and bounded limits |
| `coverage`            | Per-stage/subject requiredness, status, and optional explanation                                                                                     |
| `source-snapshot`     | Effective proposed source files, source revision, file/content digests, buffer versions, and change/deletion records                                 |
| `data-snapshot`       | Pinned provider observations with availability and authorization/freshness provenance                                                                |
| `policy-bundle`       | Immutable declarative rules, mandatory flags, inherited bundle digests, schema/plugin references                                                     |
| `activation-manifest` | Installation/repository assignment, policy/profile/bypass digests, generation, activation time, and verification evidence reference                  |
| `json-value`          | Recursive JSON payload shared by provider data and normalized artifacts                                                                              |

Timestamps are integer Unix epoch **milliseconds**. URIs are absolute URI strings.
Positions and ranges are zero-based UTF-16 coordinates; range ends are exclusive.
The contract checks coordinate ordering; the parser derives positions directly
from authored text. Adapters must enforce source digest/buffer version when
applying edits. Findings use JSON Pointer paths.

## Native policy configuration

The pre-release deployment profile now permits `nativePolicies.groupDefaultParentRef`.
It is required when the native group-parent policy is enabled and is included in
the profile digest. Its Group reference is checked using the selected native
adapter. Disabled profiles do not need this field. Regenerated profile schemas
and consumers must accompany use of the new setting.

## Content addressing and immutability

Digests use `sha256:` plus 64 lowercase hexadecimal characters. File digests hash
the exact UTF-8 text. Snapshot digests hash all snapshot fields except the snapshot
`digest` field using project canonical JSON. The canonicalizer sorts object keys
by UTF-16 code units and uses ECMAScript JSON scalar serialization; it is not an
RFC 8785 implementation. Array order is significant. Snapshot factories sort
files/changes by URI and provider entries by key.

Canonicalization rejects non-finite numbers, unsafe integral numbers, cycles,
undefined, bigint, non-JSON objects, sparse arrays, symbol/hidden properties,
accessors, and callbacks. Its independent admission budgets are depth 64,
100,000 values, and 32 MiB serialized UTF-8. Only plain in-process JSON data is
supported; hostile JavaScript proxies require a process isolation boundary.

Source factories enforce a one-MiB per-file and 16-MiB aggregate raw UTF-8 ceiling.
Buffer input requires a document version. Changes must agree with effective
files: additions/modifications exist and deletions do not. Overlays preserve the
base snapshot, reject competing URI claims, retain deletion tombstones, and track
new-file removal without fabricating a deletion of a repository file. Readers
must later enforce traversal/symlink boundaries against these snapshots.

`verifyRequestBindings` checks content digests, IDs, revisions, activation scope/
generation, and the assigned profile's lower budgets. Hash integrity proves
content consistency. It does not establish who is authorized to supply that
content. Signature verification, authoritative assignment, inheritance resolution,
and mandatory baseline merging remain policy-resolver work. External prerequisite
references in inherited bundles are checked after resolution; `orderRules` checks
the complete resolved DAG with deterministic ordering and bounded depth.

## Availability and provenance

Provider observations have distinct `present`, `missing`, and `unavailable`
variants. Only `present` carries a value, which may itself be null. Unavailable
observations retain a typed reason; they cannot masquerade as missing. Provenance
includes provider/connection, installation, principal, permission revision,
scope, data revision, fetch time, and expiry.

Requests reject stale/future observations, installation mismatches, and permission
revision mismatches. Trusted host adapters must verify principal/scope authorization;
the contract parser checks consistency rather than authenticating callers.
The [catalog provider](catalog-provider.md) implements bounded HTTP, credential
bindings, scoped caches, retries and rate limits. Data is pinned before evaluation
using the original operation deadline.

## Decisions and enforcement

| Evidence                                                                                               | Outcome      | CI enforcement / exit |
| ------------------------------------------------------------------------------------------------------ | ------------ | --------------------- |
| Mandatory declared work verified with no blocking violations                                           | `completed`  | `allow` / 0           |
| Rule false or completed blocking findings                                                              | `completed`  | `block` / 1           |
| Invalid policy or execution error                                                                      | `error`      | `block` / 2           |
| Required unavailable/unsupported/blocked/skipped work, timeout, cancellation, or resource interruption | `incomplete` | `block` / 2           |
| Early repository emergency bypass with trusted receipt and bypassed coverage                           | `bypassed`   | `allow` / 0           |

An empty coverage list, or coverage containing no required work, is incomplete.
Optional unsupported work can coexist with a completed outcome. IDE results retain
the same outcome but use advisory enforcement. `resultExitCode` returns 2 for
errors/incomplete execution even in IDE mode.

`createValidationResult` aggregates declared evidence; it neither performs checks
nor proves that the caller supplied every stage required by a deployment profile.
The future engine must construct complete coverage. Crossing the request deadline
automatically records a timeout. Semantic validation rejects contradictory
success/enforcement and resource timestamps.

An emergency receipt must match installation/repository, be valid through
completion, and include authority evidence. Whole-run bypass rejects entity-scoped
receipts and evidence of executed rules/artifacts/findings. A JSON receipt is not
cryptographic proof: only trusted verifiers may supply receipts. Routine exception
application is not implemented and cannot currently waive a failed mandatory
rule. The controller must recheck active generation, authority, and expiry before
publication; a completed local result is not a merge approval.

Publication metadata is capped at authority-check time plus 60 seconds, provider
expiry, and bypass expiry. It records the available window and does not perform
GitHub reconciliation. Stable finding IDs include contract/rule/version, subject,
path, and policy/profile digests. Message text, movable coordinates, and document
versions do not affect those IDs. Suggested edits carry source digest and optional
document version preconditions.

See [wire examples](../examples/contracts/README.md) for all required result cases.

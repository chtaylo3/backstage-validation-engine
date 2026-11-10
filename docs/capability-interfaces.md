# Built-in capability interfaces

Phase 2 implements versioned interfaces for the existing built-in providers.
A capability is one function that an approved provider supplies.
The host selects implementations and admits their requests and responses.
Authored documents cannot load modules or select credentials, endpoints, or execution profiles.

The package exports the interfaces through `@chtaylo3/backstage-validation-engine/capabilities`.
The capability API is `bve-plugin/1`. Its JSON Schema resources use version 1 identifiers.
The validation request and result contracts remain version 0.2.
The [capability design](plugin-capabilities-plan.md) retains requirements for later rule contributions and executable providers.
The [five-phase plan](lsp-editor-improvements-plan.md) defines implementation and acceptance order.

## Contracts and host approval

`CapabilityManifest` declares provider identity, version, artifact digest, execution profile, dependencies, language profiles, permissions, and individual capability versions.
Each capability declaration pins its input and output schema digests and its prepared or asynchronous mode.
The host supplies a separate `CapabilityApproval` with the exact approved manifest digest and permitted identities, dependencies, profiles, and permissions.
A matching declaration cannot enlarge that approval.

`CapabilitySession` admits the manifest and negotiates the handshake with the provider.
Unknown optional functions or versions remain disabled. Unsupported required functions or versions reject admission.
The provider cannot add functions through its handshake or omit a required evaluator.
Only `builtin/1` and `declarative/1` profiles have records in this version.
The prepared invocation path accepts only `builtin/1` implementations.
These profiles do not claim process isolation for untrusted code.

`builtinCapabilitySession` constructs a provider from functions that the trusted programmatic host supplies.
Its artifact digest identifies the immutable built-in registration descriptor. Its manifest digest also binds schema pins, permissions, profiles, and modes.
The host application and packaged binary remain the authority for the compiled functions.
The registration digest is not a signature or independent binary attestation.
No manifest field selects a module, executable, filesystem path, or network endpoint.

Generated schemas cover manifests, bindings, both handshakes, and each function's input, output, request, and response.
`npm run schemas:generate` writes the resources. `npm run schemas:check` detects stale resources.
Admission rejects non-JSON objects, accessors, extra fields, malformed records, oversized payloads, and unsupported operations.
Structural validation uses the generated schemas. Semantic admission also checks bindings, paths, scopes, and existing validation contracts.

## Shared request and result identity

`BoundRequest<K>` carries the invocation ID, host request ID, capability ID/version, original deadline, context binding, and typed function input.
`ContextBinding` identifies source, baseline, policy, profile, activation, data, dependencies, and authority through digests.
Activation, workspace, session, and remote dependency generations have separate fields.
A remote dependency generation can change without changing a source document version or policy activation.

`capabilityBinding` constructs these records from a pinned validation request and host generation state.
`capabilityAuthorityDigest` additionally binds the actual approved catalog connection, adapter, principal, permission revision, credential revision, and scope.
The digest contains no token. A digest does not itself establish authority.
The host must supply current approved context and reject obsolete results through its freshness predicate.

`CapabilityResult<K>` is either `ready` with typed output and completeness, or a typed unavailable, cancelled, limited, error, or inapplicable result.
Every response repeats the invocation ID, capability ID, and context binding.
Late responses, duplicate responses from older invocations, and changed bindings cannot enter current results.
The host also rejects changes to the original input binding while asynchronous work runs.

`ready` means that the provider returned an admitted function result. It does not establish complete policy compliance.
The host owns validation coverage, source mapping, current authority, freshness, and verified execution evidence.
Optional editor failure produces no contribution. It cannot remove mandatory findings or turn incomplete required validation into success.

## Function inventory

| Interface                  | Input                                                                                                                     | Output and host boundary                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ValidationProvider`       | Pinned validation request                                                                                                 | Materialized data, evaluation start/data digest, findings, coverage, rule states, artifacts, and interruption. The host retains the original source and deadline.                                          |
| `FieldMetadataProvider`    | Exact kind/API scope or explicit unknown scope, subject stage/value, pointer, approved schemas, prefix, and existing keys | Logical field names and paths, requiredness, types, placeholders, descriptions, typed constraints, and provenance. The host renders YAML/JSON keys and values.                                             |
| `ValueSuggestionProvider`  | The same schema and subject context at a target path                                                                      | Finite typed candidates with provenance and required, allowed, default, example, or suggestion labels. Host constraints and history still filter and rank results.                                         |
| `HoverProvider`            | Schema and subject context at a target path                                                                               | Bounded plain text. The host supplies the protocol range and plain-text markup declaration.                                                                                                                |
| `ReferenceProvider`        | Authored reference value/path and approved default kind/namespace                                                         | Canonical target identities. The host resolves qualified local targets and rejects ambiguous locations.                                                                                                    |
| `RepairProvider`           | Finding/subject identity, target path, current value presence, and applicable schema context                              | Logical `setValue` or `insertProperty` proposals. The host owns rendering, exact ranges, edit guards, and dispatch.                                                                                        |
| `SearchProvider`           | Typed kind, namespace, and prefix query                                                                                   | Bounded canonical references, fetch/expiry times, truncation, or unavailable state. The host retains approved connections, overlay masks, caches, and ranking.                                             |
| `SourceDiscoveryProvider`  | Host-approved roots and include/exclude patterns                                                                          | Bounded source identities and completeness. The host scanner and subsequent reader retain containment, regular-file, mutation, and byte checks.                                                            |
| `DependencyChangeProvider` | Approved scopes and optional cursor                                                                                       | Bounded invalidation hints, next cursor, reset state, and observation time. The interface defines optional hints. Host polling now supplies the live-refresh baseline without claiming a Backstage stream. |

Field constraints retain source labels, artifact digests, and rule IDs where available.
They expose known types, constants, enumerations, defaults, examples, lengths, ranges, patterns, required fields, and forbidden state.
The `partial` flag identifies constraints that the descriptor cannot represent fully.
Descriptors retain authored, resolved, or normalized subject stages and exact kind/API scopes.
Unknown scope remains explicit during unfinished edits.

Presence records distinguish absent values from explicit JSON null.
The host removes unfinished object properties from the recovery projection instead of converting them into null values.
Recovery metadata never becomes a validation subject.
The current schema adapter preserves its existing conservative conditional and reference handling.
It does not claim to solve every JSON Schema composition.

## Existing validation and editor integration

`BuiltinValidationService` runs `validatePolicySources`, the existing authoritative pipeline.
Its capability output carries the newly materialized data and evaluation start, rather than duplicating all source files in a response.
Admission reconstructs and checks the evaluated request against the original source and deadline.
The evaluation start can advance after authorized data collection. The original deadline cannot advance.
If admission finds that source capture already exhausted the deadline, the host retains versioned timeout diagnostics without dispatching provider work.
The host compares the admitted projection with its actual core report before publication.
Provider output alone cannot create verified execution evidence.

`EditorService` consumes built-in field, value, hover, reference, and repair contributions.
It retains source positions, quoting, indentation, local target resolution, and supported single-document edit operations.
`CompletionService` routes remote catalog completion and search through `SearchProvider`.
Its approved catalog provider still owns HTTP, credentials, and authority scope.
Filesystem discovery invokes the source interface under the capture's original budget and source binding.
Subsequent file reads retain all existing containment and mutation checks.

No mandatory launcher option is added for these built-ins.
The CLI retains the same core evaluation path and validation semantics.
The AST import gate treats capability code as domain code and rejects imports from LSP, CLI, client, or host modules.

## Budgets, cancellation, and disposal

Metadata admission allows at most 2 MiB per record and 100,000 JSON values.
Validation admission retains the existing 32 MiB canonical JSON ceiling.
The host admits at most 64 outstanding asynchronous invocations per session.
Field and value outputs contain at most 100 items. Repair output contains at most 16 proposals per finding request.
Discovery contains at most 1,000 identities. Existing catalog, source, and CEL limits still apply.

Every invocation uses its original deadline and cancellation signal through `RequestBudget`.
The host rejects calls until asynchronous initialization completes through `whenReady()`.
Calls cannot wait outside admission while initialization remains pending.
Cancellation drains owned work and the complete invocation finalizer before reuse. Failed cancellation cleanup makes that provider generation unavailable.
An asynchronous return from a prepared provider is a protocol error. The host cancels and retains that work until retirement.

`close()` rejects new calls immediately, cancels active work, attempts provider disposal, and waits within its configured cleanup bound.
The maximum cleanup bound is five seconds. Hosts can lower it.
Close includes cancellation acknowledgements that begin after close starts. Final provider disposal follows those acknowledgements.
An uncooperative invocation makes close fail. It cannot survive a successful close through untracked ownership.
An initialization that acquires a resource after a failed bounded close still receives disposal.
Disposal is idempotent. Failed cleanup does not restore the provider generation.

## Live dependencies and remaining qualification

Phase 3 implements host-owned polling and remote-only revalidation through `CatalogRefresh`.
The session passes its dependency generation into validation, editor metadata, and catalog search bindings.
Polling invalidates the coordinator and all old editor, query, and repair evidence before collection.
Validation keeps its activation generation. Remote refresh never changes document versions or authored contents.
A fresh lookup uses the original approved access context with cache reuse disabled for that read.
It does not change the authority digest or renew an invocation deadline.

The next request observes its own immutable snapshot. Existing invocations never receive a mutated data snapshot.
The full catalog provider revision covers entity bodies. Query projections remain identity-only advisory records.
Background query reports enter the search capability admission path before any client receives their values.
CLI providers retain single-run behavior and create no refresh timers.
A change provider must declare mechanism, coverage, cursor, ordering, replay, heartbeat, and gap handling before negotiation.
Its hints cannot supply authoritative entity bodies or replace authorized fresh reads.
SQS, Kafka, and hosted governance remain outside the editor phases.

Phase 4 adds CEL/RE2 editor metadata, candidate evidence, and guarded repair contributions through these interfaces.
CEL and RE2 execution remains unchanged in this phase.
Arbitrary executable loading, process transport, permission brokers, and untrusted-code isolation require separate implementation and approval.
Phase 5 remains deferred for native Trust automation, installed JetBrains qualification, and longer release workloads.

The [implementation record](lsp-editor-improvements-implementation-record.md) records executed phase checks and parent acceptance.
Interface existence alone does not establish conformance or release qualification.

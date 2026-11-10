# Rule and editor capability plan

Status: phase 2 implements versioned interfaces and host admission for the existing built-in providers.
The [implemented interface guide](capability-interfaces.md) defines the current records, boundaries, and limitations.
Phase 3 implements bounded host polling for live refresh. Phase 4 implements [declarative CEL/RE2 editor contributions](rule-editor-contributions.md).
External executable plugin loading remains separate work.
The current wire contract remains version 0.2. A capability is a function that the host permits a provider to supply.
This plan covers rule execution and the editor functions that rules can support.
The [five-phase editor plan](lsp-editor-improvements-plan.md) is the authoritative implementation order and defines phase acceptance criteria.
This document supplies capability behavior and conformance requirements. The phase 1 checkpoint recorded these interfaces as unimplemented.

## Current implementation and required direction

CEL validation already runs through the managed `bve-cel/1` runtime.
RE2 already handles CEL `matches` operations and supported schema patterns.
The current rule union contains `cel`, `schema`, and `catalog`. It has no standalone `re2` or executable-plugin rule kind.
The editor currently derives field and value hints from trusted schemas and uses the existing catalog provider for references.
Built-in negotiation and lifecycle admission now use `bve-plugin/1`.
Approved CEL and schema RE2 declarations now supply finite checked candidates and guarded repairs.
Standalone RE2 rule adapters and arbitrary executable loading remain future work.

Future CEL, RE2, schema, catalog, and approved executable providers must use one set of host contracts.
CLI, editors, and hosted execution must share validation semantics.
Providers implement only their declared functions. A validator does not automatically supply completion, navigation, or repairs.
Declarative metadata can satisfy an interface through a qualified host adapter. Every provider does not need executable callbacks.

## Registration and capability negotiation

The host must resolve an approved artifact before loading its manifest, the description of its interfaces and requirements.
A content digest identifies the exact artifact bytes. Repository content cannot select module paths, commands, credentials, or isolation profiles.
The host must independently approve identity, artifact digest, API versions, dependencies, input/output schemas, and execution permissions.
Self-declared capabilities do not grant authority.

The proposed manifest must contain the following information:

| Manifest field                          | Required meaning                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| Plugin ID, version, and artifact digest | Stable identity and exact approved implementation or declarative artifact                    |
| Plugin API version                      | Negotiated lifecycle and transport contract, proposed as `bve-plugin/1`                      |
| Capability IDs and versions             | Each supported function, its major version, and its declarative or executable implementation |
| Input/output schema pins                | Immutable JSON Schemas for each capability request and response                              |
| Rule and language profiles              | Exact CEL, RE2, schema, native-adapter, and host contract requirements                       |
| Subject stage and paths                 | Authored, resolved, or normalized input and bounded JSON Pointer patterns                    |
| Dependencies and artifacts              | Required transformations, providers, rules, and typed artifact schemas                       |
| Permission requirements                 | Requested data access through approved host services                                         |
| Execution requirements                  | Centrally approved trust/isolation profile and requested resource limits                     |
| Determinism and caching                 | Declared external dependencies, freshness requirements, and reproducibility limits           |

The host must negotiate each capability separately and reject incompatible required versions.
Missing optional editor functions produce no result for that function. They do not imply that validation failed or passed.
Missing required evaluators or dependencies retain unsupported, unavailable, or blocked coverage and CI exit 2.
Manifest inspection and initialization require the same trust and resource controls as later execution.

## Shared request, response, and lifecycle interfaces

Every invocation must bind its result to the exact execution context.
The host must supply immutable input projections and retain source locations and processing history.
Raw source, network access, filesystem access, and credentials are not implicit provider inputs.

The following sketch retains the original design baseline. The implemented [version 1 records](capability-interfaces.md) use independently versioned schemas and semantic admission.
Their activation, workspace, session, and dependency generations remain distinct. Named function records preserve the requirements in the table below.

```ts
type CapabilityId =
  | 'validation'
  | 'fields'
  | 'values'
  | 'hover'
  | 'references'
  | 'repairs'
  | 'search'
  | 'dependency-changes'
  | 'source-discovery';

interface ContextBinding {
  readonly contextId: string;
  readonly sourceDigest: string;
  readonly baselineDigest?: string;
  readonly policyDigest: string;
  readonly profileDigest: string;
  readonly activationDigest: string;
  readonly dataDigest: string;
  readonly dependencyDigest: string;
  readonly authorityContextDigest: string;
  readonly generation: number;
  readonly dependencyGeneration: number;
}

interface BoundRequest<T> {
  readonly invocationId: string;
  readonly requestId: string;
  readonly capabilityVersion: number;
  readonly binding: ContextBinding;
  readonly deadlineAt: number;
  readonly input: T;
}

type CapabilityResult<T> =
  | {
      readonly status: 'ready';
      readonly invocationId: string;
      readonly binding: ContextBinding;
      readonly completeness: 'complete' | 'partial';
      readonly value: T;
    }
  | {
      readonly status: 'not_applicable' | 'unavailable' | 'cancelled' | 'resource_limit' | 'error';
      readonly invocationId: string;
      readonly binding: ContextBinding;
      readonly reasonCode: string;
    };

interface CapabilityProvider<Input, Output> {
  provide(request: BoundRequest<Input>): Promise<CapabilityResult<Output>>;
}

interface PluginLifecycle {
  initialize(request: HostHandshake): Promise<PluginHandshake>;
  cancel(invocationId: string): Promise<void>;
  dispose(): Promise<void>;
}
```

`HostHandshake` lists supported contract versions, approved capabilities, execution profiles, budgets, and opaque service handles.
`PluginHandshake` selects compatible versions and confirms the exact loaded artifact. It cannot enlarge host permissions.
The authority context digest binds installation, principal, permission and credential revisions, connection scope, and trusted assignments.
It is not a credential or proof of authority supplied by the plugin.

Local adapters must map `AbortSignal` cancellation into this lifecycle.
Process adapters must use a versioned JSON-RPC cancellation message with the invocation ID. Functions and `AbortSignal` objects do not cross the wire.
Cancellation must release queued work, interrupt active work, and complete cleanup before the execution slot is reused.
Disposal must be idempotent, await owned work, release handles and registrations, and reject new requests.
Late, duplicate, malformed, oversized, or incorrectly bound replies must never become current results.

## Interfaces required for each function

All interfaces below extend `CapabilityProvider<Input, Output>` and require the shared lifecycle.
Each output uses logical entity paths and typed values. The host owns YAML/JSON rendering and conversion into client protocol objects.
An adapter can derive a function from another declared interface only after qualification proves that derivation.

| Function and proposed interface            | Required inputs and outputs                                                                                                                                   | Conditions for enabling the function                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation: `ValidationProvider`           | A pinned rule, qualified subject, prerequisite states, and authorized data produce a rule verdict, findings, artifact outputs, and coverage.                  | Preserve pass, violation, invalid policy, unavailable dependency, blocked prerequisite, and interrupted execution. Partial execution cannot verify required coverage.                                     |
| Field names: `FieldMetadataProvider`       | Kind/API-version scope, parent path, and current fields produce named field descriptors with types, requiredness, descriptions, and applicability conditions. | Supply bounded paths, array behavior, and constraints. Exclude existing keys from new insertions. Conditional requiredness needs established applicability.                                               |
| Values: `ValueSuggestionProvider`          | Target path, prefix, subject context, and approved data produce finite typed candidates with provenance and example/default/suggestion classification.        | Candidates need explicit enumerations, examples, defaults, or an authorized discovery source. The host owns filtering, ranking, and any claim that rules accept a candidate.                              |
| Hover: `HoverProvider`                     | Target path and rule context produce descriptions, types, constraints, and source-rule references.                                                            | Return bounded plain text or a host-approved structured format. No executable links, credential values, or unapproved source excerpts. Field descriptors can supply basic hover through the host adapter. |
| Navigation: `ReferenceProvider`            | Declared reference occurrences produce canonical identities, default kind/namespace rules, dependency paths, and target identities.                           | The host must resolve targets against qualified workspace state and approved catalog scope. Preserve inclusion ranges, invalid replacements, deletions, and conflicts. Ambiguous targets remain explicit. |
| Repairs: `RepairProvider`                  | A specific finding and pinned subject produce explicit choices or logical repair proposals with target rules and semantic preconditions.                      | Use only host-supported operations. The host must validate applicability, source mapping, candidate evidence, versions, digests, expiry, and budgets before creating an action.                           |
| Catalog or domain search: `SearchProvider` | A typed scoped query produces bounded identities or candidates with source, freshness, pagination, and completeness.                                          | Use approved connections and host credential brokers. Apply authorization, overlays, cursor limits, cancellation, and cache boundaries. Search results are advisory data.                                 |
| Remote changes: `DependencyChangeProvider` | An approved scope and optional cursor produce bounded invalidation hints, a next cursor, and any reset requirement.                                           | Declare the observation mechanism and coverage. Hints invalidate data but do not prove current contents or authorize access. The host must recover gaps through fresh reads.                              |
| File discovery: `SourceDiscoveryProvider`  | Host-approved roots and patterns produce bounded source identities and their observed revisions.                                                              | Enforce containment, link rules, file types, byte/count/depth limits, and cancellation. Proposal content cannot add roots or entrypoints outside host approval.                                           |

Field descriptors and value candidates must identify the rule/artifact that supplied each constraint.
Descriptors must define their subject stage and distinguish absent values from explicit null values.
Pointer patterns must use the host grammar and its array, escaping, depth, and occurrence limits.
A descriptor must not assign a schema to an undeclared kind or API version.

History and ranking belong to the host by default. History can reorder eligible results but cannot add values or widen catalog visibility.
Optional ranking providers receive only approved candidate IDs and a bounded permitted history projection.
Configuration reload and credential resolution use separate trusted host interfaces: `ConfigurationProvider` and `CredentialProvider`.
They are not ordinary rule-plugin permissions. Untrusted rules receive opaque service handles or pinned data instead of tokens and configuration paths.
Configuration, credential, policy, or permission changes must invalidate affected caches, pending results, and repair tokens.

## CEL rule requirements

CEL rule artifacts remain declarative data consumed by the approved evaluator.
Supporting a CEL artifact does not authorize custom JavaScript functions, synchronous evaluation, or a new interpreter profile.
Selectors and expressions must use the same qualified `bve-cel/1` implementation in CLI, editors, and hosted workers.
They must preserve missing/null behavior, numeric rules, boolean results, error classification, dependencies, and deterministic result ordering.

All CEL execution must use the supervised shared pool, including applicability checks and candidate validation.
Current ceilings are two worker slots, 64 outstanding jobs, 100 ms execution, and the original five-second request budget.
The centrally assigned profile can lower those limits. A plugin cannot create a pool per document or raise the ceilings.
Candidate work must share admission and bounded scheduling without starving validation or typing.
Any priority change must retain cancellation, queue fairness, and the existing resource guarantees.

A CEL predicate alone does not enumerate field names, allowed values, or repairs.
For example, a lifecycle predicate can declare `/spec/lifecycle` metadata and an explicit finite candidate list.
The plugin must supply `fields`, `values`, or `repairs` contributions to enable those functions.
The host must evaluate candidates through the qualified rule path before labeling them as accepted by that rule.
It must not infer that a candidate satisfies every mandatory policy from one successful predicate.
The current CEL profile returns booleans. Value-producing CEL expressions require a separately versioned and qualified profile.
The `values` interface does not implicitly introduce that profile.

External facts must arrive through declared provider dependencies and pinned observations.
A CEL helper or editor provider cannot fetch an endpoint chosen by authored source or retain undeclared mutable state.
Unknown applicability and unavailable prerequisites remain explicit. They cannot become unconditional required fields or prescribed repairs.

## RE2 rule requirements

RE2 predicates must declare the target paths, input types, engine/profile version, pattern, and matching semantics.
Current CEL `matches` behavior uses substring matching. A provider cannot silently substitute whole-string matching.
Whole-string intent must use the qualified profile's declared semantics and appropriate anchors.
Dynamic patterns must retain the same engine, admission, and failure behavior as static patterns.

Unsupported syntax, malformed patterns, and resource exhaustion must retain their established error categories.
No provider can fall back to JavaScript `RegExp` or another engine with different semantics.
CEL currently limits patterns to 512 UTF-16 units. The bounded schema profile permits 1,024 units.
These are distinct qualified limits. A future rule adapter must declare its profile instead of silently selecting the larger limit.

A regular expression describes a constraint, not a practical enumeration of all matching values.
For a name pattern, field metadata can expose the string constraint and hover text.
Value completion additionally requires finite examples, a declared candidate generator, or an approved data source.
Generated candidates must obey output and work limits and pass the applicable RE2 checks before acceptance claims.
A failing pattern does not establish one correct replacement. Repairs need explicit repair logic and host validation.

The existing bounded schema-pattern implementation does not authorize arbitrary executable callbacks in the language-server event loop.
Future executable RE2 providers and candidate generators need an approved supervised execution boundary and termination tests.
A standalone RE2 rule kind requires contract design, migration decisions, generated schemas, and compatibility tests before activation.
Until then, existing CEL and schema routes retain their current meaning.

## Execution, completion, and repair flow

The host must use the following flow for any supported rule family:

1. Resolve trusted policy, profile, artifacts, capabilities, versions, and permissions.
2. Parse sources and establish processing, normalization, admission, and dependency coverage.
3. Execute applicable validators through the shared pipeline and publish version-bound findings.
4. Prepare declared field, value, hover, reference, and search contributions asynchronously.
5. Serve completion requests from current prepared metadata and bounded provider results.
6. Validate selected candidate or repair proposals against the required affected pipeline stages.
7. Recheck source, dependencies, generations, versions, and freshness before dispatching any edit.
8. Revalidate after editor synchronization and replace findings from the resulting snapshot.

Completion handlers must not parse files, run CEL, generate regex candidates, or invoke arbitrary plugin code synchronously.
Background providers can prepare results while the handler returns available local hints.
Candidate validation must account for changed selectors, normalization, references, overlays, provider facts, and dependent rules.
The host must not reuse observations for a newly introduced reference unless the pinned data actually covers that reference.
Each admitted candidate job has an original deadline. Later stages and retries cannot renew it.

Cache keys must cover the full request binding, provider query, artifact versions, and required freshness.
Source edits, included-file changes, policy activation, permissions, credential revisions, and reloads must invalidate affected entries.
Unverified or partial candidates retain advisory labels. They cannot claim global policy compliance.
A plugin-supplied `verified: true` flag is not proof. The host owns execution evidence and coverage aggregation.

Repair proposals must use structured operations such as `setValue` or `insertProperty` with typed JSON values.
The host maps those operations into exact authored locations and preserves comments, quoting, indentation, and UTF-16 ranges.
The first adapter must retain the existing one-open-document edit inventory and guarded command path.
Closed-file, multi-file, resource, or unsupported operations require a separately negotiated capability and client guarantees.
Placeholder actions must identify unfinished input. They cannot claim to repair the complete rule.

The proposed output records must keep hints separate from host execution evidence.
`JsonValue` below is the existing JSON contract type. The host resolves subject IDs and paths against the bound source snapshot.

```ts
interface FieldDescriptor {
  readonly name: string;
  readonly parentPath: string;
  readonly types: readonly string[];
  readonly requiredness: 'required' | 'optional' | 'conditional';
  readonly applicabilityRuleId?: string;
  readonly description?: string;
  readonly sourceRuleIds: readonly string[];
}

interface ValueCandidate {
  readonly id: string;
  readonly subjectId: string;
  readonly path: string;
  readonly value: JsonValue;
  readonly classification: 'example' | 'default' | 'suggested';
  readonly sourceRuleIds: readonly string[];
}

interface RepairProposal {
  readonly id: string;
  readonly findingId: string;
  readonly subjectId: string;
  readonly targetRuleIds: readonly string[];
  readonly requiresAuthorInput: boolean;
  readonly operations: readonly (
    | { readonly kind: 'setValue'; readonly path: string; readonly value: JsonValue }
    | {
        readonly kind: 'insertProperty';
        readonly parentPath: string;
        readonly name: string;
        readonly value: JsonValue;
      }
  )[];
}
```

The host must attach artifact provenance, applicability, freshness, and candidate-validation evidence after inspecting these outputs.
It must reject undeclared paths, unsupported operations, mismatched finding/subject IDs, and plugin claims that contradict host evidence.
If the host cannot prove that an edit reaches the intended authored value, it must omit the repair.

## Live changes to catalog data

An LSP session outlives individual catalog observations. Remote changes must trigger work even when the author leaves a document unchanged.
Cache expiry limits reuse, but expiry alone does not schedule validation or change existing editor diagnostics.
The current implementation refreshes expired catalog data on subsequent requests. It does not yet revalidate idle buffers when remote data expires or changes.
Setting `maxAgeMs` to zero does not provide that missing schedule.

Every external-data provider must declare freshness bounds, observation scope, and the data dependencies that it supplies.
The host must track entity lookups, missing-reference observations, search queries, and collection membership dependencies.
A newly added team can change a previously empty search result or repair a missing-reference finding.
Watching only identities that already exist is insufficient.
Search identity projections cannot detect every entity-body change. Rules that consume membership or other fields need their own declared data dependencies.

| Remote event                               | Required editor behavior after a fresh observation                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team added                                 | Invalidate affected query and absence caches. Include the team in the next matching completion/search result. Revalidate references previously reported missing. |
| Team deleted                               | Remove it from refreshed candidates. Revalidate affected references and publish a missing-reference finding only when an applicable rule requires existence.     |
| Team renamed                               | Treat the old identity as removed and the new identity as added. Offer the new identity without rewriting the author's existing value.                           |
| Team body modified                         | Refresh affected metadata and rerun rules that depend on changed fields. An unchanged identity does not prove unchanged validation inputs.                       |
| Permissions revoked or catalog unavailable | Discard affected authority-scoped cached results. Report unavailable or incomplete dependency state instead of inventing absence.                                |

### Observation and refresh scheduling

The baseline must use bounded background refresh for the configured open-source dependencies and active search scopes.
A proposed default is a 30-second refresh cadence, shortened by the assigned freshness policy or an earlier observation expiry.
This is a design target for qualification, not a latency guarantee established by the current implementation.
Healthy change-to-result latency includes the refresh interval and the new request budget. The current request ceiling is five seconds.
The host must expire claims and repair eligibility at their freshness bound even when a refresh cannot complete in time.

An approved event adapter can implement `DependencyChangeProvider` to reduce detection latency.
Its versioned contract must declare coverage, scope, cursor/revision semantics, ordering, replay, heartbeat, gaps, and reconnect behavior.
The host must validate, bound, debounce, and coalesce change batches. It must not assume that a Backstage deployment supplies a universal change stream.
A sequence gap, cursor reset, or uncertain coverage requires invalidation and fresh reads within the approved scope.
Periodic reconciliation must recover missed events. Event hints cannot replace authorized provider observations.

Polling must batch and deduplicate required reads, obey rate limits, add jitter, and use bounded backoff after failures.
Conditional reads can reduce traffic only when the provider declares and qualifies their revision semantics.
The host must not fetch the complete catalog on every keystroke.
Clients that explicitly suspend background work must refresh on resume or focus before presenting expired data as current.
The host must not infer visibility from LSP open/close ownership notifications alone.

### Invalidation and LSP publication

A remote invalidation must advance a host-owned dependency generation even when document versions remain unchanged.
The host must revoke affected completion caches, candidate evidence, and repair tokens and cancel obsolete dependent work.
It must collect a new immutable data snapshot and admit a new validation request with its own original deadline.
It must never mutate the data snapshot of an existing invocation or extend that invocation's deadline.
Every response and cache entry must bind to the dependency generation and data digest as well as the source version.
An older response cannot restore a deleted team, outdated diagnostic, or revoked edit.

The first implementation can rerun the bounded workspace validation pipeline after coalescing invalidations.
Selective reevaluation requires a qualified dependency graph that covers queries, absence, memberships, CEL selectors, and rule prerequisites.
Native or schema-only work can be reused only when its actual inputs and required processing remain unchanged.
Local proposed entities, invalid replacements, conflicts, and deletion masks must retain precedence throughout refresh.

The current push-diagnostics adapter must publish updated findings for the same document version after remote-only changes.
A future negotiated pull-diagnostics adapter can request client refresh instead.
The server must remove obsolete findings when a fresh run no longer reports them.
Expired observations must not leave a result presented as freshly verified. Refreshing or unavailable states must remain visible without changing authored text.

Completion lists are client-requested in standard LSP. Refreshed choices must appear on the next matching completion request.
Updating an already open completion popup requires client cooperation. The baseline must not promise an unsolicited standard completion-list replacement.
A client-specific retrigger can be negotiated separately. It must preserve typing, selection, cancellation, and source versions.
An item accepted just before a remote deletion becomes known requires subsequent validation rather than a silent document rewrite.

CLI runs must still collect and pin observations under their freshness policy and preserve mid-run expiry checks.
They do not normally need a continuous subscription after exit. Snapshot replay remains a separate explicit mode.
Neither interface implies an atomic transaction with all catalog changes.

Protocol references: [push diagnostics](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/publishDiagnostics.md),
[pull diagnostics](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/pullDiagnostics.md), and
[completion requests](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/completion.md).

## Conformance requirements

Conformance means that a provider passes the required behavior tests for every capability it advertises.
Every case below needs positive, rejection, cancellation, and stale-result coverage where applicable.
Claims must identify the tested artifact, API version, runtime profile, client versions, and supported platform.

| Acceptance ID                         | Required evidence                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PC-01: registration                   | Reject tampered artifacts, unknown required capability versions, unsupported isolation, undeclared dependencies, and malformed requests/responses.                                                                                                                                               |
| PC-02: validation                     | Preserve existing CEL/schema/catalog outcomes, rule ordering, required coverage, native pins, and shared CLI/editor semantics. Run the frozen CEL corpus through the actual production workers.                                                                                                  |
| PC-03: fields and values              | Test missing/null, required/optional/conditional fields, kind/API-version selection, arrays, escaped pointers, unusual keys, finite candidates, and conflicting constraints. A validator without editor metadata supplies no invented hints.                                                     |
| PC-04: CEL and RE2                    | Test false versus execution error, unsupported functions and regex syntax, substring semantics, profile-specific limits, expensive work, queue pressure, cancellation, worker replacement, and recovery.                                                                                         |
| PC-05: hover and navigation           | Test bounded safe text, descriptions from the correct artifact, namespaces, qualified identities, includes, conflicts, invalid replacements, deletions, and denied targets.                                                                                                                      |
| PC-06: repairs                        | Test explicit alternatives, candidate evidence, changed applicability, unavailable dependencies, unsupported operations, source rendering, stale versions/digests, expiry, single-use tokens, client rejection, and synchronization.                                                             |
| PC-07: search and history             | Test permission and credential changes, pagination, byte/count limits, expiry, partial results, local precedence, outages, and ranking that cannot reveal or introduce ineligible results.                                                                                                       |
| PC-08: discovery and host services    | Test containment, links, mutation, source budgets, credential redaction, fixed configuration authority, and denial of source-selected paths or endpoints.                                                                                                                                        |
| PC-09: lifecycle and resources        | Test initialization failure, bounded queues and caches, repeated reload/restart, no listener/worker/handle growth, shutdown with active work, and late or malformed replies.                                                                                                                     |
| PC-10: client and release integration | Test installed VS Code and supported JetBrains clients with concurrent rules, typing, completion, navigation, and guarded edits. Preserve real-backend and exact-candidate release gates.                                                                                                        |
| PC-11: live remote dependencies       | Add, delete, rename, and modify teams without document edits. Test unchanged-identity body changes, absence/query invalidation, same-version diagnostic replacement, dependency generations, stale replies and fixes, expiry, stream gaps, reconnect reconciliation, and polling/backoff limits. |

Executable plugins remain disabled until their approved isolation profile passes the required denial and resource tests.
Worker threads and a capability manifest alone do not provide operating-system isolation.
Optional editor-provider failure must not suppress required validation findings or weaken mandatory policies.

## Delivery through the five-phase editor plan

The [editor plan](lsp-editor-improvements-plan.md) replaces the earlier seven-increment delivery order.
The table below maps these technical requirements to its five phases. Full phase gates remain in that plan.
The [phase record](lsp-editor-improvements-implementation-record.md) distinguishes implementation from parent acceptance.

| Phase       | Capability work                                                                                                                                              | Required conformance                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1           | Reconcile completed separation and qualification documentation.                                                                                              | Evidence, scope, formatting, and link review. No runtime changes.               |
| 2           | Freeze lifecycle, manifests, bindings, capability schemas, and negotiation. Adapt built-in validation, metadata, references, repairs, search, and discovery. | PC-01, PC-02, PC-03, PC-05, PC-06, PC-07, PC-08, and lifecycle rejection tests. |
| 3           | Add bounded background refresh, dependency generations, query/absence invalidation, and same-version diagnostics.                                            | PC-11 with mutable catalog data and no source-edit trigger.                     |
| 4           | Add CEL and RE2 metadata, finite candidates, applicability, candidate evidence, and guarded repair proposals through qualified runtime paths.                | PC-02, PC-03, PC-04, PC-06, and focused installed-client integration.           |
| 5, deferred | Improve native Trust automation, qualify installed JetBrains clients, and complete longer final-candidate endurance and release qualification.               | PC-10 and the declared final support/release matrix.                            |

Phase 2 implements the built-in interfaces. Its local qualification passed, and parent acceptance remains pending in the phase record.
Phases 3 and 4 remain planned. Phase 5 does not start automatically.
Built-in adapters and approved declarative artifacts do not require an arbitrary executable plugin loader.
External executable providers need separate approval, process supervision, permission brokers, and qualified isolation.
Their future gates include PC-01 through PC-09 and PC-11 for external-data providers.
SQS, Kafka, the durable hosted controller, and authoritative GitHub publication remain outside this sequence.

This plan extends the [current editor implementation](editor-features.md) and [managed CEL runtime](cel-runtime.md).
The [architecture](architecture.md) retains one validation engine and trusted host authority.
Implementation must preserve the [required processor gate](processors.md), [policy contracts](contracts.md), and existing release qualification boundaries.

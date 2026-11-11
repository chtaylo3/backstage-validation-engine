# Catalog policies and language server

For the packaged VS Code client and hosted test/artifact matrix, see
[VS Code setup](../extensions/vscode/README.md) and [GitHub Actions](github-actions.md).

The Language Server Protocol (LSP) connects editor features to a language server.
`validatePolicySources` combines source and native validation, catalog observations selected by
policy, and the rule dependency graph. The graph is a DAG: a directed graph with no cycles.
`executePolicyRules` is the lower-level API for the rule stage.

`executeCelRules` remains a compatible alias. These APIs provide scoped validation. They do not
establish complete Backstage ingestion or verified policy authority.

The LSP ownership separation completed phases 0 through 9 and merged in PR #2.
Its native VS Code and real SSH, dev-container, and Windows WSL2 qualification passed for the recorded candidate.
See the [current qualification record](lsp-separation-implementation-record.md#hosted-qualification-and-merge) for revisions, digests, counts, and retained failures.
The [five-phase editor plan](lsp-editor-improvements-plan.md) governs remaining editor work. Phase 5 is deferred.
Later dated increment sections retain their historical qualification scope.

## Explicit catalog rules

An organization can require an existing owner with this policy entry:

```json
{
  "id": "owner-exists",
  "version": "1",
  "kind": "catalog",
  "check": "exists",
  "referencePath": "/spec/owner",
  "selector": "entity.kind == \"Component\"",
  "mandatory": true,
  "severity": "error",
  "requires": []
}
```

`referencePath` must exactly match a declared deployment reference context, including any array
wildcard. Bindings are checked before HTTP. Only paths used by catalog rules are collected by the
composition API. CEL/native-only policies perform no catalog I/O. The standalone reference preparer
still collects all declared contexts unless its optional `referencePaths` selects a subset.

Facts bind to the exact pinned request, source digest and version, validated normalized subject,
profile, and data entries. The engine extracts occurrences again from the validated subject. Altered
observation payloads cannot replace pinned data. Native reference locations and alias provenance
reach findings. A missing authorized-view observation fails the explicit rule. Blocked, expired or
unavailable observations make the rule incomplete, with a dependency finding.

IDE dependency findings are warnings. Mandatory CI dependencies block with exit 2 through the result
aggregator. Confirmed missing mandatory references produce exit 1. An absent optional field or empty
array is not applicable. To require a field, add a separate presence rule. DAG prerequisites must
pass.

This adds a rule kind to pre-release contract 0.2 and requires an updated policy consumer. The
frozen `bve-cel/1` environment, interpreter, worker protocol and qualification corpus are unchanged.
Catalog access is outside CEL evaluation.

## Launching the stdio server

The `bve-lsp` executable, or `node dist/lsp/stdio.js`, accepts exactly
`--config <trusted-config.json>`. Build the project first. Configure the editor to launch the Node
entry point directly. This keeps npm and build output out of the protocol stream.

For a development fixture:

```bash
npm run build
npm run fixtures:serve -- 1.56
# In another terminal, substitute the numeric port printed above:
node examples/create-lsp-config.mjs http://127.0.0.1:PORT/api/catalog /tmp/bve-lsp.json
export BVE_CATALOG_TOKEN=development-only-token
node dist/lsp/stdio.js --config /tmp/bve-lsp.json
```

The last command expects a framed LSP client on stdin. The generator uses synthetic development
authority, an empty repository snapshot and a named token environment variable. It creates a new
file and refuses to overwrite one. It does not validate an installation's real policy or identity
authority.

The launcher configuration contains `profile`, `policy`, `activation`, `identity` and `source`
artifacts using production contracts, optional `debounceMs` (0–250, default 25) and optional
`catalog` connection settings. Catalog settings are `connectionId`, `baseUrl`, `principalId`,
`credentialRevision`, `scope`, `maxAgeMs` (0–30000) and `tokenEnv`. Tokens remain in the launcher
environment. An omitted connection produces incomplete dependency warnings when a catalog rule needs
data. Configuration consistency checks do not verify signatures, assignments, inheritance or backend
authentication semantics. Initialization options and workspace settings cannot replace these
artifacts or the endpoint.

Optional `catalog.allowInsecureHttp` defaults to false.
For an approved private HTTP service, the trusted launcher can set it to true.
The Compose test connection uses this option for `http://backstage:7007`.
HTTP sends credentials and data without transport encryption.
Editor initialization options, workspace settings, and source files cannot enable the option.

Optional `schemaArtifacts` supplies the trusted, digest-checked bodies for custom kind pins.
Admission and custom-schema checks run before reference policies. Disallowed or schema-invalid
entities produce errors. Missing artifacts produce dependency warnings. Invalid schema configuration
fails startup. See [admission and custom kinds](admission-custom-kinds.md).

Optional `filesystem` settings enable [saved-file refresh](#saved-file-snapshot-refresh) within a
launcher-approved root and file list.

Programmatic hosts can import `parseLspConfig`, `createLspRequest`, `createLspCatalog` and
`attachLspServer` from the package's `./lsp` export. The host supplies the disposal callback and
owns provider/runtime lifetime. The stdio launcher closes both its provider and shared CEL runtime
on shutdown or EOF.

## Internal state and resource ownership

`attachLspServer` composes the workspace, validation coordinator, resource generations, and protocol handlers.
Features consume immutable document views. A document lifetime changes after close and reopen, even with the same URI and version.
Source capture commits only when its disk and workspace generations remain current.

Request contexts preserve cancellation, the admitted deadline, and the session identity that owns their resource use.
Completion, search, hover, definitions, diagnostics, and repairs retain their feature-specific admission rules.
An outstanding client edit remains reserved across timeout and configuration reload until the client response settles.
Terminal close prevents new edits and does not await a silent client's acknowledgement.

Reload blocks affected requests, prepares and admits replacement resources, and cancels users of the retired generation.
One activation commit installs the new services and source selection. Failures cannot reactivate retired resources.
Session close bounds internal draining and attempts every owned finalizer. Cleanup failure requires reconnecting.
The process configuration watch survives failed reloads. Each credential watch belongs to its resource generation.

Programmatic hosts retain responsibility for supplied provider/filesystem cleanup through their aggregate `dispose` callback.
The stdio launcher supplies a callback that attempts both closes. Session replacement does not close its shared CEL runtime.
See [the implementation record](lsp-separation-implementation-record.md) for qualification evidence.

## Supported editor lifecycle

- Standard initialize/initialized, UTF-16 positions and incremental open/change/ close
  synchronization. Non-increasing versions and duplicate opens are ignored.
- Immutable launcher-supplied repository snapshot plus current open buffers. Every accepted
  workspace edit invalidates dependent open-document results.
- Pinned roots/entrypoints enable [snapshot-local substitutions](substitutions.md). Included-buffer
  edits revalidate catalog users. Findings appear at actual payload ranges and at related inclusion
  sites in open documents, with each published document's current version/digest. Closing a payload
  restores its pinned base bytes and revalidates users.
- One active validation and one latest queued workspace generation. Edits/close/ shutdown cancel
  active work. Only the current epoch can publish. Diagnostics carry document version and, when
  known, file digest, finding ID and category.
- Confirmed missing references are policy errors. Permission failures/outages and conservative
  local-entity guards produce dependency warnings. Close clears diagnostics. Shutdown awaits
  cancellation and resource cleanup before exit.
- Input framing is bounded to 8 MiB per message and 8 KiB per header before SDK buffering.
  Source/profile limits apply to buffers, with at most 1000 open documents and 1000 changes per
  notification. Invalid/over-budget edits invalidate validation and require a bounded full
  replacement or close/reopen to recover. Exceeding open-document capacity blocks the session until
  restart.

The server uses the official language-server SDK for framing/JSON-RPC lifecycle and the official
text-document implementation for UTF-16 edits. The preflight stream bounds messages before the SDK
parses them. Stdout contains protocol messages. Startup errors use fixed text on stderr without
upstream details.

Optional launcher-approved filesystem refresh is described below. Pull diagnostics and broader
release qualification remain future work. Existing hover, reload, and packaging behavior is documented
in [editor features](editor-features.md). With filesystem refresh disabled, closing a buffer restores pinned workspace bytes. Restart with a
refreshed trusted snapshot to incorporate disk changes. Qualified local targets now precede external
observations.

Invalid/competing targets block fallback, and pinned-baseline removals mask old catalog copies. The
launcher can supply an explicit `baseline` source snapshot. Otherwise, the unchanged launcher source
is the default baseline. Standard workspace file delete/rename notifications update known pinned
bytes and revalidate dependents. See [overlay/editor scope](proposed-overlays.md).

## Acceptance

`npm run test:lsp` compiles and runs catalog-rule and real subprocess/stdio tests.
`npm run test:harness` includes them with the provider and versioned API fixtures. Tests initialize
the production launcher, exchange standard LSP messages, inspect published diagnostics and shut it
down. HTTP response gates synchronize race and cancellation scenarios.

Coverage includes both pinned backend contracts and both native models at the policy layer. Tests
cover UTF-16 offsets after emoji, authorization versus outage, context selection, scoped CI
aggregation, and source and data bindings. They also cover rapid edits, close and reopen,
included-buffer edits and repair, restoration, inclusion-site diagnostics, local-source guards,
resynchronization, and framing limits.

Native VS Code and hosted OS checks later passed in the current qualification record above.
Installed JetBrains, longer final-candidate workloads, and release-specific integration evidence remain separate gates.
The historical CEL measurements below retain their original scope and performance limits.

Local qualification on 2026-10-29: 37 new policy/LSP checks and all 424 tests in `npm run check`
passed. Full and production npm audits report zero vulnerabilities. The built development
configuration generator and EOF smoke passed. EOF without shutdown returns protocol failure (exit 1)
after cleanup, with empty output streams.

The subsequent BC-04 increment adds five LSP checks for included buffers and diagnostic provenance.
The full local `npm run check` passed all 485 tests.

BC-05 adds seven LSP checks for admission/custom schemas across both native and API pins. The full
local `npm run check` passed all 552 tests on 2026-10-30.

BC-06 adds nine LSP checks for local precedence, invalid replacements, pinned deletions,
file/identity renames, conflicts, cancellation and unavailable operation bytes. The full local
`npm run check` passed all 593 tests on 2026-11-03.

## Failure evidence and buffer recovery

Warnings and findings from interrupted work can carry bounded `data.execution` evidence. It includes
fixed stage and cause labels, monotonic elapsed time, signed wall elapsed time, and time left before
the original deadline. The existing `data.version` and source digest still identify the publication
lifetime. Evidence has a 64-row limit and passes through an allowlist before publication. It
excludes raw exceptions, credentials, endpoints, source text, and artifacts. The visible warning
text and version/epoch suppression remain unchanged.

Unexpected early exceptions now preserve their stage and safe cause through the policy pipeline. For
example, unresolved policy inheritance produces `bindings / invalid_policy` with zero HTTP requests.
`BudgetAdmissionError` is a `RangeError` subclass identifying invalid or out-of-range deadlines. The
existing five-second admission limit remains unchanged. A backward clock correction after request
creation can still cause `deadline_out_of_range`, with signed wall timing and remaining-deadline
evidence available for diagnosis.

Buffer recovery has separate native-only stdio coverage for oversized replacements, rejected
incremental edits, and bounded full-replacement repair. A separate HTTP integration uses response
gates for initial validation and repair, asserts successful initial diagnostics, and proves that
unavailable-buffer versions issue no extra requests. If validation ends before a gate is entered,
the test reports that diagnostic immediately. No retries or extended production deadlines are used.

The clock-regression tests also prove that a wall-clock rollback after budget admission does not
extend its monotonic execution deadline. This work implements diagnostics and test isolation. It
does not establish a historical root cause or introduce a new clock and budget architecture across
the pipeline.

Local qualification on 2026-11-07: native-only buffer recovery, gated HTTP recovery and
early-exception diagnostics passed through the real stdio launcher. The full 672-test check passed,
including unchanged version/epoch, cancellation, framing and shutdown coverage.

## Saved-file snapshot refresh

The trusted launcher can opt into filesystem capture with `source.rootUri` and an exact `filesystem`
allowlist. For example, alongside the existing contracts:

```json
{
  "filesystem": {
    "files": [
      "file:///workspace/catalog-info.yaml",
      "file:///workspace/spec.yaml",
      "file:///workspace/team.yaml"
    ],
    "entrypoints": ["file:///workspace/catalog-info.yaml", "file:///workspace/team.yaml"]
  }
}
```

`source.rootUri` must be a canonical local directory URI. All initial source and baseline files must
be approved. The allowlist has at most 1000 canonical, contained file URIs and can include currently
absent files. `filesystem.entrypoints` is an optional fixed catalog-input plan, defaulting to
`source.entrypoints`.

Only currently present inputs are selected. Restoring a deleted input also restores its selection.
Without an explicit plan, the existing all-file parsing behavior applies. Keep payloads separate
from catalog entrypoints.

The first open-document validation captures approved closed files. Standard
[`didSave`](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/textDocument/didSave.md)
and
[`didChangeWatchedFiles`](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/workspace/didChangeWatchedFiles.md)
notifications invalidate the generation and refresh those files as one proposed snapshot. Save text
supplied in the notification is ignored. Open buffers retain precedence, including over invalid or
missing disk content.

The server defers their disk reads until close. Closing an approved buffer captures its latest saved
bytes. The server ignores unrelated notification paths. Ancestor directory events invalidate
approved descendants. Notification paths never select additional disk reads.

Large event batches coalesce to a bounded approved-file refresh without scanning all event paths.
Newly discovered files need launcher approval. There is no recursive directory discovery.
File-operation rename targets also need prior approval in this mode.

Clients supporting dynamic watched-file registration and relative patterns receive one root-relative
watcher registration. The client owns the watcher. The server filters notifications through the
exact approved list. Clients without those capabilities must configure watched-file notifications
themselves.

Saves still refresh approved files. Rejected registration produces a fixed protocol log message.
Initialization workspace roots/settings cannot redirect the capture root, change the list, or
replace policy/profile/activation authority.

Disk bytes, immutable baseline-relative changes and entrypoint membership are rebuilt before
policy/reference execution. The original validation budget starts before disk I/O and is retained
for parsing, collection and rules. Cancellation is checked around filesystem operations and bounded
read chunks. Obsolete captures cannot commit or publish.

The server captures pending disk generations again. Existing HTTP and worker cancellation, versioned
diagnostics and epoch guards remain in force. Read failures block dependent work and produce safe
`filesystem` evidence rather than validating stale pinned bytes. An approved repair/event retries
capture.

The reader pins the root identity and real path. It rejects symlinks below that root, multiply
linked files, and non-regular files. Where supported, it uses no-follow and nonblocking open flags.
It compares descriptor and path metadata before and after reads. UTF-8 decoding is strict and
preserves BOM and newline bytes. Profile file and request limits apply.

These checks detect observed filesystem mutations. They do not establish an atomic cross-file
transaction or a race-free OS confinement boundary against hostile concurrent path replacement. An
in-progress OS filesystem call is cooperatively awaited. Local filesystem latency and behavior on
each supported OS still need qualification. Shutdown cancels captures, awaits completion and closes
handles.

Programmatic hosts construct `createFilesystemSource(config)` and pass it as
`attachLspServer(..., { filesystem })`, owning its `close()` along with provider/ worker disposal.
The stdio launcher constructs and disposes the reader itself. Policy and activation files are not
reloaded through this mechanism.

A development-only launcher generator captures an existing directory using the same reader. The
first named file is the catalog entrypoint. Other names are approved payloads. It writes a new
output file and uses synthetic authority:

```sh
npm run build
node examples/create-filesystem-lsp-config.mjs /path/to/repository \
  /tmp/bve-filesystem-lsp.json catalog-info.yaml spec.yaml
node dist/lsp/stdio.js --config /tmp/bve-filesystem-lsp.json
```

The final command expects a framed LSP client, which sends messages with protocol headers. Real
installation authority, filesystem, editor, OS, and IDE package qualification remain separate
requirements.

Local qualification on 2026-11-07: the full regression check passed 693 tests. After final
file-metadata and watch-event refinements, all 22 refresh checks passed, including an added
observed-mutation case. Static/build/schema checks and the filesystem launcher example also passed.
This evidence uses real stdio and local filesystem and HTTP fixtures. Actual editor and supported-OS
qualification remains open.

## Version-safe scalar fixes

Schema-rule findings can offer Apply policy-required scalar value. The first inventory handles a
failed scalar `const` reached through an unconditional direct `properties` chain in a trusted,
pinned schema artifact. For example, `lifecycle: experimental # keep` becomes
`lifecycle: "production" # keep` when the schema requires `production`. Exact source spans preserve
surrounding comments, newlines and UTF-16 positions.

JSON literals are valid replacement scalars in both JSON and YAML. Applying one fix can leave other
policy or native findings. Validation runs again after the editor reports the change.

Only authored single-line scalar values qualify. Structured `$yaml`/`$json` inclusions retain their
actual target URI, digest and buffer version. Aliases, block scalars, `$text`, missing fields,
defaults, container constants, alternative/ conditional branches and `$ref`-based constraints do not
generate fixes. There is no fix-all action, guessed value, file creation/deletion, or direct disk
write. Generation is capped at 64 fixes per run and 4096 UTF-8 bytes per scalar.

The server advertises quick fixes only when the client supplies `workspace.applyEdit`,
`workspace.workspaceEdit.documentChanges`, code-action literal support, and diagnostic
`dataSupport`. An action carries an opaque, single-use `bve.applyFix` command token. The client
cannot submit replacement text or URIs through that command. At execution, the server rechecks the
validated workspace generation and every open buffer's version and digest.

Overlapping configuration reloads share one completion response that waits for queued replacements.
Intermediate generations do not announce readiness or resume validation.
While configuration is unavailable, a well-formed repair command returns `stale` without dispatching an edit.
Unknown commands and malformed arguments still return `invalid_request`.

It also rechecks target edit ranges, source fingerprints, profile byte limits, and observation
freshness. Save/watch, edit, close/reopen, rename/delete and other validation-triggering events
invalidate previous tokens, including when a buffer version is reused. Tokens expire within 60
seconds, bounded by observation expiry, using wall and monotonic clocks.

The server sends a standard
[`workspace/applyEdit`](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/workspace/applyEdit.md)
with `documentChanges` and an exact document version. Targets must be open. There is no unversioned
fallback. The guard accepts at most 16 nonoverlapping edits in one document and 16 KiB of
replacement text.

Multiple edits require transactional text-edit capability. Current scalar fixes contain one edit.
Candidate/action/token limits are 64/32/128 respectively. Oldest tokens are evicted first. Fixes are
withheld when required validation is incomplete or configuration, dependency, execution or resource
failures occur.

Server checks cover the state before dispatch. When it applies the edit, the editor must enforce the
final document-version check. Standard LSP does not provide an atomic digest/workspace-epoch
condition after dispatch. Dependency changes during dispatch need actual editor qualification.

So does a close and reopen that reuses a version after dispatch. Server prechecks alone cannot
establish safety for these cases. The implementation never treats a matching version as proof of a
matching digest during its own checks.

Client rejection returns a fixed `client_rejected` result. Errors, cancellation or the five-second
local apply wait return `client_error`, without publishing raw client failure text. Only one client
apply request can remain outstanding. A silent client blocks additional requests until it responds
or disconnects.

A successful or unknown result suppresses more fixes for that snapshot until an editor/workspace
event causes revalidation. The server waits for real `didChange` notifications to update text or
diagnostics. A command token is never retried.

The scalar, guard and real stdio suites are part of `npm run test:lsp` and `npm run test:harness`.
They cover both native model pins, YAML, JSON, included sources, formatting preservation, stale
diagnostics and tokens, and content changes without version changes. They also cover UTF-16,
overlapping edits, byte limits, expiry, backward clock changes, watch invalidation, client version
races and rejection, and silent-client shutdown. These are protocol-fixture checks.

At this historical increment, VS Code and JetBrains installation qualification remained open.
Later native VS Code qualification appears in the current record above. Installed JetBrains qualification remains deferred.

Local qualification on 2026-11-07: all 774 tests and required type/lint/format/schema/build checks
passed through `npm run check`, including 80 new scalar, guard and stdio checks. There were no
failures or skips.

## Responsive reference completion

The later [editor features increment](editor-features.md) adds field and schema-value completion,
recovery while typing, hover, local definitions, broader repairs, search, history, discovery, and
trusted configuration reload. The inventory below records the original reference-completion increment.

The server advertises standard
[`textDocument/completion`](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/completion.md)
with `:` and `/` triggers. Suggestions apply to authored scalar values at the deployment profile's
declared reference contexts, including wildcard and numeric array positions. Defaults come from that
context and the entity namespace. Explicit kind and namespace prefixes override them. Items insert
canonical qualified references using plain-text edits.

Quotes, surrounding comments and UTF-16 ranges are preserved. An existing empty YAML value is
supported. Creating missing fields, repairing syntax errors, keys/comments, aliases, block scalars
and `$text` payloads are outside this inventory. Qualified structured YAML/JSON inclusions retain
the open payload's actual edit range. Ambiguous shared-payload contexts offer no edits.

A separate source-index task validates native/source compatibility and the pinned baseline without
CEL or catalog HTTP. It keeps one active task and one latest pending snapshot, with cooperative
cancellation and the original validation deadline. The completion request uses the prepared index.
It does not parse files, read disk, or wait for index preparation or validation HTTP requests.

While the index is unavailable, it returns an empty incomplete list. Source preparation shares the
event loop and adds bounded native/parsing work alongside validation. Cold index preparation and
actual editor latency still need qualification.

Qualified workspace identities rank first. Competing claims, invalid replacements and
baseline-relative deletions mask remote identities through the existing proposed-catalog semantics.
Incomplete source identity/processing prevents speculative suggestions. Every list is incomplete so
further typing recomputes context, filtering and ranking.

There are at most 100 items and 1000 indexed reference slots. Source and profile admission limits
still apply. One line index is built per completion request, even when many slots share a large
buffer.

An optional catalog connection supplies advisory identity search after at least two name characters.
Completion waits at most 50 ms for that async search and then returns available local results. The
current query can continue in the background for up to 500 ms. Equal queries share work.

A new query, source generation, request cancellation, or shutdown cancels obsolete work. A caller
cancellation also cancels a shared equal query. Another request can retry. The provider shares
admission, credentials, rate limits, response budgets and shutdown with validation. These are
configured wait bounds, not an end-to-end editor latency guarantee.

Search uses fixed kind and namespace filters and name text search. It projects only identity fields,
follows opaque cursors for at most four pages, and retains at most 200 prefix matches. The server
applies its prefix and local-overlay filters again. Arbitrary client query bodies, URLs and cursors
are not accepted. Search results are suggestions, not validation observations or proofs of
existence, absence, ingestion success or policy compliance.

The host keeps at most 32 query results / 256 KiB under its immutable connection, installation,
principal, permission/credential revision and policy/profile context. Reuse obeys
`catalog.maxAgeMs`, upstream expiry, and an age limit measured with a monotonic clock. Backward
wall-clock changes discard cache entries. Zero max age bypasses reuse.

Results show `Workspace source` or `Catalog (fresh)`. Catalog items carry fetch and expiry
timestamps without entity bodies, endpoints, or credentials. Denied/outage/ invalid responses offer
local results and are not negative cache entries. Authority/credential configuration changes require
a new host. This increment does not reload configuration or implement authentication refresh.

Epoch and target version/digest checks suppress results when a document changes while completion is
being computed. Clients remain responsible for discarding obsolete completion responses and applying
edits to the corresponding buffer. Standard completion text edits have no document-version
precondition. Versioned quick fixes use the separate guarded command path above. No completion
handler writes files, executes commands or changes validation findings.

The completion, catalog-search and stdio suites are included in `test:lsp`, `test:harness` and the
full check. They cover both native pins and pinned API contracts, reference prefixes and defaults,
arrays, empty and quoted scalars, JSON, CRLF, and UTF-16. They also cover local masks, visibility,
pagination, queue and byte limits, freshness, typing during held HTTP, cancellation, included
payloads, and shutdown. At this historical increment, extension packaging and installed-client qualification were still pending.
Later increments added property/schema completion, search UI, history ranking, hover, and navigation.
See [current editor features](editor-features.md) and the qualification record above for completed scope and remaining release work.

Local qualification on 2026-11-07: `npm run check` passed all 813 tests, including 39 new
completion/search/stdio checks, with no failures or skips. Required type/lint/format/schema/build
checks passed. Warm local completion over a 1000-entity snapshot measured p95 0.188 ms across 20
samples after three warmups. An 844151-byte buffer with 1000 reference slots took 2.927 ms for one
warm request. These local measurements exclude cold source-index preparation, validation, network,
and actual editor integration. They do not establish release latency guarantees.

## Live catalog dependency refresh

The active LSP session owns `CatalogRefresh`. The CLI does not start this service.
It records up to 1000 actual full-body or missing-reference dependencies and 32 recent identity query scopes.
The body inventory follows the latest current validation run. Local overlay resolution determines which remote reads occur.
Query scopes retain the approved kind, namespace, prefix, connection, and authority context.
They expire after 120 seconds without user interest. Background work never extends this lifetime.

The default target interval is 30 seconds. Earlier qualified expiry and `catalog.maxAgeMs` shorten it.
Healthy jitter advances the target by up to ten percent. A 250 ms floor bounds timer frequency.
Zero maximum age bypasses cache reuse. It retains the default observation cadence or earlier actual expiry, without shortening a new observation to the floor.
Protocol admission also detects elapsed claim expiry, so a delayed timer cannot authorize an expired repair.
A failed refresh backs off from at least one second to 120 seconds, with up to ten percent additional jitter.
Any remaining valid observation expiry still takes precedence over that backoff.

Each tick advances the dependency generation and invalidates the existing coordinator once.
It clears remote completion caches, cancels obsolete reads, invalidates metadata and guarded repairs, and schedules a new validation.
That validation bypasses provider caches for its selected remote references.
Body reads, bounded recent query refresh, and evaluation share its original request deadline.
Up to four query refresh workers share the provider's existing four-request transport limit.
The provider retains its 100-reference batching, 1000-reference admission limit, and 64-operation queue limit.
The refresh owner also admits at most 64 outstanding operations and coalesces equal identity queries.
No full-catalog scan occurs per keystroke. Ordinary buffer edits retain normal cache reuse.

Healthy change-to-result targets include the observation interval, configured validation debounce, and one newly admitted request budget.
They are targets under available capacity, rather than hard delivery guarantees during outages or scheduling pressure.
Same-version diagnostic publication replaces or clears the previous findings after fresh evaluation.
Subsequent completion and search requests receive fresh choices. Standard LSP completion lists remain client-requested.
An already open search picker has no automatic remote refresh negotiation in this implementation.

Full entity revisions cover body changes even when identity and rule outcomes remain identical.
Identity queries remain advisory. They cannot establish existence, global absence, or policy compliance.
When an authorized backend filters an entity into a missing response, the server cannot distinguish that response from global deletion.
Explicit denial remains unavailable and immediately revokes existing dependency eligibility. Repeated denial cannot continuously cancel the replacement run.
The wrapper rejects changed authority contexts before cache reuse or in-flight joins. Changed permission and credential revisions require resource replacement.
Local overlays, invalid replacements, conflicts, and deletion masks retain precedence during refresh and outages.
Reload, cleanup failure, and shutdown suspend refresh immediately, including the asynchronous configuration preparation interval.
Cached requests reject, entered reads receive cancellation, and disposal drains owned reads before the underlying connection closes.
Optional Backstage event adapters remain unimplemented. Future hints must satisfy the declared dependency-change interface and trigger fresh authorized reads.

## Read-only coverage observation

A trusted launcher can set `coverageObservation: true` to enable `bve/validationCoverage`.
The default is disabled. Requests supply the current document URI, version, and text digest.
The response contains current coverage and its source, authority, workspace, and dependency bindings.
A stale or foreign document, unavailable session, or revoked launcher permission returns `null`.
Initialization options and workspace settings cannot grant access. The request performs no edits or general debug operations.
The [evidence contract](release-evidence-contract.md#cli-variants-and-coverage-parity) defines the projection and its compatibility requirements.

# Implementation status

This document records implementation increments in order. Each section retains the scope and test
results from its checkpoint. Later increments can complete work that an earlier section lists as
open.

## Foundation increment

Implemented in this repository:

- Strict TypeScript ESM library with declarations/source maps, pinned dependencies, Node tests,
  typed ESLint, Prettier, and CI configuration.
- Production contract 0.2 definitions, inferred types, generated draft-07 schemas, strict parsing,
  and immutable return types.
- Source/data snapshot creation, canonical hashing, integrity verification, open-buffer overlays,
  deletion records, and admission budgets.
- Distinct provider availability/freshness/authorization provenance.
- Bounded rule DAG validation, default deployment profile, pinned artifact checks, stable finding
  IDs, and fail-closed outcome/exit-code aggregation.
- Examples for pass, false rule, invalid policy, unsupported processor, catalog unavailable,
  timeout, and emergency bypass.

The historical planning repository records 331 comparison checks, 67 managed CEL checks, and 84 Go
differential checks. These are historical observations. They were not rerun against the foundation
increment, which did not yet implement entity validation. The foundation contracts alone do not
qualify a production runtime or live integration for release.

## Managed CEL increment

The managed CEL and rules increment is implemented with exact interpreter and RE2 pins. It uses two
shared worker slots and admits at most 64 jobs globally. It distributes work fairly among requests
and enforces queue, execution, and startup deadlines. Cancellation awaits worker replacement. The
runtime also checks its protocol and handles shutdown.

`executeCelRules` combines managed selectors and expressions, pinned bindings, the rule dependency
graph, typed failures and coverage, and whole-request budgets. The 43-case qualification corpus
remains unchanged and runs through production workers. See
[runtime details and measurement](cel-runtime.md).

The [initial benchmark](evidence/cel-runtime-benchmark.md) records local p95 values for warm and
fresh-process execution. They are 1.67 ms for one warm entity, 14.89 ms for 100 warm entities, and
2,649.13 ms for a fresh process. The cold result exceeds the provisional 2,500 ms target. Startup
profiling and packaging remain open pilot performance requirements.

## Source-preserving parsing increment

The parsing increment implements YAML 1.2 parsing across files and documents with immutable source
history and UTF-16 JSON Pointer locations. It tracks aliases, excludes invalid files in CI, and
retains unaffected documents in editors. The 48 parser checks cover syntax, aliases, expansion,
source budgets, safe numbers, duplicate and merge keys, unsupported tags and versions, cancellation,
and deadlines. This increment brought the local suite to 138 checks. See the
[parsing acceptance register](parsing.md).

The [post-parser rules-stage capture](evidence/cel-runtime-after-parsing.md) records p95 of 1.69 ms
for one warm entity, 16.47 ms for 100 entities and 2,788.98 ms for a fresh process. It excludes YAML
execution. The cold-start target remains open.

## Native compatibility increment

BC-01/BC-02 are implemented and locally tested on catalog-model 1.10.2 and 1.7.5. They cover native
envelopes and kinds, explicit native policy composition, immutable authored and normalized entities,
and defaults with source locations. The parser and native pipeline block unsupported processors and
unresolved substitutions before dependent checks. The native and source suites add 130 checks,
bringing the local total to 268. See
[compatibility scope and acceptance](backstage-compatibility.md).

The optional group-parent default requires a pinned `groupDefaultParentRef` in the pre-release
deployment profile. Existing disabled configurations are unchanged. Historical rules-stage
benchmarks remain scoped evidence. Integrated native pipeline performance still needs qualification
before pilot release.

## Versioned test-harness plumbing

The versioned harness selects the numerically latest patch for each explicitly supported Backstage
major.minor line. It supports multiple majors and minors concurrently and pins immutable packages
and specifications. Tests verify OpenAPI artifact integrity offline, isolated HTTP probes,
concurrent fixture startup, and cleanup after partial startup. The convention is to test only the
latest stable patch in each supported minor.

Synthetic matrix tests prove multi-major selection independently of upstream releases. See
[harness design and acceptance](testing-harness.md). All 28 new harness checks passed locally,
bringing the suite to 296 tests. The full `npm run check` passed with loopback socket access enabled
for HTTP probes.

The subsequent catalog harness increment captures official Backstage 1.55.3 and 1.56.2 OpenAPI
specs/licenses and exact package/source provenance. The fake validates full-entity single and batch
lookups against those specifications. It provides scoped fixture identities, mutation controls,
one-shot failures, response gates, cancellation, and isolated listeners. Release refresh and
read-only upstream drift commands are implemented. A separate weekly/manual drift workflow is
configured.

Provider/source-reference integration is covered by subsequent increments below. Real-backend smoke
tests remain open. Native adapter support is unchanged. The full `npm run check` passed locally with
325 tests, including 57 harness checks. Hosted CI and real Backstage backend runs are not claimed.

## Production catalog provider increment

The production provider uses host-owned endpoints and credentials and native reference and envelope
helpers on both pins. It limits HTTP batches, retries, cooldowns, and cache size. Calls enter in
first-in-first-out order and support cancellation and shutdown. The adapter retains the original
deadline and returns contract-0.2 data snapshots to pin before evaluation. See
[provider behavior and qualification](catalog-provider.md).

At this checkpoint, overlay qualification and real-backend authentication and smoke tests remain
open. Catalog rules and LSP transport appear in later increments. All 31 new provider checks passed
locally. The full `npm run check` passed 356 tests. The built provider example passed against the
standalone fake API.

## Source references and catalog pinning increment

BC-03 implements declared owner, API, and system reference contexts. It supports canonical native
identities, fixed or entity namespaces, escaped pointers, bounded array wildcards, and
source-attributed findings. Reports retain occurrences, source digests and versions, and identity
claims. The preparer verifies provider bindings, collects eligible observations, and pins data under
the original deadline. Local, invalid, unknown, deleted, or competing identities block fallback
until BC-06 qualification. See [scope and acceptance](source-references.md).

Missing references remain data until an explicit organization rule consumes them. All 31 new checks
passed locally, including both native pins against both backend fixtures. The full check passed 387
tests. Reference-preparation and native/CEL examples passed. The next increment implements policy
bindings and stdio transport. At this checkpoint, full overlays, hosted CI, and real IDE and backend
qualification remain open.

## Catalog policies and stdio LSP increment

The catalog-policy increment implements pinned `catalog`/`exists` rules and provider collection
selected by reference context. It binds source, normalized subjects, and data, reports missing
references precisely, and records incomplete dependency coverage. `validatePolicySources` combines
native and source checks with policy execution. `executeCelRules` remains an alias for
`executePolicyRules`. The frozen CEL environment and corpus remain unchanged.

The stdio server uses launcher configuration, UTF-16 incremental edits, open-buffer snapshots, and
cancellation. It keeps one active request and the latest queued request. Generation counters
suppress stale results. Diagnostics carry document versions, and shutdown awaits cleanup.

The server pins official protocol and text-document libraries and enforces framing, buffer, and
full-replacement recovery limits. A subprocess client tests the production entry point against both
pinned fake APIs. See [scope, setup and acceptance](lsp.md).

All 37 new policy/LSP checks passed locally. The full `npm run check` passed 424 tests, including
the unchanged CEL corpus and EOF/unexpected-exit cleanup regressions. Full and production dependency
audits report zero vulnerabilities. The development launcher generator and EOF smoke passed with
empty protocol/error output streams. Real backend/IDE runs, filesystem snapshot refresh and positive
local overlay qualification remain open.

## Snapshot-local substitutions increment

Implemented BC-04 `$text`, `$json`, `$yaml` and file Location discovery from the immutable proposed
snapshot. Optional pinned source roots and catalog entrypoints separate entity inputs from payloads
and participate in source digests/overlays. Resolution enforces containment, cycles, depth and
expansion budgets under the original deadline/signal. Authored, resolved and normalized values
remain separate. Included field ranges, digests, versions and use chains reach references/findings.
See [reader scope and acceptance](substitutions.md).

The stdio LSP revalidates included-buffer edits, projects findings to inclusion sites, restores
pinned bytes on close and suppresses stale catalog responses. Remote/glob readers remain incomplete.
Host filesystem capture, BC-05 admission, BC-06 positive overlays and real editor/backend
qualification remain open.

Local qualification on 2026-10-29: 56 substitution checks and five added LSP checks passed. The full
`npm run check` passed all 485 tests, type checking, lint, formatting, generated-schema verification
and the production build.

## Admission and custom-kind increment

BC-05 implements kind admission after native normalization, with additive allowances for exact files
or directories from the pinned deployment profile. Denied entities retain violation findings and
identity guards. They do not enter references, artifacts, or policy evaluation.

Trusted `schema-artifact` bodies bind to exact custom kind/API-version profile pins. Bounded
synchronous draft-07 validation preserves native defaults without coercion or schema mutation. Local
bundled references and RE2 patterns are supported. Formats, external or cyclic references, and
asynchronous or custom extensions are rejected.

Stock kind validators cannot be overridden. Missing artifacts remain incomplete. See
[scope, examples and acceptance](admission-custom-kinds.md).

The LSP accepts launcher-owned schema artifacts and exercises denial, schema failure/repair and
missing-artifact warnings against both model/API pins. Positive overlays, actual backend/editor
runs, host snapshot refresh and complete processor qualification remain open.

Local qualification on 2026-10-30: 60 admission/custom-schema checks and seven added LSP checks
passed. The full `npm run check` passed all 552 tests and required type/lint/format/schema/build
checks. The built custom-kind example passed. Its invalid-tier variant produced a completed schema
violation with exit 1.

## Proposed catalog overlay increment

Implemented BC-06 qualified local precedence, invalid-replacement masks, explicit canonical identity
conflicts and baseline-relative deletion/rename handling. Optional request baselines and result
baseline digests pin previous input. Source and baseline changes are checked before collection.
Source-derived data uses a separate provider/key space and is verified against qualified reports
during policy binding. Existing remote denial/outage and original-deadline semantics remain
explicit. See [overlay scope and examples](proposed-overlays.md).

Conflict findings are emitted without an existence rule, and conflicted Location children are
withheld from artifacts/rule subjects. Diagnostic exhaustion is typed resource interruption. The
stdio LSP qualifies local buffers and supports known-file delete/rename notifications using pinned
bytes. Epochs suppress stale remote results. Host filesystem refresh, actual backend/editor/OS
qualification and complete deployment processor qualification remain open.

Local qualification on 2026-11-03: 32 overlay checks and nine added LSP checks passed, including
both native model and API pins. The full `npm run check` passed all 593 tests and required
type/lint/format/schema/build checks with loopback access. The built overlay example passed for a
local addition. Confirmed deletion returned a completed blocking violation with exit 1.

## Required processor blocking increment

BC-07 blocks parsing and every dependent stage when required deployment processing is unavailable.
Rules-only execution applies the same gate. Empty input, false selectors, and zero rules cannot
create verified coverage. Fixed IDE dependency warnings, CI incomplete results with exit 2,
cancellation, and deadlines propagate through both native and API pins and stdio. The executable
processor inventory remains empty. See [scope and acceptance](processors.md).

Local qualification on 2026-11-05: all 24 added checks and the full 617-test `npm run check` passed,
including required type/lint/format/schema/build checks.

## Signed policy and CLI increment

The policy and CLI increment verifies Ed25519 releases against separately installed host trust. It
binds exact activation scope and generation to the resolved policy and profile. Bundle inheritance
uses content digests, resource limits, and an immutable execution context. Required baseline digests
cannot be omitted. Conflicting inherited rules and schema pins fail instead of replacing baseline
declarations. Signed packages include all policy and custom-kind schema bodies.

General schema rules use the bounded draft-07 engine and normalized subjects, respect
selectors/prerequisites and preserve included-file locations. The CLI loads immutable
source/baseline/data snapshots or an original-deadline request, uses host catalog configuration and
credential environments, and emits JSON or SARIF with exits 0/1/2. Release expiry during execution
blocks required coverage and caps publication freshness. See [scope and usage](policy-cli.md).

Host filesystem/Git source capture, installation hierarchy and authority discovery, key/generation
refresh, hosted publication/recovery and real backend/IDE/OS qualification retain their separate
release gates.

Local qualification on 2026-11-05: all 44 added checks and the final full `npm run check` passed all
661 tests and required type/lint/format/schema/build checks with loopback access. CLI provider
integration passed both fake API pins. LSP schema repair passed both adapters. The built development
example passed, and SARIF shapes validated against the official OASIS schema.

Two intermittent existing provider/LSP cases from the first full run passed isolated checks and the
full repeat. Stronger test preconditions/diagnostics are retained. See the
[acceptance notes](policy-cli.md#local-qualification).

## Failure diagnostics and test isolation increment

Failure diagnostics now record safe stage, cause, and timing evidence for provider failures,
reference preparation, pipeline exceptions, and versioned LSP diagnostics. They distinguish attempt
and request timeouts, transport and response failures, future and expired observations, and
aggregate snapshot limits. Evidence has fixed limits and excludes raw errors, source contents,
credentials, and endpoints. Deadline admission uses a typed `RangeError` subclass. Existing limits,
freshness rejection, and enforcement remain unchanged.

The aggregate cache-budget proof uses controlled time and in-memory transport, with separate
real-HTTP cache reuse coverage. Native-only buffer recovery is separate from gated HTTP recovery.
Injected clock rollback tests preserve rejection of future observations and verify that admitted
monotonic budgets are not extended. See
[provider evidence](catalog-provider.md#safe-failure-evidence) and
[LSP recovery/evidence](lsp.md#failure-evidence-and-buffer-recovery). The original intermittent
causes remain unconfirmed. A broader clock architecture audit remains separate work.

Local qualification on 2026-11-07: the full `npm run check` passed all 672 tests (11 added checks)
and required type/lint/format/schema/build checks with loopback access. After final stage-label
refinements, static/schema/build checks were repeated and all 71 provider/reference/failure-evidence
checks passed. The focused stdio/native/HTTP recovery and early-exception run also passed.

## Saved-file refresh increment

Saved-file refresh captures only launcher-approved files under a pinned root and exact file and
entrypoint plan. It handles standard save and watched-file events, preserves open-buffer precedence,
and tracks additions, deletions, and restoration relative to the baseline. Reads check containment,
links, regular-file type, UTF-8, size, and observed changes. Read failures block stale validation
and retain safe filesystem evidence.

The original deadline includes disk I/O. Generation counters suppress old captures and HTTP results,
and shutdown awaits capture and file-handle cleanup. See
[saved-file setup and scope](lsp.md#saved-file-snapshot-refresh).

Directory discovery, hostile-writer OS confinement, atomic filesystem transactions, policy/authority
reload and actual backend/editor/OS qualification remain open. Version-safe fixes were the next
increment. Their implementation is recorded below.

Local qualification on 2026-11-07: the full regression check passed 693 tests and required
type/lint/format/schema/build checks. Final observed-mutation and watch refinements were verified by
all 22 refresh checks, including one additional mutation test, with repeated static/build/schema
verification. Stdio scenarios passed both native model pins and both fake API contracts. The
development filesystem launcher generator captured and pinned a real temporary file.

## Version-safe fixes increment

Implemented source-preserving scalar `const` repairs from unconditional direct schema properties,
with explicit provenance for structured inclusions. Opaque, single-use quick-fix commands recheck
the complete workspace epoch, open-buffer versions/digests, expiry and edit budgets before sending
versioned client edits. Closed-file, multi-file, overlapping, unversioned and unsupported edits are
rejected. A bounded client wait and one outstanding apply request prevent retries when the outcome
is unknown. Diagnostics change only after editor synchronization. See
[fix inventory, protocol and limitations](lsp.md#version-safe-scalar-fixes).

The server verifies fingerprints before dispatch. Standard LSP provides only the client's version
check after dispatch. Atomic post-dispatch digest/dependency conditions and version reuse during an
in-flight close/reopen are not guaranteed. Actual editor qualification remains open. Completion is
recorded below. Extension packaging remains IDE work.

Local qualification on 2026-11-07: `npm run check` passed all 774 tests, including 80 new
scalar/guard/stdio checks, with no failures or skips. Required type/lint/format/schema/build checks
passed. Both native model pins passed real stdio fix application and subsequent revalidation.
Freshness tests cover a shorter observation lifetime during wall-clock rollback. No actual editor or
additional OS support is claimed by the protocol fixtures.

## Responsive completion increment

Implemented declared-reference completion over native-qualified workspace and baseline snapshots,
plus bounded advisory catalog identity search. A separate cooperative source-index task keeps the
request path free of parsing, disk I/O, CEL and validation HTTP waits. Suggestions honor source
masks, kind/namespace defaults, arrays and exact UTF-16 scalar ranges, including structured
inclusions. Remote lookup waits are bounded, equal queries coalesce, stale work is cancelled, and
authority-scoped freshness caches stay within entry/byte limits. Search shares provider
admission/credentials/response bounds and uses fixed projections with bounded cursor pagination. See
[completion scope and protocol](lsp.md#responsive-reference-completion).

Both pinned API fixtures now validate the implemented identity-query parameters and projected
responses against their stored OpenAPI contracts. Suggestions are advisory. Standard completion
edits cannot enforce post-response buffer versions. Actual editor/backend/OS qualification,
cold-index resource/latency evidence, broader completion/search/history and extension packaging
remain open.

Local qualification on 2026-11-07: the full `npm run check` passed 813 tests, including 39 new
completion/search/stdio checks, with no failures or skips and all required
type/lint/format/schema/build checks. Both native pins and both API contracts passed stdio
completion. Held-query tests proved that typing, source invalidation, client cancellation and
shutdown continue while HTTP is pending. Warm completion over 1000 entities measured p95 0.188 ms
(20 samples after three warmups).

One 844151-byte / 1000-slot buffer request measured 2.927 ms. These measurements exclude cold index
preparation, validation, network and actual IDE integration. Extension packaging/installation
qualification is the next component.

## VS Code packaging and hosted qualification increment

The VS Code increment implements a native-target VSIX with the client, engine, production
dependencies, schemas, pinned Node runtime, licenses, and SBOM. An SBOM is a software bill of
materials. Trusted User Settings or the launcher environment select configuration. Workspace
settings cannot select authority. The client preserves configured file-URI spelling, tracks the
server process, and supports stop, restart, and standard language features.

The Actions workflow runs the entire source suite on Linux, Windows, and macOS. It checks coverage
and full and production dependencies, builds native VSIX packages, and runs the full suite with
packaged Node and server entry points. It also tests the installed extension on pinned minimum and
current VS Code versions. Skips fail CI. Reports and installable artifacts are retained. See
[workflow scope and evidence](github-actions.md).

Initial hosted qualification exposed Windows short-name URI encoding and an upstream glob advisory.
Both were corrected. Subsequent source harness/audit runs passed on all three OS families.
Package/editor qualification is recorded in each workflow's retained reports.

Consult that run for actual results. Local installed-VSIX testing exercises real diagnostics,
completion, fixes, saved-file watchers and process cleanup. Interactive UX/upgrade, JetBrains,
Marketplace publication and real-backend qualification remain release work.

## LSP ownership separation

Phases 0 through 9 are implemented and merged in [PR #2](https://github.com/chtaylo3/backstage-validation-engine/pull/2).
The tested head was `6938b8b85c1b5889af3fbe1119684de6577e5b45`. The merge commit was `d2e54748dbd34e9f1e881c2abf77689cf197b40f`.
The LSP now separates workspace mutation, validation scheduling, request context, diagnostic publication, and session resource ownership.
CLI catalog admission no longer depends on LSP configuration. The root SARIF API uses neutral reporting with a compatible CLI wrapper.
Native validators and editor schemas share pin admission while preserving independent presentation-schema failure behavior.
The architectural import gate covers domain/runtime boundaries, aliases, barrels, and ownership cycles.

Connection edit reservations survive reload and local timeout. Terminal shutdown cannot wait indefinitely for a silent client.
Session replacement has one activation commit point and closes abandoned resources and late registrations.
The process configuration watch remains live across invalid reloads. Credential watches retire with their session.
Each native operating system passed 989 source tests, 989 packaged tests, and 88 installed-editor cases.
Quick qualification passed 36 desktop compatibility/load cases and 12 real SSH, dev-container, and Windows WSL2 sessions.
The macOS qualification needed one isolated rerun after a native Trust UI timeout. Its original 87/88 result remains recorded.
See [the implementation record](lsp-separation-implementation-record.md#hosted-qualification-and-merge) for exact candidate digests, hosted runs, and remaining release limits.

## Editor authoring and workspace increment

Field-name and schema-value suggestions now use pinned native schemas, exact custom-kind artifacts,
and applicable schema policies. Recovery metadata supports unfinished edits without entering the
validation pipeline. Hover exposes descriptions and constraints. Definitions resolve unique local
entity targets. Explicit schema repairs and required-field placeholders use the existing versioned
fix registry. Qualified structured includes retain actual payload ranges.

VS Code adds catalog search and bounded persistent selection ranking. Host-approved discovery adds
matching files under pinned roots while retaining filesystem containment and read checks. The stdio
host reloads its fixed configuration and optional credential file without replacing its process.
Invalid reloads stop validation and suggestions until repair. Source scope changes that require new
client selectors require a reconnect. An LSP4IJ template generator supplies JetBrains setup.
See [editor features and boundaries](editor-features.md).

Automated coverage includes source ranges, unfinished YAML/JSON, both native pins, custom schemas,
policy prerequisites, structured includes, explicit repairs, discovery, search ranking, credential
rotation, reload failure/recovery, and shared stdio features. A new installed-VSIX case exercises
field/value suggestions, hover, definitions, and reload without replacing the server process.
At this earlier authoring checkpoint, the complete native platform matrix remained open.
The ownership separation later qualified the native VS Code matrix and real remote sessions described above.
Installed JetBrains qualification, Marketplace publication, and final release evidence remain separate release work.

Local development checks on 2026-11-09: `npm run check` and `npm run test:packaged` each passed
932 tests with no failures or skips. The installed-VSIX `editor-intelligence` case passed on
VS Code 1.106.3 and 1.145.2 on Linux x64. Initial GUI launches stopped before the test driver
because the host supplied `ELECTRON_RUN_AS_NODE=1`. Clearing that inherited flag allowed both
editor cases to execute. These development results do not qualify the complete release matrix.

The PR follow-up adds 15 client tests and corrects document selection after configuration reload.
Explicit file approval does not approve neighboring documents. Root matching uses path containment.
The source suite passes 947 tests. The separate client gate passes 42 tests with 100% line coverage
and 95.88% branch coverage. `npm run check` now enforces that gate too.

The [rule and editor capability plan](plugin-capabilities-plan.md) specifies the next contract work
for CEL, RE2, and approved providers. It defines shared lifecycle and result bindings, separate
interfaces for each editor function, candidate/repair evidence, runtime requirements, and PC-01
through PC-10 conformance gates. These proposed interfaces and general executable-plugin support
are not implemented by the current schema-focused editor increment.

The plan also specifies live catalog dependency refresh and PC-11 qualification. Cache expiry alone
does not currently revalidate idle editor buffers. Bounded background refresh, optional change
notifications, remote dependency generations, query/absence invalidation, and same-version
diagnostic publication remain required implementation work.

## Current editor implementation sequence

The [five-phase editor plan](lsp-editor-improvements-plan.md) is the authoritative delivery order.
Its [implementation record](lsp-editor-improvements-implementation-record.md) records phase evidence and parent acceptance.
Phase 1 updates documentation. Phase 2 implements capability contracts and adapts built-in providers.
Phase 3 adds live catalog refresh. Phase 4 adds CEL and RE2 editor contributions.
Phase 5 covers native Trust reliability, installed JetBrains qualification, and longer final-candidate release workloads. The user deferred phase 5.

Phases 2 through 4 remain unimplemented at this documentation checkpoint.
SQS, Kafka, the durable hosted controller, and authoritative GitHub publication remain outside this editor implementation.
Arbitrary executable plugin loading also remains outside phases 1 through 4.
The broader governed pilot and stable-release roadmap retain their separate authority and qualification requirements.

## Required release evidence

- Frozen corpus and managed-profile integration, including deadline/cancellation, queue pressure,
  fairness, shutdown, and recovery.
- BC acceptance per pinned adapter, with coverage and provenance for unsupported processing.
  Organization processor inventory remains empty until supplied.
- Locked installs, full and production dependency audits, release SBOM, and update ownership.
- Actual supported Node/OS and VS Code/JetBrains runtime/install qualification.
- Hosted process/container CPU/RSS/filesystem/network/credential confinement before enabling
  untrusted workloads or programmable plugins.
- An authorized GitHub/GHES installation demonstrating GV-01 through GV-06. Evidence must cover
  mandatory baseline authority, verified early bypass, freshness and generation safety, and crash
  recovery. It must also cover central Actions without per-repo workflows and authentic credentials
  and callbacks.
- Representative entity/repository/concurrency benchmarks, measured publication freshness within 60
  seconds, redacted telemetry, and operational recovery.

Kafka, SQS, both IDE families, governed plugins, and support matrices remain in stable-release
scope. Concrete installation/version access, workload dimensions, and team capacity are still needed
before calendar commitments.

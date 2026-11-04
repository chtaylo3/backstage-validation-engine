# Implementation status

## Foundation increment

Implemented in this repository:

- Strict TypeScript ESM library with declarations/source maps, pinned dependencies,
  Node tests, typed ESLint, Prettier, and CI configuration.
- Production contract 0.2 definitions, inferred types, generated draft-07 schemas,
  strict parsing, and immutable return types.
- Source/data snapshot creation, canonical hashing, integrity verification,
  open-buffer overlays, deletion records, and admission budgets.
- Distinct provider availability/freshness/authorization provenance.
- Bounded rule DAG validation, default deployment profile, pinned artifact checks,
  stable finding IDs, and fail-closed outcome/exit-code aggregation.
- Examples for pass, false rule, invalid policy, unsupported processor, catalog
  unavailable, timeout, and emergency bypass.

The historical planning repository records 331 comparison checks, 67 managed CEL
checks, and 84 Go differential checks. These are retained historical observations.
They have not been rerun against this foundation, which does not yet implement
the entity-validation engine. No production runtime or live-integration release
gate is claimed by these contracts.

## Managed CEL increment

The managed CEL/rules increment is also implemented: exact interpreter/RE2 pins,
two shared worker slots, global 64-job admission, request fairness, queue/execution/
startup deadlines, cancellation, awaited replacement, protocol validation, and
shutdown. `executeCelRules` connects managed selectors/expressions, pinned bindings,
the rule DAG, typed failures/coverage, and whole-request budgets. The 43-case
qualification corpus is copied verbatim and exercised through production workers.
See [runtime details and measurement](cel-runtime.md).

The [initial benchmark](evidence/cel-runtime-benchmark.md) records local p95 values
of 1.67 ms for one warm entity, 14.89 ms for 100 warm entities, and 2,649.13 ms for
fresh-process execution. The cold result exceeds the provisional 2,500 ms target;
startup profiling/packaging remains an open pilot performance gate.

## Source-preserving parsing increment

Implemented multi-file/document YAML 1.2 parsing with immutable source provenance,
UTF-16 JSON Pointer locations, alias provenance, strict CI withholding and
document-level IDE recovery. Syntax/alias/expansion/source budgets, safe numeric
normalization, duplicate/merge-key and unsupported tag/version rejection,
cancellation and deadline coverage are exercised by 48 parser checks. That
increment brought the local suite to 138 checks. See the [parsing acceptance register](parsing.md).

The [post-parser rules-stage capture](evidence/cel-runtime-after-parsing.md) records
p95 of 1.69 ms for one warm entity, 16.47 ms for 100 entities and 2,788.98 ms for a
fresh process. It excludes YAML execution; the cold-start target remains open.

## Native compatibility increment

Implemented and locally tested BC-01/BC-02 on catalog-model 1.10.2 and 1.7.5:
native envelopes/kinds, explicit native policy composition, immutable authored and
normalized entities, and source-attributed defaults. The parser/native pipeline
blocks unsupported processors and unresolved substitutions before dependent
checks. The native/source suites add 130 checks, bringing the local total to 268.
See [compatibility scope and acceptance](backstage-compatibility.md).

The optional group-parent default requires a pinned `groupDefaultParentRef` in
the pre-release deployment profile. Existing disabled configurations are unchanged.
Historical rules-stage benchmarks remain scoped evidence; integrated native
pipeline performance still needs qualification before pilot release.

## Versioned test-harness plumbing

Implemented numeric latest-patch selection for explicitly supported Backstage
major.minor lines across concurrent majors/minors, immutable package/spec pins,
offline OpenAPI artifact integrity verification, and concurrent fixture lifecycle
with isolated HTTP probe coverage and cleanup after partial startup. The convention
is to test only the latest stable patch in each supported minor. Synthetic matrix
tests prove multi-major selection independently of upstream releases. See
[harness design and acceptance](testing-harness.md).
All 28 new harness checks passed locally, bringing the suite to 296 tests; the
full `npm run check` passed with loopback socket access enabled for HTTP probes.

The subsequent catalog harness increment captures official Backstage 1.55.3 and
1.56.2 OpenAPI specs/licenses and exact package/source provenance. The fake now
validates the implemented full-entity single/batch lookup subset against those
specs, with scoped fixture identities, mutation controls, one-shot failures,
response gates, cancellation and isolated listeners. Release refresh and read-only
upstream drift commands are implemented; a separate weekly/manual drift workflow
is configured. Provider/source-reference integration is covered by subsequent
increments below; real-backend smoke tests remain open. Native adapter
support is unchanged.
The full `npm run check` passed locally with 325 tests, including 57 harness
checks. Hosted CI and real Backstage backend runs are not claimed.

## Production catalog provider increment

Implemented host-owned endpoints/credentials, typed observations, native reference/
envelope helpers on both pins, bounded HTTP batches/retries/cooldowns, FIFO
admission, cancellation/shutdown and scoped LRU caches. The adapter carries the
original deadline and returns contract-0.2 data snapshots for pinning before
evaluation. See [provider behavior and qualification](catalog-provider.md).
Qualified overlays and real-backend authentication/smoke qualification remain
open; catalog-rule bindings and LSP transport are implemented below.
All 31 new provider checks passed locally; the full `npm run check` passed 356
tests. The built provider example passed against the standalone fake API.

## Source references and catalog pinning increment

Implemented BC-03 on declared owner/API/system contexts: canonical native identity,
fixed/entity namespaces, escaped pointers, bounded array wildcards and attributed
findings. Reports retain occurrences, source digests/versions and identity claims.
The preparer verifies provider binding, collects eligible observations and pins
data under the original deadline. Local/invalid/unknown/deleted/competing guards
prevent fallback until BC-06 qualification. See [scope and acceptance](source-references.md).
Missing references remain data until an explicit organization rule consumes them.
All 31 new checks passed locally, including both native pins against both backend
fixtures. The full check passed 387 tests; reference-preparation and native/CEL
examples passed. The following increment implements policy bindings and stdio
transport. Full overlay, hosted CI and real IDE/backend qualification remain open.

## Catalog policies and stdio LSP increment

Implemented explicit pinned `catalog`/`exists` policy rules, context-selected
provider collection, source/normalized-subject/data integrity binding, precise
missing findings and incomplete dependency coverage. `validatePolicySources`
composes native/source checks and policy execution; `executeCelRules` remains an
alias for `executePolicyRules`. The frozen CEL environment/corpus is unchanged.

Implemented a launcher-configured stdio server with UTF-16 incremental edits,
open-buffer snapshots, cancellation, one active/latest queued request, epoch-based
stale suppression, versioned diagnostics and awaited shutdown. Official protocol/
text-document libraries are pinned; framing/buffer bounds and full-replacement
resynchronization are enforced. The subprocess client exercises the production
entry point against both pinned fake APIs. See [scope, setup and acceptance](lsp.md).

All 37 new policy/LSP checks passed locally; the full `npm run check` passed
424 tests, including the unchanged CEL corpus and EOF/unexpected-exit cleanup
regressions. Full and production dependency audits report zero vulnerabilities.
The development launcher generator and EOF smoke passed with empty protocol/error
output streams. Real backend/IDE runs, filesystem snapshot refresh and positive
local overlay qualification remain open.

## Snapshot-local substitutions increment

Implemented BC-04 `$text`, `$json`, `$yaml` and file Location discovery from the
immutable proposed snapshot. Optional pinned source roots and catalog entrypoints
separate entity inputs from payloads and participate in source digests/overlays.
Resolution enforces containment, cycles, depth and expansion budgets under the
original deadline/signal. Authored, resolved and normalized values remain separate;
included field ranges, digests, versions and use chains reach references/findings.
See [reader scope and acceptance](substitutions.md).

The stdio LSP revalidates included-buffer edits, projects findings to inclusion
sites, restores pinned bytes on close and suppresses stale catalog responses.
Remote/glob readers remain incomplete. Host filesystem capture, BC-05 admission,
BC-06 positive overlays and real editor/backend qualification remain open.

Local qualification on 2026-10-29: 56 substitution checks and five added LSP
checks passed. The full `npm run check` passed all 485 tests, type checking,
lint, formatting, generated-schema verification and the production build.

## Admission and custom-kind increment

Implemented BC-05 global/source kind admission after native normalization, with
additive exact-file/directory allowances pinned by the deployment profile. Denied
entities retain violation findings and identity guards while being withheld from
references, artifacts and policy evaluation.

Trusted `schema-artifact` bodies bind to exact custom kind/API-version profile
pins. Bounded synchronous draft-07 validation preserves native defaults without
coercion or schema mutation. Local bundled references and RE2 patterns are
supported; formats, external/cyclic references and asynchronous/custom extensions
are rejected. Stock kind validators cannot be overridden. Missing artifacts remain
incomplete. See [scope, examples and acceptance](admission-custom-kinds.md).

The LSP accepts launcher-owned schema artifacts and exercises denial, schema
failure/repair and missing-artifact warnings against both model/API pins. Positive
overlays, actual backend/editor runs, host snapshot refresh and complete processor
qualification remain open.

Local qualification on 2026-10-30: 60 admission/custom-schema checks and seven
added LSP checks passed. The full `npm run check` passed all 552 tests and required
type/lint/format/schema/build checks. The built custom-kind example passed; its
invalid-tier variant produced a completed schema violation with exit 1.

## Proposed catalog overlay increment

Implemented BC-06 qualified local precedence, invalid-replacement masks, explicit
canonical identity conflicts and baseline-relative deletion/rename handling.
Optional request baselines and result baseline digests pin previous input. Source
and baseline changes are checked before collection; source-derived data uses a
separate provider/key space and is verified against qualified reports during
policy binding. Existing remote denial/outage and original-deadline semantics
remain explicit. See [overlay scope and examples](proposed-overlays.md).

Conflict findings are emitted without an existence rule, and conflicted Location
children are withheld from artifacts/rule subjects. Diagnostic exhaustion is
typed resource interruption. The stdio LSP qualifies local buffers and supports
known-file delete/rename notifications using pinned bytes; epochs suppress stale
remote results. Host filesystem refresh, actual backend/editor/OS qualification
and complete deployment processor qualification remain open.

Local qualification on 2026-11-03: 32 overlay checks and nine added LSP checks
passed, including both native model and API pins. The full `npm run check` passed
all 593 tests and required type/lint/format/schema/build checks with loopback
access. The built overlay example passed for a local addition; confirmed deletion
returned a completed blocking violation with exit 1.

## Next increments, in order

1. **Engine and compatibility.** Complete BC-07
   processor blocking, extending the fixture-driven LSP loop for each behavior.
2. **Policy, providers, and CLI.** Verify immutable bundles/activation and resolve
   inherited mandatory baselines. Add schema rules, JSON/SARIF output and CLI exits.
3. **IDE path.** Refresh saved-file snapshots, add version-safe fixes, responsive
   completion and extension packaging, and qualify actual VS Code/JetBrains clients.
4. **Governed pilot.** Trusted hierarchy, one verified Git bypass provider,
   SQLite inbox/outbox/controller recovery, generation-aware direct/central
   Actions execution, and authoritative GitHub publication.

## Required release evidence

- Frozen corpus and managed-profile integration, including deadline/cancellation,
  queue pressure, fairness, shutdown, and recovery.
- BC acceptance per pinned adapter, with coverage and provenance for unsupported
  processing. Organization processor inventory remains empty until supplied.
- Locked installs, full and production dependency audits, release SBOM, and update
  ownership.
- Actual supported Node/OS and VS Code/JetBrains runtime/install qualification.
- Hosted process/container CPU/RSS/filesystem/network/credential confinement before
  enabling untrusted workloads or programmable plugins.
- An authorized GitHub/GHES installation demonstrating GV-01 through GV-06:
  mandatory baseline authority, verified early bypass, freshness/generation safety,
  crash recovery, central Actions without per-repo workflows, and credentials/
  callback authenticity.
- Representative entity/repository/concurrency benchmarks, measured publication
  freshness within 60 seconds, redacted telemetry, and operational recovery.

Kafka, SQS, both IDE families, governed plugins, and support matrices remain in
stable-release scope. Concrete installation/version access, workload dimensions,
and team capacity are still needed before calendar commitments.

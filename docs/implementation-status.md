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
is configured. Production provider/LSP integration and real-backend smoke tests
remain open. Native adapter support is unchanged.
The full `npm run check` passed locally with 325 tests, including 57 harness
checks. Hosted CI and real Backstage backend runs are not claimed.

## Next increments, in order

1. **Engine and compatibility.** Continue with BC-03: native contextual references,
   safe local substitutions, admission/custom kinds, proposed catalog overlays,
   and unsupported-processor blocking. Build the versioned catalog fake/provider
   test path alongside BC-03, then add thin LSP transport tests.
2. **Policy, providers, and CLI.** Verify immutable bundles/activation and resolve
   inherited mandatory baselines. Add schema rules, provider access with bounded
   retries/timeouts and authorization-aware caching, JSON/SARIF, and CLI exits.
3. **IDE path.** Cancellable async validation over workspace/open-buffer snapshots,
   stale-diagnostic suppression, version-safe fixes, responsive completion, and
   actual VS Code pilot qualification.
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

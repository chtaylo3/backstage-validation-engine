# Versioned Backstage test harness

## Accepted version convention

The test harness runs repeatable tests against controlled catalog fixtures. Support is declared as
explicit Backstage umbrella release major.minor lines. Multiple minors in multiple majors can be
active simultaneously. For each supported minor, tests select only its latest stable patch from the
checked-in release inventory.

Selection is numeric: `1.2.10` supersedes `1.2.9`. It never advances to another minor or major
automatically. Prereleases, build suffixes, ranges, `v` prefixes, leading zeroes and duplicate
inventory entries are rejected.

Backstage umbrella releases do not follow SemVer. Individual npm packages have independent versions
and a SemVer policy with exceptions. See the upstream
[versioning policy](https://backstage.io/docs/overview/versioning-policy/). This convention selects
umbrella patches. It does not derive backend or model package versions from those numbers. Each
inventory entry records both packages exactly.

## Test layout and runner

Every `*.test.ts` file lives in exactly one group directory, chosen by what the file mainly
exercises:

| Group             | Contents                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `test/engine/`    | Engine layers from `base` to `host`, and `protocol`                                            |
| `test/lsp/`       | Language server and editor service                                                             |
| `test/cli/`       | CLI and CLI candidate                                                                          |
| `test/extension/` | VS Code client and extension tooling                                                           |
| `test/tooling/`   | Import policy, public API, harness evidence, fixture refresh, release harness and script tests |

`test/harness/`, `test/fixtures/`, and `test/integration/` hold support code and data, not test
files. `scripts/test.mjs` discovers the compiled `*.test.js` files recursively under
`.test-dist/test/<group>/`. `--group <name>` (repeatable) runs only the named groups; without it,
every group runs. An unknown group, a group without test files, or a test file outside the group
directories is an error. `npm run test:lsp` runs `engine` and `lsp`; `npm run test:harness` runs
`engine`, `lsp`, and `tooling`.

The `engine` group runs in one `node --test` invocation with `--test-concurrency` set to the smaller
of 4 and the available parallelism. Every other file runs in a second invocation, one file at a time.
The serial list in `scripts/test-selection.mjs` keeps named files serial even when their group runs
in parallel, each with its reason; an entry that names a missing file fails the run, and an entry
whose group is not parallel in the current run changes nothing. The engine group passed five
consecutive parallel runs on Linux with that list (WSL2, 20 logical CPUs, Node 24). Windows and
macOS concurrency is not separately proven.

A test that does real work against a real-time deadline belongs in the serial list, because the
deadline is part of what the test proves. The first parallel CI run on the 4-CPU Windows runners
showed two such files, and both are now in the list: `default-boundaries` parses the largest
admitted documents inside the 5-second default request deadline, and `rule-contributions` needs a
completion answer inside the 50 ms synchronous editor budget. Their deadlines and assertions are
unchanged. Both failures reproduce on Linux when every CPU is busy.

`BVE_TEST_PARALLEL_GROUPS` (comma-separated group names) replaces the default parallel groups for
one run; an unknown name is an error, and an empty value means the default. With
`BVE_TEST_PARALLEL_GROUPS=engine,lsp`, the full `npm test` passed five consecutive runs on the same
Linux host, with `lsp-catalog-refresh` and `lsp-rule-contributions` in the serial list for their
250 ms freshness windows: 85.7, 81.0, 86.0, 85.4 and 83.7 seconds wall time, against about 124
seconds with the default (`engine` only) and 142 seconds with every file serial. This switch is an
opt-in and is proven on Linux only; CI does not set it. Enabling it in CI is a deliberate later
step that needs the same proof on the Windows and macOS runners. `BVE_TEST_CONCURRENCY=1` runs every
file in one serial
invocation; another positive integer sets the parallel concurrency. `--coverage` always runs one
serial invocation, so that `lcov.info` comes from a single run.

A run of every group, with or without explicit `--group` flags, writes its reports to
`.artifacts/tests/<source|packaged|coverage>/`. A run of a strict subset of the groups writes to a
directory named after the mode and the groups in group order, for example
`.artifacts/tests/source--engine+lsp/` for `npm run test:lsp`, so a partial run never replaces the
full-run evidence that CI uploads. `summary.jsonl` holds the per-file
summaries of both invocations followed by one merged total. `junit.xml` holds one `<testsuites>`
element with the merged counts. `inventory.json` keeps its fields; `files` lists every file that
ran, and `invocations` lists the files and concurrency of each invocation. With `CI` set, a skipped
test fails the run.

## Implemented plumbing

- `test/harness/version-matrix.ts`: `createFixtureMatrix` selects one target per supported minor,
  sorted numerically by major/minor. Metadata is copied/frozen. Unsupported lines are excluded. A
  missing supported line fails configuration.
- `test/harness/contract-artifact.ts`: loads a local OpenAPI artifact and verifies its exact SHA-256
  before use. Absolute paths, parent traversal and symlinks escaping the artifact root are rejected.
  No network is used in test execution.
- `test/harness/fixture-matrix.ts`: verifies all contracts before starting any fixtures, starts
  targets concurrently, and associates each fixture with its exact target. Partial startup waits for
  all in-flight starts and cleans all successful handles. Shutdown attempts every cleanup and is
  idempotent, including after cleanup failure. A factory must clean resources acquired before it
  rejects.
- `test/harness/pinned-matrix.ts`: validates the inventory and requires it to materialize exactly
  the latest observed patches. Changing `support.json` without refreshing the inventory fails
  instead of silently running the old support set.
- `test/harness/catalog-contract.ts`: extracts and compiles the implemented OpenAPI 3.1 operations'
  JSON Schema fragments with Ajv 2020-12. It covers local references, path inputs, JSON bodies, and
  normal and error responses. Unsupported dialects/references and required unsupported parameters
  fail during setup.
- `test/harness/fake-backstage.ts`: isolated localhost catalog reads, fixture principals, local
  state controls, failure injection and deterministic response gates. Entity inserts must satisfy
  the selected pinned envelope schema.
- `test/harness/release-refresh.ts`: complete paginated stable-release discovery, latest-patch
  selection, annotated/lightweight tag resolution, immutable upstream package/spec/license capture,
  manifest-last publication and drift comparison.

The server factory receives immutable contract text for its selected target. It owns the parsed and
compiled contract, initial catalog, permission state, request log, response gates, and temporary
localhost listener. Do not share mutable state or a global "active version" between targets.
Client/provider caches must also distinguish target endpoint, connection and authorization scope.

Synthetic lifecycle tests continue to prove concurrent majors and multiple minors without depending
on upstream publishing a particular major. The catalog HTTP tests also run against these fake targets with
pinned captured API contracts:

| Backstage release | Catalog backend package | Catalog model package | Upstream source commit                     |
| ----------------- | ----------------------- | --------------------- | ------------------------------------------ |
| 1.55.3            | 4.0.0                   | 1.10.1                | `6c66969256572989ed10ee862b26065a0980c0bd` |
| 1.56.3            | 4.0.2                   | 1.10.2                | `7e29caf1d87edb3c51bd07f85d0f7f8c4f0a33c0` |

These are the latest observed patches of the initial `1.55`/`1.56` fixture minor lines, selected
from the official release index. Both specs currently have SHA-256
`cf26233702b7e9a356ad00edc75b52b57cfc9fad72d39de3d5f37c23a8900719`. Their byte-for-byte equality
does not imply identical backend behavior. Specs and Apache-2.0 licenses are vendored under
`test/fixtures/backstage/<version>/<commit>/`.

Git attributes and formatter exclusions preserve the spec bytes on all platforms. Hosted drift
qualification on 2026-11-07 discovered 1.56.3. Its OpenAPI and license bytes match the previous
1.56.2 capture, and its model/backend package versions are unchanged. The inventory now selects
1.56.3. Older bytes remain historical evidence and are not additional active fixture targets.

Fixture targets describe fake API-contract coverage. They do not execute deployed Backstage backends.
The [H4 record](test-harness-remediation-record.md#h4-catalog-compatibility-and-convergence) records later focused actual-backend controls for both targets. Recorded catalog-model package versions describe the captured deployment. The fake uses the
installed native reference helper to canonicalize kind, namespace, and name. It does not run each
deployment's native policies or processors. The production native-validation adapters remain
separately pinned to 1.10.2 and 1.7.5.

Local qualification on 2026-10-28: all 57 harness checks passed within the full `npm run check`,
which passed 325 tests. This includes 28 earlier matrix/lifecycle checks and 29
catalog-contract/HTTP/refresh checks. HTTP fixtures bind `127.0.0.1` on OS-assigned ports. The
execution environment must allow loopback listeners. In a restricted sandbox, run with authorized
local socket access. Normal local runs require no fixed port configuration.

The 2026-10-29 production-provider increment adds 31 checks to `test:harness`, for 88
harness/provider checks. The full project check passed 356 tests. The provider example passed
against the standalone fixture server. Actual-backend execution was open at that dated checkpoint.

The source-reference/preparation increment adds 31 checks to `test:harness`, for 119
harness/integration checks. The full project check passed 387 tests, and the new source-reference
example passed against the standalone fixture server.

## Inventory shape and use

The TypeScript API accepts this shape (illustrative version numbers only):

```ts
const targets = createFixtureMatrix({
  supportedMinors: ['1.2', '1.4', '2.1'],
  releases: [
    {
      backstageVersion: '1.2.10',
      catalogBackendVersion: '7.8.9',
      catalogModelVersion: '3.2.1',
      sourceCommit: '<40 lowercase hexadecimal characters>',
      openApi: {
        path: '1.2.10/openapi.yaml',
        sha256: '<64 lowercase hexadecimal characters>',
      },
    },
    // Include stable release records for the other supported lines as well.
  ],
});

const matrix = await startFixtureMatrix(targets, artifactRoot, startFakeBackstage);
try {
  // Each entry has its own target metadata and running fixture handle.
  await Promise.all(matrix.fixtures.map(({ target, fixture }) => runScenario(target, fixture)));
} finally {
  await matrix.close();
}
```

For actual fixtures, load the verified targets with `loadPinnedMatrix(artifactRoot)` instead of
constructing illustrative records. `startFakeBackstage(artifact, options)` accepts `entities` and
`principals`. Each principal has a fixture `token`, a `principalId`, `canRead`, and `visibleRefs`
(canonical refs or `'*'`). `runScenario` above stands for the calling test. All harness APIs are
test support, excluded from the published library build. Run them with `npm run test:harness`, or
include them in `npm run check`.

## Catalog subset and scenario controls

- `GET /api/catalog/entities/by-name/{kind}/{namespace}/{name}` returns a full entity or a 404 for
  absence from the principal's authorized view.
- `POST /api/catalog/entities/by-refs` accepts `entityRefs`, preserves order and duplicates, and
  returns `null` for absent or hidden entities.
- Missing or invalid bearer credentials produce 401. Explicit plugin denial (`canAccessCatalog: false`) produces 403.
  Permission filtering (`canRead: false`) returns authorized-view absence: by-name 404, batch nulls, and empty query items.
  These are controlled fixture identities, not real Backstage token issuance or permission-policy
  verification.
- `GET /api/catalog/entities/by-query` implements the completion path with fixed kind/namespace filters and name-text matching.
  It requires the fixed identity projection and supports bounded limits with opaque, principal-scoped cursors.
  Broader predicates, arbitrary projections, and unsupported query parameters return 501.
  The fake admits only the declared subset of the captured OpenAPI contract.
- JSON requests have a 64 KiB limit. The fake checks input schemas, references, and content type.
  Each server configures five-second body/header receipt timeouts and permits 64 connections.
- `upsert`, `remove`, `setPrincipal` and `revokeToken` are in-process controls. There are no HTTP
  administration routes. Inserted JSON is copied and frozen.
- `failNext(match, fault)` injects one matching status failure, malformed JSON or a disconnect.
  Provider tests also use 302/404, Retry-After/location headers and explicit `invalid-body`
  payloads. Malformed JSON/invalid bodies bypass the normal response-schema guard only as declared
  faults.
- `holdNext(match)` returns `entered`, `cancelled`, and `release()`. It captures the response before
  it waits. An old catalog snapshot can then arrive after a new request without sleeps. Cancellation
  and shutdown release held handlers.
- `requests()` returns immutable log snapshots with principal IDs and outcomes, excluding bearer
  tokens. `assertHealthy()` surfaces internal/schema failures.

Tests cover request and response schemas and HTTP behavior for both fake captured-contract targets. They also cover
authorized-view absence, credential changes, malformed inputs, state isolation, one-shot fault
recovery, cancellation, out-of-order delivery, and repeated cleanup. Changing an upstream required
entity field is exercised as a startup failure.

## Manual development

```bash
npm run fixtures:serve          # all configured minor lines
npm run fixtures:serve -- 1.56  # one minor, at its pinned latest patch
```

The command prints each catalog base URL and the development fixture credential
`Authorization: Bearer development-only-token`. It seeds the existing eight-kind entity corpus. For
example, request `/entities/by-name/group/default/team` relative to the printed base URL. Ctrl+C
shuts down all listeners. The development token has read access to the fixture catalog only.

## Updating the latest patch

"Latest" means latest stable patch in the pinned inventory. Normal tests cannot establish whether a
newer upstream patch exists without a separate refresh. Run `npm run fixtures:refresh` to:

1. Discover the complete stable release list for every supported minor.
2. Resolve exact catalog-backend/catalog-model package versions from each selected release's
   manifests and record the immutable upstream commit.
3. Capture the matching upstream
   [catalog OpenAPI artifact](https://github.com/backstage/backstage/blob/master/plugins/catalog-backend/src/schema/openapi.yaml)
   verbatim, preserving its license, and record its checksum. `openapi: 3.1.0` describes the
   specification format. `info.version` alone is not an artifact pin.
4. Publish the local inventory after all artifacts are available. Existing files under an immutable
   version/commit are accepted only when their bytes match.

Then review contract diffs and rerun applicable fake/provider/LSP scenarios and real-backend smoke
tests before committing inventory and artifacts together. Refresh requires network access. Ordinary
test execution stays offline.

`npm run fixtures:check-upstream` performs the same discovery/capture in memory and fails on
version, package, source or spec drift without updating pinned files. Capture timestamps and
ordering alone do not count as drift. The separate `Backstage API drift` workflow is configured for
weekly/manual checks with read-only repository permissions. It has not been run on hosted CI from
this checkout, and creates no commits or pull requests.

If the inventory identifies a newer patch whose artifact is missing or has a bad checksum, startup
fails. It does not silently fall back to an older patch. Adding or retiring a supported minor is a
separate explicit support-policy change.

## Remaining work and acceptance

- Catalog identity search now covers the completion path's fixed kind/namespace and name-text
  filters, identity projection and opaque cursor pagination on both pinned contracts. Broader
  predicates, arbitrary projections, ordering and search UI remain outside this subset. See
  [completion acceptance](lsp.md#responsive-reference-completion).
- The [production provider](catalog-provider.md) is tested against the fixtures for availability,
  identity, deadlines/cancellation, retry/cooldown limits and scoped caches. The
  [reference preparer](source-references.md) exercises both native pins against both fixtures.
  Explicit catalog rule bindings and stdio integration are implemented, including qualified proposed
  overlays and baseline-relative masks.
- The [production LSP](lsp.md) now has a subprocess stdio test client covering versioned
  diagnostics, cancellation, close/reopen, UTF-16 edits, buffer limits and shutdown against pinned
  fixtures. Actual editor qualification remains open.
- H4 executes 22 focused controls per actual backend at source `60e9ac4031908127400cd6a8b9debadb5a286e90`.
  Its CLI archive SHA-256 is `0feeb3eb31506c617c72985ccf97f024ab2138b529eaa6461745b04a05fed076`.
  Neither fake probes nor the two native adapters qualify the final remediation candidate against actual backends.

The fake/provider/reference/LSP loop is implemented. Extend it alongside complete BC-07 processing
qualification. BC-04 substitutions, BC-05 admission/custom schemas, BC-06 overlays and their LSP
scenarios are implemented. This does not establish full ingestion or real-backend compatibility.

## Current evidence boundaries

The native adapter pins are 1.7.5 and 1.10.2. They are independent from umbrella releases 1.55.3 and 1.56.3.
The corresponding backend packages are 4.0.0 and 4.0.2. Their catalog-model packages are 1.10.1 and 1.10.2.
Version-sensitive provider batching, authorization, rotation, response admission, retry, and cooldown controls exercise both fake targets.
Generic clock, transport, and resource controls retain their declared scope without duplicate version claims.

Run `node scripts/qualification-inventory.mjs` from a clean checkout to print the exact revision and declared counts.
This command reads the actual installed selector and versioned Backstage inventories. It performs no qualification execution.
The current inventories contain 58 installed modules, with 50 in the ordinary portable selector.
The Backstage inventory declares 47 cases: nine environment, 16 CLI, 12 editor, and ten runner cases.
Two editor versions expand that inventory to 59 cases per backend and 118 across both backends.
H4's focused 22 controls per backend are a separate inventory and candidate.

H5 selects 30 installed cases per editor on Linux x64. Its 60 unique combinations pass across 62 attempts.
The two original X display failures remain failed. H5 does not qualify all 50 current portable cases or another platform.
The historical cross-OS baseline contains 44 portable cases, or 88 case/version executions per OS.
The later Linux baseline contains 46 portable cases, or 92 executions. Those records retain their own exact candidates.
See [current VS Code scope](vscode-qualification.md#versioned-inventories-and-execution-scope) for attribution.

`test/fixtures/backstage-evidence-controls.json` records independent inventory and identity expectations.
Its metadata labels synthetic verifier controls. These controls never count as executed release qualification.
A loader-omission mutation demonstrates that this independent record detects a dropped case that a self-derived fixture accepts.
The controls also reject wrong editors, wrong SQLite drivers, empty matrices, missing or duplicate cases, and incorrect counts.

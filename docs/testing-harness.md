# Versioned Backstage test harness

## Accepted version convention

Support is declared as explicit Backstage umbrella release **major.minor** lines.
Multiple minors in multiple majors can be active simultaneously. For each supported
minor, tests select **only its latest stable patch** from the checked-in release
inventory. Selection is numeric: `1.2.10` supersedes `1.2.9`. It never advances to
another minor or major automatically. Prereleases, build suffixes, ranges, `v`
prefixes, leading zeroes and duplicate inventory entries are rejected.

Backstage umbrella releases do not follow SemVer; individual npm packages have
independent versions and a SemVer policy with exceptions. See the upstream
[versioning policy](https://backstage.io/docs/overview/versioning-policy/).
This convention selects umbrella patches; it does not infer backend/model package
versions from those numbers. Each inventory entry records both packages exactly.

## Implemented plumbing

- `test/harness/version-matrix.ts`: `createFixtureMatrix` selects one target per
  supported minor, sorted numerically by major/minor. Metadata is copied/frozen.
  Unsupported lines are excluded; a missing supported line fails configuration.
- `test/harness/contract-artifact.ts`: loads a local OpenAPI artifact and verifies
  its exact SHA-256 before use. Absolute paths, parent traversal and symlinks
  escaping the artifact root are rejected. No network is used in test execution.
- `test/harness/fixture-matrix.ts`: verifies all contracts before starting any
  fixtures, starts targets concurrently, and associates each fixture with its
  exact target. Partial startup waits for all in-flight starts and cleans all
  successful handles. Shutdown attempts every cleanup and is idempotent, including
  after cleanup failure. A factory must clean resources acquired before it rejects.
- `test/harness/pinned-matrix.ts`: validates the inventory and requires it to
  materialize exactly the latest observed patches. Changing `support.json` without
  refreshing the inventory fails instead of silently running the old support set.
- `test/harness/catalog-contract.ts`: extracts and compiles the implemented
  OpenAPI 3.1 operations' JSON Schema fragments with Ajv 2020-12, including local
  references, path inputs, JSON bodies and normal/error responses. Unsupported
  dialects/references and required unsupported parameters fail during setup.
- `test/harness/fake-backstage.ts`: isolated localhost catalog reads, fixture
  principals, local state controls, failure injection and deterministic response
  gates. Entity inserts must satisfy the selected pinned envelope schema.
- `test/harness/release-refresh.ts`: complete paginated stable-release discovery,
  latest-patch selection, annotated/lightweight tag resolution, immutable upstream
  package/spec/license capture, manifest-last publication and drift comparison.

The server factory receives immutable contract text for its selected target and
owns its parsed/compiled contract, seed catalog, permission state, request log,
response gates, and ephemeral localhost listener. No mutable state or global
"active version" should be shared between targets. Client/provider caches must
also distinguish target endpoint, connection and authorization scope.

Synthetic lifecycle tests continue to prove concurrent majors and multiple minors
without depending on upstream publishing a particular major. The catalog HTTP
tests also run against these real, pinned fixture targets:

| Backstage release | Catalog backend package | Catalog model package | Upstream source commit                     |
| ----------------- | ----------------------- | --------------------- | ------------------------------------------ |
| 1.55.3            | 4.0.0                   | 1.10.1                | `6c66969256572989ed10ee862b26065a0980c0bd` |
| 1.56.2            | 4.0.2                   | 1.10.2                | `1e85ac7e08f276f49604202fd7245e0ad0aa63af` |

These are the latest observed patches of the initial `1.55`/`1.56` fixture minor
lines, selected from the official release index. Both specs currently have SHA-256
`cf26233702b7e9a356ad00edc75b52b57cfc9fad72d39de3d5f37c23a8900719`.
Their byte-for-byte equality does not imply identical backend behavior. Specs and
Apache-2.0 licenses are vendored under `test/fixtures/backstage/<version>/<commit>/`.
Git attributes and formatter exclusions preserve the spec bytes on all platforms.

Fixture targets describe wire-contract coverage. Real deployed backend smoke
qualification remains open. Recorded catalog-model package versions are provenance;
the fake uses the installed native reference helper for triplet canonicalization
and does not execute each deployment's native policies/processors. The production
native-validation adapters remain separately pinned to 1.10.2 and 1.7.5.

Local qualification on 2026-10-28: all 57 harness checks passed within the full
`npm run check`, which passed 325 tests. This includes 28 earlier matrix/lifecycle
checks and 29 catalog-contract/HTTP/refresh checks. HTTP fixtures bind `127.0.0.1` on OS-assigned
ports. The execution environment must allow loopback listeners; in a restricted
sandbox, run with authorized local socket access. Normal local runs require no
fixed port configuration.

The 2026-10-29 production-provider increment adds 31 checks to `test:harness`, for
88 harness/provider checks. The full project check passed 356 tests. The provider
example passed against the standalone fixture server; real-backend runs remain open.

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

For actual fixtures, load the verified targets with `loadPinnedMatrix(artifactRoot)`
instead of constructing illustrative records. `startFakeBackstage(artifact, options)`
accepts `entities` and `principals`. Each principal has a fixture `token`, a
`principalId`, `canRead`, and `visibleRefs` (canonical refs or `'*'`). `runScenario`
above stands for the calling test. All harness APIs are test support, excluded
from the published library build. Run them with `npm run test:harness`, or include
them in `npm run check`.

## Catalog subset and scenario controls

- `GET /api/catalog/entities/by-name/{kind}/{namespace}/{name}` returns a full
  entity or a 404 for absence from the principal's authorized view.
- `POST /api/catalog/entities/by-refs` accepts `entityRefs`, preserves order and
  duplicates, and returns `null` for absent or hidden entities.
- Missing/invalid bearer credentials produce 401; a principal with catalog reads
  denied produces 403. These are controlled fixture identities, not real Backstage
  token issuance or permission-policy verification.
- Query parameters, projections (`fields`) and predicate queries are outside the
  implemented subset and explicitly return 501. `/entities/by-query` is not
  implemented yet. The fake does not silently ignore a requested capability.
- JSON requests are bounded to 64 KiB; input schemas/references/content type are
  checked. Each server configures five-second body/header receipt timeouts and
  permits 64 connections.
- `upsert`, `remove`, `setPrincipal` and `revokeToken` are in-process controls.
  There are no HTTP administration routes. Inserted JSON is copied and frozen.
- `failNext(match, fault)` injects one matching status failure, malformed JSON or a
  disconnect. Provider tests also use 302/404, Retry-After/location headers and
  explicit `invalid-body` payloads. Malformed JSON/invalid bodies bypass the normal
  response-schema guard only as declared faults.
- `holdNext(match)` returns `entered`, `cancelled`, and `release()`. It captures the
  response before waiting, allowing an old catalog snapshot to arrive after a new
  request without sleeps. Cancellation and shutdown release held handlers.
- `requests()` returns immutable log snapshots with principal IDs and outcomes,
  excluding bearer tokens. `assertHealthy()` surfaces internal/schema failures.

Tests cover both real targets' request/response schemas and HTTP behavior,
authorized-view absence, credential changes, malformed inputs, state isolation,
one-shot fault recovery, cancellation, out-of-order delivery and idempotent cleanup.
Changing an upstream required entity field is exercised as a startup failure.

## Manual development

```bash
npm run fixtures:serve          # all configured minor lines
npm run fixtures:serve -- 1.56  # one minor, at its pinned latest patch
```

The command prints each catalog base URL and the development fixture credential
`Authorization: Bearer development-only-token`. It seeds the existing eight-kind
entity corpus; for example, request `/entities/by-name/group/default/team` relative
to the printed base URL. Ctrl+C shuts down all listeners. The development token
has read access to the fixture catalog only.

## Updating the latest patch

"Latest" means latest stable patch in the pinned inventory. Normal tests cannot
establish whether a newer upstream patch exists without a separate refresh.
Run `npm run fixtures:refresh` to:

1. Discover the complete stable release list for every supported minor.
2. Resolve exact catalog-backend/catalog-model package versions from each selected
   release's manifests and record the immutable upstream commit.
3. Capture the matching upstream
   [catalog OpenAPI artifact](https://github.com/backstage/backstage/blob/master/plugins/catalog-backend/src/schema/openapi.yaml)
   verbatim, preserving its license, and record its checksum. `openapi: 3.1.0`
   describes the specification format; `info.version` alone is not an artifact pin.
4. Publish the local inventory after all artifacts are available. Existing files
   under an immutable version/commit are accepted only when their bytes match.

Then review contract diffs and rerun applicable fake/provider/LSP scenarios and
real-backend smoke tests before committing inventory and artifacts together.
Refresh requires network access; ordinary test execution stays offline.

`npm run fixtures:check-upstream` performs the same discovery/capture in memory
and fails on version, package, source or spec drift without updating pinned files.
Capture timestamps and ordering alone do not count as drift. The separate
`Backstage API drift` workflow is configured for weekly/manual checks with
read-only repository permissions. It has not been run on hosted CI from this
checkout, and creates no commits or pull requests.

If the inventory identifies a newer patch whose artifact is missing or has a bad
checksum, startup fails. It never silently falls back to an older patch. Adding
or retiring a supported minor is a separate explicit support-policy change.

## Remaining work and acceptance

- Add catalog search/pagination and projections when the production provider or
  completion path needs them, with version-specific semantic fixtures.
- The [production provider](catalog-provider.md) is tested against the fixtures for
  availability, identity, deadlines/cancellation, retry/cooldown limits and scoped
  caches. Source-reference, overlay and rule bindings remain to be composed.
- Production LSP stdio client/server integration and diagnostics race tests.
- Smoke tests against real pinned Backstage backends. Neither fake probes nor the
  two existing catalog-model adapters establish deployed backend compatibility.

Build the fake/provider path alongside BC-03 contextual reference work, followed
by a thin LSP path. This harness work does not close any BC-03 through BC-06 gate.

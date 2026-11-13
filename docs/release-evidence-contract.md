# Release evidence checks

The host runner owns target orchestration, durable case rows, cleanup, and the final exit status.
`runHostTarget` uses the same path for production environments and controlled subprocess failures.
Only its environment operations change in the no-Docker controls.
A successful child without its target report fails the host run.
Failed builds, failed or interrupted children, incomplete rows, and failed cleanup cannot pass the aggregate verdict.
Log collection failure still permits an attempt to remove owned resources.

`node scripts/backstage-runner-controls.mjs <fault> <scratch-directory>` runs one isolated host control.
The declared faults are `missing-report`, `build-failure`, `cleanup-failure`, `interrupted-child`, `failed-child`, and `unfinished-report`.
`none` is the positive control. Fault targets exit 1. The containing control succeeds only after checking that failure.
Scratch reports carry `fixtureOnly: true`. They do not count as release inventory or backend qualification.
Native crash verification also records scratch `evidence.run` rows for the entered editor and subsequent successful editor case.
The real-backend crash driver retains raw child progress. The host classifies the thrown crash and records process cleanup separately.

## CLI variants and coverage parity

Each scenario selects its expected output before reading the CLI response.
Normal JSON must satisfy `validation-result`, use CI mode, enforce CI behavior, and agree with the subprocess exit.
Source, policy, profile, activation, installation, and repository identities must match independently selected fixture inputs.
Missing credentials and invalid source snapshots use the existing explicit input/configuration error envelope and exit 2.
Those errors legitimately lack validation provenance. Build revision and digest remain artifact metadata.
SARIF scenarios retain their separate SARIF envelope checks. This work does not replace independent schema qualification in H3.

The trusted launcher can enable the additive, read-only `bve/validationCoverage` request with `coverageObservation: true`.
It defaults to disabled. Initialization options, source documents, and workspace settings cannot enable it.
The request takes `{uri, version, digest}`. It returns `null` unless those values identify a current approved open document.
The response contains document identities, aggregate source digest, policy/profile/activation digests, validation generation, dependency generation, and complete coverage records.
Edits, reloads, close, and dependency invalidation revoke old observations. Unavailable sessions return `null`.
The installed extension exposes the same request through its trusted, read-only `coverage` API.
The response contains no credentials, connection configuration, catalog bodies, or execution controls.
Existing LSP clients require no change. Callers that use the projection must tolerate `null` and older servers without the method.

CLI and editor source snapshots can have different aggregate digests because buffers add origin, version, and change records.
Each observation binds to its own actual snapshot and the same authored document bytes.
Only one coverage normalization is permitted: the CLI must contain exactly one verified, required `policy/signed-release` record.
The CLI authenticates that release. The LSP receives an already approved launcher policy and does not perform that operation.
Parity removes that exact CLI authority record, then compares every other complete coverage record without dropping required rows or reasons.
An unrelated failing rule remains present in the paired application test.

## Packaged payload policy

The VSIX inspector admits declared extension metadata, bundled client/runtime files, compiled server output, schemas, and production dependencies.
Dependency paths derive from the host's root immutable lockfile, not archive-supplied declarations.
The archived server lock must match that host lock. Required `@backstage/catalog-model` and its runtime dependencies remain permitted.
The only declared lock exceptions are `extension/server/package-lock.json` and npm's `extension/server/node_modules/.package-lock.json` metadata.
Other lockfiles, seeds, database files, credentials, backend applications, and unrelated dependencies fail at every depth.
The inspector rejects duplicate entries, traversal, absolute paths, noncanonical separators, and mismatched local/directory names.
Crafted fixtures test both entry orders. The normal packaged candidate remains a required positive control.

## Raw metric verdict

The release verdict reads resource metrics for both load sizes and each required soak.
The saturation case uses its separate capacity observations. It does not produce a latency report.
Reports must contain finite ordered resource samples, raw edit/completion/restart latencies, matching percentiles, and the host-approved budgets.
The verdict recomputes percentiles, retained RSS growth, handle growth, and applicable slope limits independently of workload exit status.
Current limits remain 20,000 ms for cold readiness and each latency percentile, 128 MiB retained growth per side, 64 handles, and 0.15 MiB per operation.
These are retained growth limits, not an absolute RSS ceiling.
Each process receives ten warmup operations. The existing additional quarter-sample exclusion remains unchanged.
A required soak slope needs at least three retained samples and a span of at least 100 operations in a live process generation.
A 60-operation load run checks latency and retained growth. It cannot qualify the required soak slope.
H5 owns the later budget rationale and measurement-window review. Historical reports without raw latencies cannot satisfy this revised verdict.

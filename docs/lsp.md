# Catalog policies and language server

`validatePolicySources` composes source/native validation, policy-selected catalog
observations and the rule DAG. `executePolicyRules` is the lower-level rules-stage
API; `executeCelRules` remains a compatible alias. This is scoped validation,
without a claim of complete Backstage ingestion or verified policy authority.

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

`referencePath` must exactly match a declared deployment reference context,
including any array wildcard. Bindings are checked before HTTP. Only paths used by
catalog rules are collected by the composition API; CEL/native-only policies
perform no catalog I/O. The standalone reference preparer still collects all
declared contexts unless its optional `referencePaths` selects a subset.

Facts bind to the exact pinned request, source digest/version, qualified normalized
subject, profile and data entries. Occurrences are extracted again from the
qualified subject; altered observation payloads cannot replace pinned data.
Native reference locations and alias provenance reach findings. A missing
authorized-view observation fails the explicit rule. Blocked, expired or
unavailable observations make the rule incomplete, with a dependency finding.
IDE dependency findings are warnings; mandatory CI dependencies block with exit
2 through the result aggregator. Confirmed missing mandatory references produce
exit 1. An absent optional field or empty array is not applicable; require a field
with a separate presence rule when needed. DAG prerequisites must pass.

This adds a rule kind to pre-release contract 0.2 and requires an updated policy
consumer. The frozen `bve-cel/1` environment, interpreter, worker protocol and
qualification corpus are unchanged. Catalog access is outside CEL evaluation.

## Launching the stdio server

The `bve-lsp` executable, or `node dist/lsp/stdio.js`, accepts exactly
`--config <trusted-config.json>`. Build first. An editor should launch the Node
entry point directly so npm/build output does not enter the protocol stream.

For a development fixture:

```bash
npm run build
npm run fixtures:serve -- 1.56
# In another terminal, substitute the numeric port printed above:
node examples/create-lsp-config.mjs http://127.0.0.1:PORT/api/catalog /tmp/bve-lsp.json
export BVE_CATALOG_TOKEN=development-only-token
node dist/lsp/stdio.js --config /tmp/bve-lsp.json
```

The last command expects a framed LSP client on stdin. The generator uses
synthetic development authority, an empty repository snapshot and a named token
environment variable. It creates a new file and refuses to overwrite one. It
does not validate an installation's real policy or identity authority.

The launcher configuration contains `profile`, `policy`, `activation`, `identity`
and `source` artifacts using production contracts, optional `debounceMs` (0–250,
default 25) and optional `catalog` connection settings. Catalog settings are
`connectionId`, `baseUrl`, `principalId`, `credentialRevision`, `scope`,
`maxAgeMs` (0–30000) and `tokenEnv`. Tokens remain in the launcher environment.
An omitted connection produces incomplete dependency warnings when a catalog
rule needs data. Configuration consistency checks do not verify signatures,
assignments, inheritance or backend authentication semantics. Initialization
options and workspace settings cannot replace these artifacts or the endpoint.

Optional `schemaArtifacts` supplies the trusted, digest-checked bodies for custom
kind pins. Admission and custom-schema checks run before reference policies;
disallowed/schema-invalid entities produce errors, and missing artifacts produce
dependency warnings. Invalid schema configuration fails startup. See
[admission and custom kinds](admission-custom-kinds.md).

Programmatic hosts can import `parseLspConfig`, `createLspRequest`,
`createLspCatalog` and `attachLspServer` from the package's `./lsp` export. The host
supplies the disposal callback and owns provider/runtime lifetime. The stdio
launcher closes both its provider and shared CEL runtime on shutdown or EOF.

## Supported editor lifecycle

- Standard initialize/initialized, UTF-16 positions and incremental open/change/
  close synchronization. Non-increasing versions and duplicate opens are ignored.
- Immutable launcher-supplied repository snapshot plus current open buffers.
  Every accepted workspace edit invalidates dependent open-document results.
- Pinned roots/entrypoints enable [snapshot-local substitutions](substitutions.md).
  Included-buffer edits revalidate catalog users. Findings appear at actual
  payload ranges and at related inclusion sites in open documents, with each
  published document's current version/digest. Closing a payload restores its
  pinned base bytes and revalidates users.
- One active validation and one latest queued workspace generation. Edits/close/
  shutdown cancel active work; only the current epoch can publish. Diagnostics
  carry document version and, when known, file digest, finding ID and category.
- Confirmed missing references are policy errors; permission failures/outages and
  conservative local-entity guards produce dependency warnings. Close clears
  diagnostics. Shutdown awaits cancellation and resource cleanup before exit.
- Input framing is bounded to 8 MiB per message and 8 KiB per header before SDK
  buffering. Source/profile limits apply to buffers, with at most 1000 open
  documents and 1000 changes per notification. Invalid/over-budget edits invalidate
  validation and require a bounded full replacement or close/reopen to recover.
  Exceeding open-document capacity blocks the session until restart.

The server uses the official language-server SDK for framing/JSON-RPC lifecycle
and the official text-document implementation for UTF-16 edits. The preflight
stream bounds messages before the SDK parses them. Stdout contains protocol
messages; startup errors use fixed text on stderr without upstream details.

There is no filesystem discovery/watching, saved-file refresh, dynamic authority
reload, pull diagnostics, completion, hover, fixes, extension packaging or actual
IDE installation qualification yet. Closing a buffer restores the current pinned
workspace bytes. Restart with a refreshed trusted snapshot to incorporate saved disk
changes. Qualified local targets now precede external observations. Invalid/competing
targets block fallback, and pinned-baseline removals mask old catalog copies.
The launcher may supply an explicit `baseline` source snapshot; an unchanged
launcher source is otherwise the default. Standard workspace file delete/rename
notifications update known pinned bytes and revalidate dependents. See
[overlay/editor scope](proposed-overlays.md).

## Acceptance

`npm run test:lsp` compiles and runs catalog-rule and real subprocess/stdio tests.
`npm run test:harness` includes them with the provider and versioned API fixtures.
Tests initialize the production launcher, exchange standard LSP messages, inspect
published diagnostics and shut it down. HTTP response gates synchronize race and
cancellation scenarios. Coverage includes both pinned backend contracts, both
native models at the policy layer, UTF-16 offsets after emoji, authorization/
outage distinctions, context selection, scoped CI aggregation, source/data binding,
rapid edits, close/reopen, included-buffer edits/repair/restoration, inclusion-site
diagnostics, local-source guards, resynchronization and framing bounds.

Real Backstage authentication/smoke tests, actual editor clients, hosted OS runs
and integrated latency/resource qualification remain release gates. The existing
measured CEL cold-start performance gate remains open.

Local qualification on 2026-10-29: 37 new policy/LSP checks and all 424 tests in
`npm run check` passed. Full and production npm audits report zero vulnerabilities.
The built development configuration generator and EOF smoke passed; EOF without
shutdown returns protocol failure (exit 1) after cleanup, with empty output streams.

The subsequent BC-04 increment adds five LSP checks for included buffers and
diagnostic provenance; the full local `npm run check` passed all 485 tests.

BC-05 adds seven LSP checks for admission/custom schemas across both native and
API pins. The full local `npm run check` passed all 552 tests on 2026-10-30.

BC-06 adds nine LSP checks for local precedence, invalid replacements, pinned
deletions, file/identity renames, conflicts, cancellation and unavailable operation
bytes. The full local `npm run check` passed all 593 tests on 2026-11-03.

## Failure evidence and buffer recovery

Incomplete warnings and findings from interrupted work can carry bounded
`data.execution` evidence: fixed stage/cause labels, monotonic elapsed time, signed
wall elapsed time and remaining original deadline. The existing `data.version`
and source digest still identify the publication lifetime. Evidence is capped at
64 rows and copied through an allowlist before publication; raw exceptions,
credentials, endpoints, source text and artifacts are excluded. The visible
warning text and version/epoch suppression remain unchanged.

Unexpected early exceptions now preserve their stage and safe cause through the
policy pipeline. For example, unresolved policy inheritance produces
`bindings / invalid_policy` with zero HTTP requests. `BudgetAdmissionError` is a
`RangeError` subclass identifying invalid or out-of-range deadlines. The existing
five-second admission limit remains unchanged; a backward clock correction after
request creation can still cause `deadline_out_of_range`, with signed wall timing
and remaining-deadline evidence available for diagnosis.

Buffer recovery has separate native-only stdio coverage for oversized replacements,
rejected incremental edits, and bounded full-replacement repair. A separate HTTP
integration uses response gates for initial validation and repair, asserts
successful initial diagnostics, and proves that unavailable-buffer versions issue
no extra requests. If validation ends before a gate is entered, the test reports
that diagnostic immediately. No retries or extended production deadlines are used.

The clock-regression tests also prove that a wall-clock rollback after budget
admission does not extend its monotonic execution deadline. This work implements
diagnostics and test isolation; it does not claim a historical root cause or
introduce a new cross-pipeline clock/budget architecture.

Local qualification on 2026-11-07: native-only buffer recovery, gated HTTP recovery
and early-exception diagnostics passed through the real stdio launcher. The full
672-test check passed, including unchanged version/epoch, cancellation, framing
and shutdown coverage.

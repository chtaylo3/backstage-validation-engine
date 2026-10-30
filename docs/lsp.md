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
IDE installation qualification yet. Closing a buffer restores the immutable base
snapshot. Restart with a refreshed trusted snapshot to incorporate saved disk
changes. Locally proposed target entities remain blocked until BC-06 overlays are
qualified; the server does not silently fall back to their old catalog copies.

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

# LSP separation implementation record

The implementation starts from `fdac6f6`, with the reviewed plan committed and a clean working tree.
The production baseline remains `cb67908`. No remote branch or pull request is part of this work.
This record separates executed evidence from planned checks.

## Phase 0 Baseline and contracts

The fresh `npm run check` baseline passed on Linux x64 with Node 24.22.1 and npm 11.19.1.
It ran 947 source tests and 42 client assertions without failures or skips.
Client coverage measured 100% of lines and 95.88% of branches.
The unchanged client thresholds are 90% of lines and 85% of branches.

The internal contracts in the plan govern the extraction.
Workspace state owns mutable documents and produces detached immutable document views.
A document view preserves text, version, digest, and a lifetime identifier across asynchronous operations.
Session identity and workspace identity remain distinct. A disk invalidation precedes capture and can occur before content changes.
Request contexts capture these identities and retain their original admitted deadline.

The validation coordinator owns validation quiescence. It does not own connection edit settlement.
The diagnostic publisher owns all diagnostic sends and clears.
The edit owner persists for the connection and remains occupied after local cancellation until the client response settles.
Terminal close prevents new edits and cannot wait for a remote acknowledgement.
Session replacement owns providers and registrations. The process owns the shared CEL runtime and protocol connection.

| Invariant                                                      | Baseline evidence or required additional test                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Shared authoritative semantics, contract 0.2, and CLI behavior | `policy-sources`, `cli`, `contracts`, and `cel-runtime` suites                           |
| Cancellation, original deadlines, and latest source generation | `lsp`, `lsp-completion`, and `lsp-filesystem-budget` suites                              |
| Close and reopen with the same version                         | `lsp` and `lsp-fixes-integration` suites                                                 |
| Single active validation and latest pending update             | Existing LSP races plus a new controlled coordinator suite                               |
| Unsaved buffers, filesystem containment, and source selection  | `filesystem-source`, `lsp-filesystem`, and `editor-workspace` suites                     |
| Unselected synchronization errors and atomic file operations   | Existing LSP cases plus workspace-state unit cases                                       |
| Credential and configuration authority                         | `editor-credentials`, `editor-workspace`, and `cli` suites                               |
| Guarded repairs and outstanding edit reservation               | `lsp-fixes`, `lsp-fixes-integration`, and new connection edit-owner cases                |
| Graceful exit with a permanently silent apply client           | New test required. The existing silent-client case resolves its response before shutdown |
| Reload and shutdown during preparation or retirement           | New controlled session-resource cases required                                           |
| Late watcher registration and failing cleanup                  | New controlled session-resource cases required                                           |
| Advisory recovery cannot establish validation success          | Existing `editor-intelligence` and schema suites                                         |
| Optional presentation schemas do not disable native validators | New paired compatibility cases required                                                  |

`scripts/benchmark-lsp-separation.mjs` measures fixed fixture scenarios through the real stdio host.
It records five fresh-process readiness samples and twenty samples for each warm scenario.
Outputs include fixture identity, runtime, platform, sample counts, median, and 95th percentile.
The host helper asserts a successful protocol shutdown and process exit before cleanup.
A fallback kill in the helper's finalizer is not evidence of a successful measured shutdown.

The baseline cannot observe every provider, watcher, or worker directly through the existing wire protocol.
Controlled owner tests will assert resource counts without adding a telemetry protocol.
Source and client results do not establish installed-extension or real-Backstage qualification.

## Implementation phases

Phase 1 adds a TypeScript-based import graph to `npm run check`.
It checks aliases, re-exports, type imports, dynamic imports, and literal module loaders.
The existing CLI configuration edges and root SARIF edge are exact temporary exceptions.
The current graph passes. The representative forbidden-import test passes.
Phase 2 moves catalog admission and construction into `src/host/catalog-config.ts`.
Its input types contain catalog settings and approved authority identity without `LspConfig`.
CLI no longer imports LSP parsing or catalog construction. Existing LSP exports remain wrappers.
Type checking, the import policy, lint, and 11 focused CLI/credential assertions pass.
Phase 3 extracts pure diagnostic conversion, one diagnostic publisher, and a connection edit owner.
The owner retains its slot across local timeout or reload and closes without a client acknowledgement.
A new stdio test leaves the edit unresolved through graceful shutdown and passes.
Existing LSP and fix integration scenarios pass. All three focused owner assertions pass.
An initial owner assertion observed promise settlement too early. It now waits for the event-loop turn that settles the response.
The workspace extraction will supply explicit document lifetime identifiers to the publisher.
Phase 4 moves open, change, close, rename, delete, synchronization, and source ownership into `WorkspaceState`.
Features receive frozen document views through a map without mutation methods. Text and digests are cached per immutable document revision.
Lifetimes survive edits and change after close and reopen. Disk captures commit only against their captured generation.
Seventy existing LSP/filesystem/reload assertions and four focused workspace assertions pass.
An initial cache test exposed a missing cache insertion, which is corrected.
Phases 5 through 9 remain pending.

### Baseline measurements

| Scenario                      | Samples | Median ms | 95th percentile ms |
| ----------------------------- | ------- | --------- | ------------------ |
| `coldReadiness`               | 5       | 258.098   | 278.436            |
| `singleFileValidation`        | 20      | 5.080     | 6.320              |
| `rapidEditConvergence`        | 20      | 4.892     | 6.749              |
| `reloadAndShutdown`           | 20      | 2.810     | 3.212              |
| `localCompletionWithHeldHttp` | 20      | 0.384     | 0.485              |
| `watchedCaptureWithOverlay`   | 20      | 5.425     | 7.360              |

Docker 29.9.2 is available. Final development parity still requires fresh packages and a dedicated run.

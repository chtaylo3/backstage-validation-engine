# LSP separation implementation record

The implementation starts from `fdac6f6`, with the reviewed plan committed and a clean working tree.
The production baseline remains `cb67908`. No remote branch or pull request is part of this work.
Phases 0 through 9 are implemented locally. The qualified Linux checks and the remaining environment limits appear below.
This record separates executed evidence from planned checks.

## Phase 0 Baseline and contracts

The fresh `npm run check` baseline passed on Linux x64 with Node 24.22.1 and npm 11.19.1.
It ran 947 source tests and 42 client tests without failures or skips.
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
Phase 5 extracts the validation coordinator and the existing validation-run orchestration.
The coordinator owns debounce, cancellation, one active run, latest pending work, and validation quiescence.
It also supports pause and resume for session replacement. It owns neither providers nor client edit settlement.
Twenty-four focused scheduler, budget, completion, and reload assertions pass.
Type checking, lint, and architectural boundaries pass.
Phase 6 routes feature requests through typed readiness and captured request contexts.
Contexts retain the admitted deadline, immutable workspace view, and an independent session generation value.
Completion, search, hover, definitions, code actions, and repairs register their asynchronous resource use.
Repair results preserve actual post-dispatch client acknowledgements.
Thirty-two existing completion/reload/fix assertions and three focused context assertions pass.
A focused case caught identity aliasing in the initial context implementation. Capturing the generation value corrects it.
Session-wide cancellation and disposal will use this tracking in phase 7.
Phase 7 centralizes resource generations and serialized replacement in `SessionResources`.
The activation commit installs the generation and workspace selection while feature requests remain unavailable.
Validation, schema preparation, indexing, and feature operations register with the generation that owns their resources.
Prepared replacements and late registrations are closed after terminal shutdown.
The connection retains its edit owner. The process retains its shared CEL runtime.
Eighty-one focused session, reload, deadline, fix, and stdio assertions pass.
Eleven focused session/coordinator assertions also pass, including two new bounded-close failure cases.
Cleanup attempts all owned finalizers even when draining or a close fails. Host aggregate finalizers remain responsible for their supplied providers and filesystem resources.
The production close bound is five seconds per draining stage. A cleanup failure keeps the session unavailable and requires reconnection.
The follow-up keeps the fixed configuration watch with the process and transfers each credential watch to its session generation.
Retired credential callbacks cannot trigger a reload. Invalid configuration does not remove the fixed recovery watch.
Startup failure also closes resources already constructed before connection startup.
Seventeen focused watch, session, reload, and credential assertions pass.
Phase 8 centralizes native package pin admission and immutable presentation artifacts in the compatibility layer.
Native adapter loading reads package identity but never requests optional presentation schemas.
Editor artifacts carry a digest identity and policy/custom hints retain their approved schema digest.
Presentation loading can fail independently without selecting another native version.
Seventeen focused compatibility and editor assertions pass on both pins.
The missing-presentation test injects a reader failure while leaving native SDK exports intact. It also validates an actual suggested edit.
Fresh packaged execution remains part of phase 9.
Phase 9 moves SARIF formatting to neutral reporting while preserving both public re-exports.
All temporary import exceptions are removed. The graph also rejects ownership-component cycles.
Architecture and LSP documentation describe the implemented owners.
An installed-editor case now drives the native search picker through selection, cancellation, and a stale captured selection.
The full source gate passes 973 source tests and 42 client tests.
Client coverage remains 100% lines and 95.88% branches.
Fresh packages built at `8981d22` pass all 973 packaged source tests.
The native search picker passes in both pinned editors.
Final review found that an unexpected readiness or resume callback exception could transfer candidate ownership before activation completed.
The candidate now remains owned until both callbacks succeed. A repeated resume failure remains unavailable and requires reconnection.
Ten controlled session assertions pass, including injected readiness and resume failures with exactly one candidate disposal.
A late registration disposer failure now reaches the manager after its original generation is retired.
Failures during or after replacement activation remain unavailable, invalidate current work, retain a bounded cleanup-failure flag, and require reconnection.
The full source gate at `87b9a16` passes 974 source tests plus the unchanged 42 client tests.
The final source gate at `0b81eac` passes 975 source tests and 42 client tests without failures or skips.
The clean CLI and VSIX built at that revision pass all 975 packaged tests, 88 portable installed-editor executions, six compatibility executions, and six load/saturation executions.
The load suite retains the existing 100-file, 1000-file, timing, memory-growth, and handle-growth thresholds.
It includes the normal post-warmup resource samples and recovery after saturation.
Backstage 1.55.3 development parity passes all 59 cases, including both installed editors and owned-resource cleanup.

The remote attempt exposed a fixture-bundle name collision after shared schema imports reached that bundle.
Commit `31cf440` aliases its banner import and checks the generated ESM bundle with `node --check` during packaging.
The first setup attempt also found a cached editor signature verifier without execute permission.
Restoring its execute permission preserves signature verification and changes no downloaded bytes.
The remote harness correctly rejects a normal local package with revision `local`.
Rebuilding with the checked-out Git revision supplies its required provenance.
No production source, client source, schema, or dependency input differs between `0b81eac` and `31cf440`.
The CLI archive digest is unchanged across those builds.
The stamped packages at `31cf440` pass all 975 packaged tests and all four actual dev-container disconnect/reconnect sessions.
Backstage 1.56.3 stamped development parity passes all 59 cases with owned-resource cleanup.
All owned qualification containers were removed. The pre-existing manual environment was left intact.

### Measurement comparison

The initial cold metric included shutdown despite its metadata flag.
The harness now measures initialization readiness before shutdown, while still requiring successful shutdown afterward.
The corrected baseline uses an isolated source archive of `fdac6f6`, the same locked dependencies, and the corrected harness.
It does not change the active branch or restore earlier history.
The table below supersedes the initial combined cold metric and compares matching harness conditions.
Both reports use Node 24.22.1 on Linux x64 and the same fixed fixture digest.

| Scenario                      | Samples | Baseline median ms | Baseline p95 ms | After median ms | After p95 ms |
| ----------------------------- | ------- | ------------------ | --------------- | --------------- | ------------ |
| `coldReadiness`               | 5       | 238.421            | 243.664         | 251.643         | 263.235      |
| `singleFileValidation`        | 20      | 4.901              | 6.188           | 4.783           | 6.192        |
| `rapidEditConvergence`        | 20      | 4.375              | 6.713           | 4.518           | 5.150        |
| `reloadAndShutdown`           | 20      | 1.325              | 3.173           | 3.036           | 3.919        |
| `localCompletionWithHeldHttp` | 20      | 0.331              | 0.456           | 0.379           | 0.498        |
| `watchedCaptureWithOverlay`   | 20      | 5.155              | 7.867           | 5.058           | 6.323        |

No scenario crosses both parts of its recorded regression threshold.
The largest relative warm p95 increase is reload, an absolute increase of 0.745 ms and a relative increase of 23.49%.
Its absolute change remains below the 5 ms part of the threshold.
The cold p95 increase is 19.571 ms and 8.03%. Neither requires a flagged-comparison rerun under the recorded rule.
The final comparison ran without concurrent formatting, builds, test suites, or owned qualification containers.
The reload scenario measures each reload and requires one successful terminal shutdown after the samples.
Controlled tests separately check zero retained registrations after close, one active validation, latest pending work, and no unacknowledged edit wait during shutdown.
Reports remain under ignored `.artifacts/lsp-separation/baseline-corrected.json` and `after-final-quiet.json`. Intermediate reports are retained but are not the final comparison.

### Added test inventory

The source inventory grows from 947 to 975 assertions. No existing test file or case is removed.
These are named Node test cases reported by the normal test runner, not sandbox file-wrapper counts.
The existing explicit LSP and fixture-harness inventories include every relevant new LSP suite.

| File                                   | Added tests | Main invariant                                                                                         |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `test/architecture-boundaries.test.ts` | 1           | Aliases, barrels, type imports, dynamic/literal loaders, and ownership cycles cannot bypass boundaries |
| `test/lsp-owners.test.ts`              | 3           | Guarded publication and connection-scoped edit reservation                                             |
| `test/lsp-workspace-state.test.ts`     | 4           | Immutable cached views, lifetimes, guarded captures, atomic mutation                                   |
| `test/lsp-coordinator.test.ts`         | 3           | One active run, latest pending work, precise idle, bounded close                                       |
| `test/lsp-request-context.test.ts`     | 3           | Readiness, captured identity, original deadline, cancellation, stale result guards                     |
| `test/lsp-session-resources.test.ts`   | 10          | Atomic replacement, drains, late resources, fault cleanup, terminal bounded shutdown                   |
| `test/lsp-config-watches.test.ts`      | 1           | Fixed recovery watch survives replacement; retired credential watches cannot reload                    |
| `test/native-schema-artifacts.test.ts` | 2           | Pin admission and independent optional presentation failure on both pins                               |
| `test/lsp-fixes-integration.test.ts`   | 1           | Actual stdio shutdown succeeds with an apply response that never settles                               |

### Final commands and evidence

| Check                                                                                                                    | Executed result                                                                                                | Evidence                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run check`                                                                                                          | 975 source tests and 42 client tests pass; no skips; client coverage 100% lines and 95.88% branches            | Final production revision `0b81eac`                                                 |
| `npm run cli:package` and `npm run extension:package`                                                                    | Clean fresh packages built; later builds stamp `GITHUB_SHA` with the checked-out revision for remote admission | `.artifacts/cli/`, `.artifacts/vscode/`                                             |
| `npm run test:packaged`                                                                                                  | 975 pass at both `0b81eac` and stamped `31cf440`; no skips                                                     | `.artifacts/tests/packaged/`                                                        |
| `npm run test:extension`                                                                                                 | 88 of 88 pass in VS Code 1.106.3 and 1.145.2                                                                   | `.artifacts/lsp-separation/installed-0b81eac.json`                                  |
| `npm run test:extension:compatibility`                                                                                   | Six of six pass, including the pinned YAML extension                                                           | `.artifacts/lsp-separation/compatibility-0b81eac.json`                              |
| `npm run test:extension:load`                                                                                            | Six of six pass; unchanged budgets                                                                             | `.artifacts/lsp-separation/load-0b81eac.json` and `.artifacts/vscode/load-results/` |
| `npm run backstage:test:check`                                                                                           | Target inventory, locks, and seed semantics pass                                                               | Static prerequisite check                                                           |
| `npm run test:backstage:development -- --target=1.55.3 --run=lsp-separation-final-older --cli=<archive> --vsix=<vsix>`   | 59 of 59 pass; cleanup passes                                                                                  | `.artifacts/backstage/lsp-separation-final-older/results.json`                      |
| `npm run test:backstage:development -- --target=1.56.3 --run=lsp-separation-stamped-newer --cli=<archive> --vsix=<vsix>` | 59 of 59 pass; cleanup passes                                                                                  | `.artifacts/backstage/lsp-separation-stamped-newer/results.json`                    |
| `npm run test:extension:remote -- --mode=dev-container`                                                                  | Four of four real remote sessions pass                                                                         | `.artifacts/vscode/remote-results/dev-container/`                                   |
| `npm run test:extension:remote -- --mode=ssh-remote`                                                                     | Authenticated SSH preflight cannot connect to its loopback listener; zero product sessions execute             | `.artifacts/vscode/remote-results/ssh-remote/`                                      |
| New-history targeted path scan                                                                                           | 76 new blobs since `fdac6f6`; zero targeted personal-path matches                                              | Read-only object scan, before this documentation-only update                        |

Installed GUI commands use Xvfb and remove the inherited Electron Node-mode and manual launcher/credential variables.
All runtime and credential fixtures remain isolated. Raw logs and reports stay in ignored artifact directories.
Packages and reports identify the production revision separately from the later test-harness revision.
The stamped CLI SHA-256 is `593dd8ba0a4266ea2a4123e3840661531acdbd06b839d2f68d1c94e24a47a27b`.
The stamped Linux x64 VSIX SHA-256 is `01ec061c90c26d7e41313bc5d45342e20c8c8ee5cd097fb3a881fca3447d394e`.
Both stamped packages use clean revision `31cf440d0be2013d94e10e76de926b8af516109a`.
Development evidence does not qualify a release.

The SSH preflight runs under Docker Desktop and WSL2 and returns connection refused from its ephemeral loopback port.
This environment did not provide a successful SSH remote connection. That lane remains unqualified.
The WSL remote harness requires a Windows desktop process; this checkout runs as a Linux process.
Native Windows/macOS, hosted release runs, twenty race repetitions, and long release soaks were not executed here.
Their separate release requirements and existing thresholds remain unchanged.

## Independent review and verification

Independent review started at `3f5d328`. The starting quality gate passed 975 source tests and 42 client tests.
Two regression cases then established defects before correction.
A current clean validation could leave findings from an older document lifetime visible.
Commit `8da9087` separates validation publication from lifecycle clears.
A clean validation replaces older findings. Close, rename, and exclusion clears still check their captured document lifetime.
The regression also checks that an older lifetime cannot clear newer findings, even with a later global generation.
The import checker missed literal loads through an aliased or namespaced Node `createRequire` factory.
Commit `831e809` recognizes those factories. The existing negative import fixture now covers both forms.
The initial regression run failed both cases. After correction, the focused owner, architecture, diagnostic, filesystem, and reload run passed 73 assertions.
No other blocking defect was found in the reviewed ownership, request freshness, catalog admission, schema loading, and protocol paths.
Fresh CLI and Linux x64 VSIX packages were built from clean commit `831e8090d6a12bdd9d871310e45be3969c2b6f26`.
The following independent runs include both review fixes. They do not reuse the subagent's earlier packages.

| Check                               | Result                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run check`                     | 976 source tests and 42 client tests pass; no failures or skips                               |
| Client coverage                     | 100% lines and 95.88% branches; unchanged 90% and 85% thresholds                              |
| `npm run test:packaged`             | All 976 tests pass with the fresh packaged runtime and server; no skips                       |
| `npm run test:extension` under Xvfb | All 88 installed executions pass on VS Code 1.106.3 and 1.145.2, Linux x64                    |
| Import-boundary regression          | Aliased and namespaced factories cannot bypass literal-load checks                            |
| Diagnostic-lifetime regression      | Current clean results clear older findings; stale lifecycle clears cannot erase newer results |

### Independent performance comparison

The first review run crossed cold-readiness and reload tolerances when compared with the earlier historical measurements.
The repeat used an isolated Git archive of `fdac6f6`, the corrected current harness, and the same locked dependencies.
Baseline and reviewed measurements ran sequentially under current machine conditions after the installed suite completed.
Node version, platform, architecture, adapter, fixture digest, and measurement policy match.
The branch and thresholds were not changed. The new baseline was slower than the earlier historical baseline.

| Scenario                      | Fresh baseline p95 ms | Reviewed p95 ms | Increase ms | Threshold crossed |
| ----------------------------- | --------------------- | --------------- | ----------- | ----------------- |
| `coldReadiness`               | 354.952               | 414.997         | +60.045     | No                |
| `singleFileValidation`        | 10.280                | 9.329           | -0.952      | No                |
| `rapidEditConvergence`        | 9.650                 | 10.891          | +1.240      | No                |
| `reloadAndShutdown`           | 5.785                 | 8.093           | +2.308      | No                |
| `localCompletionWithHeldHttp` | 1.706                 | 1.050           | -0.656      | No                |
| `watchedCaptureWithOverlay`   | 12.387                | 11.604          | -0.783      | No                |

The paired repeat crosses no recorded threshold. Original and repeat measurements remain available for review.
The independent logs, inventories, installed report, package digests, and comparisons are under ignored `.artifacts/lsp-separation/parent-review-831e809/`.
The package digests for this reviewed candidate are:

| Package                                                               | SHA-256                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.artifacts/vscode/backstage-validation-engine-0.1.0-linux-x64.vsix`  | `0a878c4215501e498602197490666f6aa71e85728c67727565f7e98e4b1f4cd1` |
| `.artifacts/cli/chtaylo3-backstage-validation-engine-0.1.0-dev.0.tgz` | `f7c4100def8c51f0a8312785d734e51a70e8464d4d01638749d900ba3f3e38ca` |

These independent runs qualify the stated Linux checks.
The earlier Backstage, dev-container, compatibility, and load results above retain their recorded source revisions.
Those lanes, SSH, native Windows/macOS, and hosted release qualification were not repeated for the review fixes.
The prior SSH preflight limitation remains unresolved. No remote branch or pull request was changed.

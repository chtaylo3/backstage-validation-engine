# LSP separation implementation plan

Status: phases 0 through 9 are implemented and merged in [PR #2](https://github.com/chtaylo3/backstage-validation-engine/pull/2).
The tested head is `6938b8b85c1b5889af3fbe1119684de6577e5b45`. The merge commit is `d2e54748dbd34e9f1e881c2abf77689cf197b40f`.
The [implementation record](lsp-separation-implementation-record.md#hosted-qualification-and-merge) records completed qualification and remaining release limits.
The [five-phase editor plan](lsp-editor-improvements-plan.md) governs subsequent work. Its phase 5 is deferred.

The assessment and phase requirements below retain the original design baseline.
Assessment date: 2026-11-09.
Assessment baseline: `cb67908b18246047cfcd9b78ca9b31e1e5513e6b`, with a clean working tree before this document was added.
Review revision: incorporates the ownership, shutdown, dependency, schema, and measurement requirements from the source review.

This plan separates workspace state, validation scheduling, protocol handling, and resource ownership.
It also addresses shared CLI configuration, editor schema consistency, and enforceable module boundaries.
The implementation completed the phases in order and retained their behavior requirements.

## Historical assessment before implementation

The core remains separate from editor protocol handling. CLI and LSP both call `validatePolicySources`.
The core receives immutable source snapshots and explicit provider access.
The VS Code extension remains a language client rather than a second validation engine.

The updated code already supplies several behaviors that the refactor must retain:

- Field and value completion, hover, definitions, and schema repairs exist in `editor.ts` and `editor-schemas.ts`.
- Reference completion captures a generation and rejects obsolete results after asynchronous work.
- Catalog search works from the pinned workspace without an open document.
- Selected source documents are distinct from other open documents.
- Reload clears diagnostics for excluded documents and retains open buffers for later selection.
- Changes to the source root, filesystem mode, or pinned URI set without filesystem mode require client reconnection.
- Trusted configuration changes trigger reload, and invalid configuration blocks affected operations until recovery.
- Credential files support rotation between authenticated requests.
- Editor tests cover schema intersections, conditional branches, prerequisites, custom kinds, and included payloads.
- Client tests cover cancellation, stale edits, history, completion middleware, reload, and discovery.
- The existing client coverage gate participates in `npm run check`.

The remaining concerns are ownership and consistency. `attachLspServer` still owns document maps, scheduling, reload, publication, fixes, watchers, and shutdown.
The CLI still imports catalog construction and parsing from `lsp/config.ts`.
Editor schema loading still reads native package internals independently from the native validation adapter.
The ESLint configuration does not enforce architectural import boundaries.

These observations describe source structure and test coverage at the assessment baseline.
They do not establish a new passing test run or a performance regression.

| Current source                 | Responsibility to reassess                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `src/lsp/server.ts`            | State ownership, scheduling, protocol handlers, publication, reload, and cleanup    |
| `src/lsp/stdio.ts`             | Process startup, resource construction, configuration watches, and process shutdown |
| `src/lsp/config.ts`            | Shared catalog configuration mixed with editor configuration                        |
| `src/lsp/completion.ts`        | Reference index, search, caching, history, and cancellation                         |
| `src/lsp/editor.ts`            | Schema editor features and refinement from validation results                       |
| `src/lsp/editor-schemas.ts`    | Native schema loading and conservative schema interpretation                        |
| `src/lsp/fixes.ts`             | Guarded repair eligibility and edit construction                                    |
| `src/cli/main.ts`              | CLI orchestration with an LSP configuration dependency                              |
| `src/compatibility/adapter.ts` | Pinned native validation behavior                                                   |

## Scope and invariants

A generation identifies one revision of state. A snapshot records the inputs that an operation reads.
A resource owner creates, tracks, and closes a resource.
An acceptance criterion defines an observable condition required to complete a phase.

Preserve these invariants through every phase:

- CLI and LSP retain shared authoritative validation semantics and contract version 0.2.
- A buffer edit, close, rename, configuration change, or shutdown cannot publish an obsolete result.
- Closing and reopening the same URI and version creates a new document lifetime.
- Validation has at most one active run and one latest pending update.
- Source capture and validation retain the original request deadline.
- Unsaved selected buffers take precedence over disk contents.
- Exact file approval and discovery containment remain distinct from open-document tracking.
- Unselected buffers cannot introduce validation findings or block selected sources through synchronization errors.
- Untrusted requests cannot select configuration files, credentials, filesystem roots, or provider implementations.
- Invalid trusted configuration blocks affected operations until a valid replacement becomes active.
- Repairs retain source, version, generation, coverage, and freshness guards.
- Cancellation and reload do not release the connection's outstanding client edit restriction before the client request settles.
- Terminal shutdown cannot wait indefinitely for a client response. It cancels owned work and completes bounded cleanup before process exit.
- Advisory editor recovery never establishes authoritative validation success.

Do not add plugin negotiation, a dependency injection framework, worker scheduling, package splitting, or a new public protocol in this refactor.
Do not change native validation to use the editor's partial schema interpreter.
Keep live catalog refresh as separate feature work under [the capability plan](../plugin-capabilities-plan.md).
That plan already specifies dependency changes and future refresh behavior.
Reserve a typed invalidation reason for dependency changes without implementing a new polling loop here.

## Target ownership

These names are proposed internal modules. Preserve existing public exports through compatibility wrappers where needed.
Functions or classes can implement the boundaries. A new framework is unnecessary.

| Proposed module                         | Owns                                                                              | Does not own                                    |
| --------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `src/host/catalog-config.ts`            | Shared catalog configuration and provider construction                            | LSP document state or connection                |
| `src/lsp/server.ts`                     | Composition, capability negotiation, and handler registration                     | Mutable document maps or validation loops       |
| `src/lsp/workspace-state.ts`            | Documents, selection, overlays, versions, lifetimes, and source revisions         | Provider credentials or protocol sends          |
| `src/lsp/validation-coordinator.ts`     | Debounce, cancellation, active run, pending update, and run completion            | Client edit transport                           |
| `src/lsp/request-context.ts`            | Readiness decisions and captured request identity                                 | Independent copies of workspace state           |
| `src/lsp/session-resources.ts`          | Configuration generations, replacement resources, watches, and disposal           | Schema evaluation                               |
| `src/lsp/diagnostics.ts`                | Finding conversion and incomplete-result conversion                               | Scheduling or workspace mutation                |
| `src/lsp/diagnostic-publisher.ts`       | Diagnostic sends, published document identity, freshness checks, and clears       | Finding conversion or validation scheduling     |
| `src/lsp/client-edits.ts`               | One connection's outstanding edit slot, cancellation, timeout, and terminal close | Repair eligibility rules or session replacement |
| `src/compatibility/schema-artifacts.ts` | Pinned native schema access and artifact identity                                 | LSP values or editor recovery parsing           |

Keep `CompletionService`, `EditorService`, and `FixRegistry` as focused services.
Pass each component only the operations it needs. Do not replace the large closure with a shared mutable context object.
Keep diagnostic publication under a single owner that applies freshness rules immediately before each send.
The connection owns the edit transport across session replacements. A session does not create a new edit slot after reload.
The stdio process owns the protocol connection and shared CEL runtime. A session reload must not close that runtime.

## Internal contracts before extraction

Define these small internal contracts during phase 0. Review them before phase 3 moves ownership.
They are implementation contracts, not public plugin APIs or additions to contract version 0.2.
Equivalent names and functions are acceptable if ownership and observable behavior stay explicit.

| Contract               | Required information and operations                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceSnapshot`    | Immutable selected source and document views, source revision, workspace generation, disk-capture generation, and per-document URI, lifetime, version, digest, and selection  |
| `SessionGeneration`    | Approved immutable configuration identity, owned services and registrations, lifecycle state, and cancellation of operations using that generation                            |
| `RequestContext`       | Captured session and workspace identity, relevant document lifetimes, feature readiness, cancellation signal, and the original deadline admitted for that operation           |
| Operation tracking     | Register and release validation, source capture, completion, search, schema preparation, and repair work before their session resources can be disposed                       |
| `DiagnosticPublisher`  | Publish findings or clear a URI only after checking the corresponding session, selection transition, document lifetime, and workspace identity                                |
| Client edit transport  | Reserve one connection-wide edit slot, cancel local waiting without releasing a live slot, observe eventual settlement, and close terminally without a remote acknowledgement |
| Validation coordinator | Invalidate for a typed reason, observe validation quiescence, and close terminally without accepting new work                                                                 |

Distinguish a disk invalidation from a completed capture. A watcher can invalidate a capture before the source digest changes.
Document lifetime must change after close and reopen, even when URI, version, and content are identical.
Do not renew an operation's deadline when reconstructing a context after asynchronous work.
Read-only operations can capture approved source state without an open document or a scheduled validation run.
Reuse immutable text and source data where possible. Do not copy the entire workspace for each completion request.

Define `whenIdle()` as validation quiescence: no debounce timer, active validation, or latest pending update remains.
It includes superseding updates admitted before quiescence. It does not mean that all session operations or client edits have settled.
Session retirement uses separate operation tracking. Closing the coordinator rejects further invalidation and cancels its timer before draining work.

## Phase 0 Establish the behavior baseline

Dependencies: none. Re-read the current checkout before implementation because code can change after this assessment.
This phase records current behavior and identifies missing race tests.
It does not move production code.

Work:

1. Record the starting revision and all pre-existing local changes.
2. Map the existing test cases to the invariants above.
3. Run the current quality gate and retain its test inventory and failure details.
4. Record observed completion latency, validation latency, and resource counts from existing supported harnesses.
5. Identify missing tests for reload during active validation, repeated reload, shutdown during reload, and delayed watcher registration.
6. Add behavior tests only where existing coverage does not establish the required invariant.
7. Record the internal contracts above, including their mutation, cancellation, publication, and disposal responsibilities.
8. Establish the repeatable measurements and tolerances below before structural changes start.

Acceptance criteria:

- The baseline identifies the source revision, environment, commands, results, and unrelated failures.
- Existing editor and client tests are included rather than described as missing features.
- Each invariant maps to an existing test or a specific planned test.
- Timing tests use controlled promises and an injected clock where practical. They do not depend on arbitrary sleeps.
- The implementation record distinguishes source tests, installed-extension tests, and real-Backstage tests.
- Internal contracts distinguish connection lifetime, session generation, document lifetime, and disk-capture generation.
- Record whether existing shutdown helpers bound process exit or merely kill a process after a timeout. Forced termination cannot count as successful cleanup.

### Repeatable performance and resource checks

Use fixed fixture digests, native pins, Node version, OS, architecture, and controlled catalog responses.
Record commands, sample counts, warm-up policy, machine conditions, and retained measurements.
Do not compare different machines or live remote-server latency as evidence of a refactor regression.

Measure cold editor readiness, warm local completion with catalog HTTP held, single-file validation,
watched capture with an unsaved overlay, rapid-edit convergence, and repeated reload followed by shutdown.
Use at least five fresh-process samples for cold readiness and twenty measured samples for warm latency scenarios.
Record median and 95th-percentile latency with the actual sample count.

Preserve existing hard deadlines and concurrency limits in every scenario.
Flag a warm 95th-percentile increase when it exceeds both 20% of the baseline and 5 ms.
For cold readiness, use 20% and 100 ms. Repeat a flagged comparison under the same conditions before classifying it.
Record any justified environmental variation explicitly. Do not change tolerances after observing the refactored result to hide a regression.

For reload and shutdown, count owned providers, registrations, pending operations, and managed workers where the existing harness exposes them.
After retirement, counts must return to the expected active-session baseline. After terminal close, no owned resource can remain live.
Record workspace snapshot retention against the existing source and document limits.
Do not add a telemetry framework or a broad benchmark dependency for these checks.

## Phase 1 Establish enforceable import boundaries

Dependencies: phase 0. Enforce existing clean boundaries before adding new modules.
Use the existing toolchain, through ESLint restrictions or a small TypeScript import analysis test.
Do not add a new runtime dependency for this purpose.

The table defines import direction. An allowed target is not permission to introduce a new cycle among domain modules.

| Importer                                                                | Allowed targets                                                                          | Forbidden targets                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Contracts, core, parsing, policy, providers, compatibility, and runtime | Existing neutral domain dependencies, Node, and approved packages                        | CLI, LSP, host orchestration, VS Code client source, and editor protocol packages |
| Shared host configuration                                               | Neutral domain modules, Node, and approved packages                                      | CLI, LSP, VS Code client source, and editor protocol packages                     |
| CLI adapter                                                             | Neutral domain modules, shared host configuration, and neutral reporting                 | LSP and VS Code client source                                                     |
| LSP adapter                                                             | Neutral domain modules, shared host configuration, neutral reporting, and LSP components | CLI and VS Code client source                                                     |
| VS Code client                                                          | Client-owned code, Node, VS Code, and its protocol client SDK                            | Engine implementation and host configuration modules                              |
| Neutral reporting                                                       | Neutral domain modules and approved packages                                             | CLI, LSP, host orchestration, and VS Code client source                           |

Work:

1. Prohibit domain modules from importing CLI, LSP, host orchestration, or VS Code code. Include contracts and the managed runtime in domain protection.
2. Prohibit new imports between CLI and LSP adapters.
3. Define allowed imports for the new host and editor coordination modules.
4. Record exact exceptions for existing CLI configuration imports and the root SARIF export.
5. Include type imports, re-exports, literal dynamic imports, and literal module-loader calls in the boundary policy. Resolve local barrels and aliases so they cannot bypass restrictions.
6. Connect the boundary test to `npm run check`.

Acceptance criteria:

- Representative forbidden imports fail the boundary test.
- Current allowed imports pass without broad directory exemptions.
- Each temporary exception names the exact edge and the phase that removes or resolves it.
- Core modules retain no dependency on editor protocol packages.
- Tests demonstrate rejected reverse imports from both contracts and runtime, including through a barrel or type-only import.
- The rule does not incorrectly require a complete directed hierarchy among existing internal core modules.

## Phase 2 Extract shared host configuration

Dependencies: phase 1. Move common catalog setup out of `lsp/config.ts`.
Keep document selection, discovery, and debounce configuration in the LSP adapter.
Preserve the current configuration format and supported exports.
The host module owns neutral catalog settings and authority-context types. It must not accept or import `LspConfig`.

Work:

1. Extract catalog configuration admission and provider construction into `src/host/catalog-config.ts`.
2. Give construction explicit environment or credential-resolution inputs.
3. Replace CLI calls to both `createLspCatalog` and `parseLspConfig` with shared catalog admission and construction. Keep LSP document admission in the adapter.
4. Retain compatibility wrappers for exported LSP helpers where required.
5. Preserve native adapter pins, authorization scope, credential revision, token rotation, and cache limits.
6. Remove the CLI-to-LSP exception from phase 1.

Acceptance criteria:

- CLI source no longer imports `src/lsp`.
- Equivalent admitted catalog inputs produce equivalent provider context for both clients.
- CLI authority comes from its verified release and host trust. The catalog file cannot replace profile, policy, activation, or identity.
- LSP authority continues to come from its trusted launcher configuration. Neither client invents an IDE-mode validation request merely to admit catalog settings.
- Invalid credentials, malformed configuration, and unsupported transport settings retain their current behavior.
- Credential values do not appear in diagnostics, logs, snapshots, or test reports.
- CLI JSON, SARIF, exit codes, and packaged entry points remain compatible.
- Credential rotation and configuration tests pass.

## Phase 3 Extract diagnostics and client edit transport

Dependencies: phase 2. These extractions reduce the server function before state ownership changes.
Keep repair authorization inside `FixRegistry` and the validation result path.
Keep protocol publication separate from pure finding conversion.

Work:

1. Extract finding conversion and incomplete-result conversion into `diagnostics.ts`.
2. Preserve related locations, source digests, versions, rule IDs, and bounded failure evidence.
3. Extract `workspace/applyEdit` transport handling into `client-edits.ts`.
4. Give the edit transport explicit cancellation and close operations.
5. Retain its occupied state until the outstanding client request settles.
6. Create one `DiagnosticPublisher` for the connection. Route ordinary publication and close, exclusion, rename, and deletion clears through it.
7. Keep the client edit owner alive across configuration reload. Terminal close cancels local waiting and disposes local listeners without waiting for the client to acknowledge an edit.

Acceptance criteria:

- Equivalent findings produce equivalent diagnostics, including included-file projections.
- Incomplete coverage cannot become an empty successful result through conversion.
- A client edit timeout does not permit a second outstanding edit request.
- Late success, late rejection, client cancellation, reload, and shutdown release listeners exactly once.
- Reload cannot admit a second edit while an earlier request remains outstanding on the same connection.
- A client that never resolves its edit request does not prevent graceful shutdown within the existing shutdown budget.
- Add a test that leaves the client response unresolved through shutdown. The current silent-client test resolves it before `host.shutdown()` and does not establish this guarantee.
- Terminal close prevents new edit requests even after a late success or rejection.
- Only the publisher owns diagnostic delivery and its published-URI records. Conversion helpers remain pure.
- A delayed clear from an old lifetime cannot erase diagnostics for a reopened document with the same URI and version.
- Publication checks identity immediately before dispatch, including between sends in a multi-document batch.
- Extraction does not change which repairs are offered or authorized.
- Existing fix, client, and diagnostic tests pass.

## Phase 4 Introduce workspace state ownership

Dependencies: phase 3. `WorkspaceState` becomes the only owner of open-document mutations.
Keep tracked open buffers distinct from the selected validation sources.
Expose immutable snapshots rather than mutable `TextDocument` objects shared across operations.

Work:

1. Move open, change, close, rename, delete, synchronization, and capacity handling into `workspace-state.ts`.
2. Preserve strict incremental edit admission before the text-document library can clamp invalid positions.
3. Capture document lifetime, version, text digest, source revision, and selection in snapshots.
4. Apply file operations atomically after complete admission.
5. Route disk captures back through workspace state with their captured source generation.
6. Recompute selection on configuration replacement without discarding retained open buffers.

Acceptance criteria:

- Feature handlers cannot mutate document storage directly.
- A snapshot remains unchanged after a subsequent edit or reload.
- Close and reopen with the same version cannot revive previous results or repairs.
- Excluded buffers remain available for later selection but cannot contaminate current validation.
- Malformed changes in an excluded buffer do not block selected sources.
- Exact approvals, discovery patterns, root containment, and symlink protections remain intact.
- Multi-file rename or delete either commits completely or preserves the prior source state.
- UTF-16, CRLF, size limits, invalid replacements, and deletion masks retain current behavior.

## Phase 5 Extract the validation coordinator

Dependencies: phase 4. The coordinator consumes workspace snapshots and owns run scheduling.
It calls the existing validation engine and existing editor services.
It does not create a second validation pipeline.

Work:

1. Move the timer, pending flag, active promise, abort controller, and run generation into the coordinator.
2. Expose `invalidate(reason)`, `whenIdle()`, and `close()` or equivalent small operations.
3. Preserve one active run and replacement of intermediate pending updates by the newest update.
4. Retain the original deadline through filesystem capture and validation.
5. Preserve local-source sharing between validation and reference completion.
6. Produce a result bound to its snapshot and configuration generation.
7. Implement the phase 0 definition of `whenIdle()`. Keep connection edit settlement and session-wide retirement outside that operation.

Acceptance criteria:

- Rapid edits start no overlapping validation runs and eventually evaluate the latest eligible state.
- Superseded disk captures cannot replace a newer workspace source.
- Cancellation reaches catalog access and managed rule execution.
- Local completion remains available while unrelated catalog work is pending.
- Search without an open document remains supported.
- Closing the coordinator cancels its timer and active run, then waits for owned work.
- Controlled scheduling tests run without a real LSP connection.

## Phase 6 Centralize request readiness and freshness

Dependencies: phase 5. Build request contexts from the established workspace and session owners.
Do not replace feature-specific admission with one unrestricted ready flag.
Keep cancellation and freshness as independent conditions.

Work:

1. Introduce typed readiness outcomes for unavailable configuration, unsynchronized sources, capacity limits, and stopped sessions.
2. Capture workspace generation, configuration generation, and relevant document lifetime for each request.
3. Provide a shared freshness predicate for asynchronous result delivery.
4. Apply it to completion, search, hover, definitions, diagnostics, and code actions as appropriate.
5. Retain stronger capability, coverage, expiry, and edit-transport requirements for repairs.
6. Preserve protocol-specific empty responses and cancellation behavior.

Acceptance criteria:

- A completion or search that finishes after an edit or reload returns no obsolete results.
- A result from a closed document cannot attach to its reopened lifetime.
- Every diagnostic send passes a current-context test immediately before dispatch.
- Invalid configuration blocks affected requests through one explicit policy.
- Context identity contains no credential values.
- Contexts also preserve the operation's original deadline and distinguish disk capture from disk invalidation.
- Work using session resources registers with its captured generation and releases registration on success, failure, or cancellation.
- Existing generation checks are preserved or replaced by an equivalent tested guard.
- Standard LSP responses and existing `bve/*` request shapes remain compatible.

## Phase 7 Make reload and shutdown resource ownership explicit

Dependencies: phase 6. A session generation owns its providers, editor services, and registrations.
Reload remains serialized, with repeated triggers coalesced into a subsequent reload.
Shutdown is terminal and cannot reactivate a replacement session.

Define one activation commit point that installs configuration, services, source selection, and generation identity together.
Before that point, prepared resources are not visible to feature handlers. Requests remain blocked until required activation steps succeed.
Retired resources must never become active again, even when replacement activation or cleanup fails.

| Failure point                          | Required state and cleanup                                                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preparation or admission before commit | Remain unavailable, discard the replacement, and preserve retained buffers for recovery                                                                           |
| Activation after commit                | Mark the replacement unavailable, invalidate its results, and close every partially activated owned resource                                                      |
| Retirement or disposal                 | Attempt every remaining close, retain bounded non-secret failure evidence, and keep affected operations unavailable until complete valid ownership is established |
| Shutdown during any transition         | Enter terminal state, cancel prepared and active work, prevent activation, and finish bounded cleanup                                                             |

Work:

1. Prepare and admit replacement resources before activation.
2. Block affected requests and invalidate old results when trusted configuration changes.
3. Cancel and drain all registered work that uses retired resources, including validation, captures without open documents, completion, search, schema preparation, and repairs.
4. Activate one complete replacement generation through the workspace and coordinator APIs.
5. Dispose retired resources and all resources from abandoned replacement attempts.
6. Track dynamic watcher registration disposables, including registrations that resolve after shutdown.
7. Separate stdio process ownership from session ownership and define the cleanup order.
8. Preserve automatic configuration watches, credential-file watches, and explicit reload requests.
9. Keep the connection's edit owner and the process's shared CEL runtime outside replaceable session resources.
10. Document close deadlines and the order of session cleanup, connection disposal, runtime cleanup, and process exit. Avoid waiting on a request that only connection disposal can settle.

Acceptance criteria:

- Preparation failure retains the existing unavailable state until valid configuration is loaded.
- Tests inject failure before and after the activation commit point, including watcher setup and old-resource disposal failures.
- Faults cannot expose a partially activated configuration or restore already retired resources.
- Repeated reload requests cannot overlap provider replacement or disposal.
- Reload excludes diagnostics for newly unselected files and preserves buffers for later inclusion.
- Changes to the source root or filesystem mode retain the current reconnect requirement.
- Without filesystem mode, changes to the pinned source URI set retain the current reconnect requirement.
- A late watcher registration is disposed when its generation is retired.
- Shutdown during preparation, activation, or retirement never publishes a new active session.
- Cleanup attempts every owned resource even when one close operation rejects.
- Each provider and registration closes once, or uses an explicitly safe repeatable close contract.
- No outstanding external client response can hold terminal shutdown open indefinitely.
- EOF, explicit shutdown, exit, SIGINT, and SIGTERM retain tested exit behavior.
- The client still receives the existing reload notification after successful activation.

## Phase 8 Consolidate schema identity and strengthen consistency tests

Dependencies: phase 7. Both editor services and validation must identify the same approved schema inputs.
Native validation continues to use native validators and policies.
Editor recovery remains conservative and supports unfinished input.
Native validation and optional editor presentation metadata have independent loading outcomes.
Sharing package identity must not make native validation depend on private editor-schema files.

Work:

1. Centralize native package selection, pin admission, and schema artifact access in the compatibility layer.
2. Pass approved schema metadata to editor services without exposing provider credentials or mutable validators.
3. Bind editor indexes to schema identity and configuration generation.
4. Reuse existing editor-intelligence cases before adding new cases.
5. Add paired suggestion and validation tests for the supported schema subset.
6. Document unsupported or ambiguous schema constructs and their conservative editor behavior.
7. Keep native-validator loading separate from presentation-schema loading. Return an internal unavailable result for missing presentation metadata without substituting another native version.

Acceptance criteria:

- Native versions and custom API versions select the same approved artifacts across both paths.
- With native exports intact and presentation schemas unavailable, authoritative native validation still runs and independent approved custom or policy hints remain usable.
- Pin mismatches are rejected without fallback to a different installed version. Presentation failure cannot imply validation success.
- Test missing presentation files, pin mismatches, both native adapter pins, and the freshly built packaged CLI and VSIX.
- Suggestions for `enum`, `const`, and supported conditional branches respect applicable schema constraints.
- Defaults and examples remain advisory and are filtered when incompatible with applicable constraints.
- Unknown conditions do not select a speculative branch or imply complete schema support.
- Required-field placeholders do not claim that the resulting document passes all validation.
- Prerequisite-dependent policy hints remain tied to the corresponding validation generation.
- Included payloads retain actual edit locations and parent schema context.
- A schema or policy reload invalidates every affected hint, repair, and cached schema view.
- Paired tests distinguish valid candidate values from whole-document validity and catalog availability.
- No partial editor interpreter replaces AJV or native validation semantics.

## Phase 9 Finish boundary enforcement and qualification

Dependencies: phase 8. Remove transitional dependencies and update architecture documentation.
Keep `server.ts` as composition and protocol registration.
Judge success by ownership and testability rather than a line-count target.

Work:

1. Remove temporary boundary exceptions introduced in phase 1.
2. Move SARIF formatting to a neutral reporting module if the root API continues to export it.
3. Preserve the existing root export through re-exporting and keep `cli/sarif.ts` as a wrapper if needed.
4. Enforce new coordinator, workspace, and host boundaries without forbidding intended internal domain composition.
5. Update `docs/architecture.md`, `docs/lsp.md`, and `docs/implementation-status.md` to describe actual ownership.
6. Run final source, client, package, and installed-extension regression checks.
7. Compare latency and resource behavior against phase 0 evidence using the same harness conditions.

Acceptance criteria:

- No adapter-to-adapter configuration dependency remains.
- No new dependency cycles exist among the extracted ownership components.
- Public entry points, configuration files, CLI outputs, and LSP capabilities remain compatible.
- The full quality gate passes, including architecture checks and existing client coverage thresholds.
- Installed-extension tests exercise completion, hover, search, repairs, reload, selection, and cancellation.
- A packaged CLI and VSIX pass applicable real-Backstage development parity cases.
- Existing timing and resource budgets pass. Any unexplained baseline regression is resolved before completion.
- The named phase 0 scenarios meet their recorded tolerances and expected resource counts under matching measurement conditions.
- Reviewers can trace document mutation, request identity, publication, and disposal to one owner each.
- Adding a read-only editor feature does not require changing validation scheduling or shutdown internals.

## Validation commands and evidence

Run implementation checks from Ubuntu WSL at the repository root with the pinned Node version.
These commands are future phase gates, not evidence of tests executed while writing this plan.
Inspect the current script definitions before execution because they can change after the baseline revision.

```sh
source "$HOME/.nvm/nvm.sh"
nvm use
npm run typecheck
npm run lint
npm run test:lsp
npm run test:client
npm run check
```

Use focused suites during each phase. Run the complete gate at the baseline and final integration boundaries.
The normal test runner discovers compiled `*.test.js` files. Ensure new tests also enter any applicable explicit LSP suite inventory.
Do not infer credential coverage from `test:lsp` alone. Include `editor-credentials.test.ts` through the full suite or a targeted invocation.

For final packaging, use `npm run cli:package`, `npm run extension:package`, and `npm run test:packaged`.
Use the existing extension, race, compatibility, and remote harnesses according to the changed surfaces and supported environment.
Use [the Backstage environment guide](../../test/integration/backstage/README.md) for development parity with newly built packages.
Use a fresh run ID and retain reports. Do not reuse an earlier VSIX as evidence for refactored sources.
Development evidence does not qualify a release. Preserve the separate release requirements in the existing release plan.

Record each phase with its commit, changed boundaries, executed commands, results, and remaining limitations.
Advance only when its acceptance criteria pass or a documented baseline failure is demonstrably unrelated.
Keep behavior changes separate from structural extraction commits so regression causes remain reviewable.

## Design precedents

Red Hat YAML separates initialization from language, validation, settings, and workspace handlers.
Use that division to reduce protocol registration responsibilities.
See [YAML server initialization](https://github.com/redhat-developer/yaml-language-server/blob/main/src/yamlServerInit.ts).

Pyright places analysis scheduling, cancellation, file updates, and disposal in an analysis service.
Use that ownership pattern for the validation coordinator.
See [the Pyright analysis service](https://github.com/microsoft/pyright/blob/main/packages/pyright-internal/src/analyzer/service.ts).

Rust-analyzer separates mutable analysis state, immutable snapshots, request handlers, and reload logic.
Use that separation without adopting its compiler database or concurrency machinery.
See [the rust-analyzer architecture](https://rust-analyzer.github.io/book/contributing/architecture.html).

These upstream links are design references and can change. The acceptance criteria above govern this project's implementation.

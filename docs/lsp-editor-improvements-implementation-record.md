# LSP editor improvements implementation record

This record follows the [five-phase implementation plan](lsp-editor-improvements-plan.md).
The branch is `feature/lsp-capabilities-refresh`. Its merged baseline is `d2e54748dbd34e9f1e881c2abf77689cf197b40f`.
Plan commit `4b34f78` defines the authorized scope and acceptance criteria.

## Phase state

| Phase                                           | State                              | Parent acceptance             |
| ----------------------------------------------- | ---------------------------------- | ----------------------------- |
| 1: documentation                                | Accepted                           | Accepted by parent            |
| 2: contracts and built-in adapters              | Accepted                           | Accepted by parent            |
| 3: live catalog refresh                         | Accepted                           | Accepted by parent            |
| 4: CEL and RE2 contributions                    | Implemented, qualification pending | Requires parent review        |
| 5: client reliability and release qualification | Deferred by the user               | Requires future authorization |

SQS, Kafka, durable hosted governance, and authoritative GitHub publication remain outside these editor phases.
Arbitrary executable plugin loading also remains outside phases 1 through 4.
Each phase requires parent review before the next implementation starts.

## Phase 1: documentation and completed qualification

Implementation date: 2026-11-09, America/New_York time.
This phase changes documentation only. It preserves historical checkpoints and separates current results from remaining qualification.
Implementation commit: `202dac4920d471118f45783d219e4a31b153b862`.

The separation plan now identifies phases 0 through 9 as implemented and merged in PR #2.
The separation record contains the tested head, merge commit, native/remote results, candidate digests, and retained macOS failure.
Implementation status, editor guidance, LSP guidance, and VS Code qualification now distinguish completed native checks from deferred release work.
The capability design maps its technical requirements into the authoritative five-phase order.
The README links that implementation order.

### Evidence and acceptance criteria

The [hosted qualification summary](lsp-separation-implementation-record.md#hosted-qualification-and-merge) is the canonical completed separation record.
Its [PR CI](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42749139911) and [quick qualification](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42749137380) both passed.
The local retained summary is `.artifacts/lsp-separation/hosted-6938b8b/verification-summary.json`.
The underlying platform, remote, and original macOS reports remain in that ignored evidence directory.

| Criterion | Implemented evidence                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1-A1     | The separation plan and record identify implemented phases 0 through 9 and merged PR #2.                                                         |
| P1-A2     | The canonical summary records tested head `6938b8b85c1b5889af3fbe1119684de6577e5b45` and merge `d2e54748dbd34e9f1e881c2abf77689cf197b40f`.       |
| P1-A3     | Reports record 989 source tests, 989 packaged tests, and 88 installed cases on each native operating system.                                     |
| P1-A4     | Reports record 36 desktop quick cases and 12 real remote sessions. Per-platform and remote candidate digests match the installed-editor reports. |
| P1-A5     | The first macOS 87/88 result and unchanged 88/88 rerun remain explicit. Deferred release evidence does not appear complete.                      |
| P1-A6     | Implementation status and capability delivery link the five-phase plan. Phase 5 is deferred, and hosted/broker work remains excluded.            |
| P1-A7     | Documentation validation and parent review are recorded below. No runtime file changes belong to this phase.                                     |

The separate post-merge CI targets the merge commit, not the tested PR head.
At this documentation checkpoint, [that run](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42755077373) remained active with Windows installed-editor work pending and no failed jobs.
That observation does not change the successful exact-head qualification.

### Executed documentation validation

Scoped `npx prettier --check` passed for the ten phase documents, including the new implementation record.
`git diff --check` passed.
A read-only Python inspection passed 83 local Markdown targets and anchors across those documents.
The same inspection matched platform counts, candidate digests, successful run links, and the macOS failure/rerun against the retained summary.
Git status and changed-path review showed only the intended documentation changes plus the pre-existing untracked review.
The untracked review and the separate planning repository were not modified or staged.
No new product test run is claimed for this documentation-only phase.
Existing product results above belong to their stated source revisions.

### Parent acceptance

Accepted by the parent after reviewing all ten changed documents and repeating scoped formatting and diff checks.
The parent matched the canonical hosted summary against retained candidate counts and digests.
The parent also inspected local Markdown targets and anchors.
The post-merge CI run subsequently passed at merge commit `d2e54748dbd34e9f1e881c2abf77689cf197b40f`.
All P1 acceptance criteria are satisfied. Phase 2 is admitted for implementation.
Phases 2 through 4 remain unimplemented at this review checkpoint. Phase 5 remains deferred.

## Phase 2: capability contracts and built-in adapters

Implementation date: 2026-11-10, America/New_York time.
This phase implements version 1 capability records and built-in adapters. Local qualification passed. Parent acceptance remains pending below.

### Implementation and compatibility decisions

The new `./capabilities` export supplies typed interfaces, 40 generated JSON Schemas, semantic admission, host approval, and negotiated provider sessions.
The capability API is `bve-plugin/1`. Validation request and result contract 0.2 remains unchanged.
The [interface guide](capability-interfaces.md) records exact function inputs, outputs, profiles, limits, and lifecycle behavior.

Field/value metadata, hover, reference identities, and logical schema repairs use neutral records in the capability domain.
The LSP host retains protocol rendering, current source ranges, local target resolution, ranking, and guarded edit dispatch.
Catalog completion and search use an approved search session while the existing provider retains HTTP and credentials.
Discovery uses its current source binding and original capture budget. The subsequent reader still performs all physical file checks.

The built-in validation service calls the original core pipeline.
Its portable output contains materialized data and evaluation start, findings, coverage, rule states, artifacts, and interruption state.
The host admits that projection against the original source and deadline, then compares it with its actual core report.
The invocation binding identifies input data. A separate digest identifies the newly evaluated materialized data.
Catalog authority bindings include actual connection, adapter, principal, credential revision, permission revision, and scope without a token.

Activation, workspace, session, and remote dependency generations remain distinct.
Prepared providers are approved in-process built-ins. Unsupported executable profiles and document-selected code remain unavailable.
The registration descriptor digest identifies host-approved registration data. It is not a binary signature or external-code attestation.
The architectural gate treats capability modules as domain modules and rejects reverse LSP/host dependencies.

The dependency-change interface declares observation and cursor behavior and returns invalidation hints only.
This phase does not start live polling, supply a universal Backstage event stream, or add CEL/RE2 editor contributions.
Phases 3 and 4 remain separate. Phase 5 remains deferred.

### Acceptance evidence map

| Criterion | Implementation and qualification evidence                                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-A1     | Versioned manifests, bindings, handshakes, per-function schemas, generated resources, and runtime semantic admission.                                                                                             |
| P2-A2     | Conformance cases cover artifact/schema tampering, required/optional versions, unknown capabilities, profiles, dependencies, permissions, malformed records, oversized input, and accessors.                      |
| P2-A3     | The built-in service retains core violations and unavailable required coverage. Existing real stdio cases retain both native/backend contracts.                                                                   |
| P2-A4     | Real editor, validation, search, and discovery paths use admitted adapters. Routing tests inject logical contributions and retain host rendering and target resolution.                                           |
| P2-A5     | Existing editor/completion tests and new descriptor cases cover schema constraints, scopes, provenance, absence/null, repairs, and catalog authority.                                                             |
| P2-A6     | Lifecycle cases cover delayed/duplicate/wrong-bound replies, cancellation cleanup failure, asynchronous initialization, late acquisition, prepared-mode protocol violation, 64-slot admission, and bounded close. |
| P2-A7     | Subject stages, kind/API scopes, logical paths, typed constraints, and original source handling remain explicit. Unsupported source operations retain existing guards.                                            |
| P2-A8     | Optional metadata failure leaves mandatory core violations intact. Required unavailable processing/catalog state retains incomplete coverage.                                                                     |
| P2-A9     | Manifest approval is independent. Authored source and manifests cannot load code, select endpoints, or expose tokens. Trusted launcher configuration retains host-approved endpoints.                             |
| P2-A10    | Architecture and the full gate passed with 1,018 source and 42 client tests. Packaged tests passed 1,018 cases. Ten focused installed cases passed.                                                               |

### Executed checks and retained failures

A focused existing editor, catalog completion, and session-resource run passed 47 tests.
A later selection with capability tests, real stdio, completion, and filesystem suites passed 98 tests.
The new conformance and architecture selection passed 27 cases before the final explicit pattern-boundary case was added.
Those counts describe their respective working checkpoints, not final candidate qualification.
Scoped lint and architectural import checks passed.

The first adapter regression run found TypeBox symbol metadata in schema hashing and unfinished YAML values in JSON projection.
The schema records now contain frozen JSON data, and recovery projection preserves absence instead of converting unfinished fields into null.
Parent review also identified validation binding and lifecycle edges. Dedicated cases now cover their corrected behavior.
The original filesystem deadline regression remains intact. Strict admission denies an expired validation call before provider dispatch.
The host publishes the established `yaml/timeout` code with the original source version, range, and request-timeout evidence.
Its message identifies the exhausted pre-parsing budget and does not claim evaluator work occurred.
An isolated compiled-copy negative control replaced that host projection with generic incomplete output. The existing timeout assertion then failed as intended.
The fault result is retained under `.artifacts/lsp-editor-improvements/phase2/negative-budget/` and does not qualify a product candidate.
No coverage threshold or existing product assertion was lowered.

Candidate `e2fe020` completed an initial full source run with one existing native corpus failure.
That run reported 1,000 passed and one failed case. Sixteen corpus child cases were not reached after the parent assertion failed.
The native case returned two of eight entities. Its unchanged isolated rerun passed all 17 cases.
The cause remains unexplained. Neither this observation nor the dependency-link layout establishes a cause.
The failed gate and isolated pass remain under `.artifacts/lsp-editor-improvements/phase2/e2fe020-initial-gate/`.

Parent review then reproduced a separate cancellation ownership race in `e2fe020`.
The corrected session retains each whole invocation through its cancellation finalizer, including cleanup that starts after close begins.
Close drains current owners and finalizers before provider disposal. Rejected cleanup prevents successful retirement.
Gate-based tests cover caller cancellation, close-triggered cancellation, and rejected cancellation acknowledgement.
A retained negative control confirms that the original close resolved while cancellation remained unsettled.
That control released its gate and remains under `.artifacts/lsp-editor-improvements/phase2/negative-finalizer/`.
The corrected conformance file passed all 24 of its cases.

The final gate used a clean committed checkout because the unrelated user-owned review remains unformatted and untracked in the shared workspace.
That file and the separate planning repository remain untouched.

### Committed candidate qualification

Implementation commit: `e2fe0207d6ba7c10806491f62e403baae5ce28a7`.
The cancellation ownership correction and tested source revision are `231651f57593ef3772feb71508ec6e2382182568`.
This later record update changes documentation only. Its HEAD does not identify a rebuilt product.

Qualification ran serially in an isolated checkout of the tested revision on Linux x64.
A real `npm ci --no-audit --no-fund` installed matching dependencies before the final gate and packaging.
The runtime was Node 24.22.1 with npm 11.19.1.
No concurrent compile, lint, or focused suite ran during the final source gate.
The original native corpus case passed unchanged in this final full gate.

| Command or check                        | Result                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                         | Architecture, type, lint, format, and generated schema checks passed. All 1,018 source tests and 42 client tests passed. |
| Client coverage in the full gate        | 100% lines and 95.88% branches. Required thresholds remain 90% lines and 85% branches.                                   |
| `npm run extension:package`             | Built the Linux x64 VSIX with the tested source revision in its build information.                                       |
| `npm run test:packaged`                 | All 1,018 tests passed with the packaged runtime and server.                                                             |
| Focused installed editor commands below | Ten cases passed with no failed or unexecuted cases.                                                                     |

Each inventory reports zero failed, cancelled, skipped, or todo tests.
The focused commands used `npm run test:extension -- --case=<case>` through `xvfb-run`.
The environment removed inherited `ELECTRON_RUN_AS_NODE`, `BVE_LSP_CONFIG`, and `BVE_MANUAL_CATALOG_TOKEN` values for each launch.
The cases were `editor-intelligence`, `reference-completion`, `editor-search`, `diagnostics`, and `versioned-fix`.
Each case passed on VS Code 1.106.3 and 1.145.2.
Each installed report matches the tested source revision and VSIX digest.
These cases exercise actual field/value suggestions, hover, local navigation, catalog completion/search, diagnostics, and guarded repair dispatch.

The candidate is `backstage-validation-engine-0.1.0-linux-x64.vsix`, with 52,054,359 bytes.
Its SHA-256 is `a5f992df2821dcfcb5d02655d592d46a6535b47a8ce1d7cb5f885edc7cded995`.
The client software bill of materials contains nine components, matching the names and versions in the prior qualified client.
All nine client license notices are present. The real dependency install avoids attribution loss through a dependency-directory symlink.

The retained proof root is `.artifacts/lsp-editor-improvements/phase2/231651f/`.
It contains `qualification-summary.json`, `candidate.json`, `quality-gate.log`, `package.log`, and source/client/packaged inventories.
Each `installed-<case>/results.json` records both editor versions, the source revision, and the installed digest.
The exact VSIX, staged build information, component inventory, and notices also remain in the isolated checkout for parent inspection.
The earlier failed gate, isolated native pass, and negative controls remain separate from this successful candidate evidence.

The final documentation-only update passed scoped Prettier, `git diff --check`, and 15 local Markdown targets and anchors.
No runtime, test, schema, package, or tool file changed after the tested source revision.

No hosted CI, cross-platform matrix, remote session, or release endurance result is claimed for this new candidate.
Phase 5 remains deferred. The parent accepted the stated local phase 2 criteria below.

### Parent acceptance

Accepted after source and documentation review, independent regression execution, and artifact inspection.
The qualified source revision is `231651f57593ef3772feb71508ec6e2382182568`. Evidence-only handoff commit: `af3b1b62452d626c696a2a2abf98131c54ece309`.
The parent ran the capability, editor-adapter, and session-resource suites in the clean qualification checkout. All 39 cases passed without skips.
The parent matched all ten installed results to the candidate revision and digest and inspected the packaged modules, 40 schemas, and nine client components.
The parent also confirmed that changes after the qualified revision affected documentation only and repeated scoped formatting and diff checks.
All P2-A1 through P2-A10 criteria are satisfied for the recorded local scope. Phase 3 is admitted for implementation.
Parent test evidence remains under `.artifacts/lsp-editor-improvements/phase2/parent-review/`. Phase 5 remains deferred.

## Phase 3: live catalog refresh

Implementation date: 2026-11-10, America/New_York time.
The source adds session-owned bounded polling and remote-only revalidation. Parent acceptance is recorded below.
The local qualification record below will identify the exact committed source and retained products.

`CatalogRefresh` records actual body and absence dependencies separately from bounded recent identity query scopes.
Its polling tick advances a host-owned dependency generation and invalidates metadata, query caches, candidates, and repair tokens.
The existing coordinator admits the fresh run. Catalog reads and evaluation retain one original budget.
Source versions remain unchanged. The engine activation generation remains unchanged.
The CLI does not create this service.

The owner tracks at most 1000 references, 32 query scopes, four query workers, and 64 outstanding operations.
Queries expire after 120 seconds without user interest. Equal queries share work.
Polling targets 30 seconds or earlier qualified expiry. Healthy jitter advances this target by up to ten percent.
A 250 ms timer floor bounds short intervals. Zero maximum age bypasses reuse and retains the default cadence or earlier actual observation expiry.
Admission separately revokes expired claims before protocol work.
Failures use bounded exponential backoff up to 120 seconds, with up to ten percent additional jitter.
Healthy observation expiry can shorten backoff. The provider retains its existing batching, queue, HTTP, retry, response, and cache limits.

An unchanged-body outcome still receives fresh full-body observation and evaluation.
A rename removes and adds identities. The server never rewrites the authored reference automatically.
Explicit denial remains unavailable. Permission-filtered missing responses cannot establish global deletion.
Remote identity projections remain advisory. Local overlays and masks retain precedence.
The implementation does not add event adapters or unsolicited standard completion/picker replacement.

### Acceptance evidence before the full candidate gate

The final focused refresh suite passed 20 tests with no failures, cancellations, or skips.
The combined refresh, completion, and session-owner selection passed 46 tests at the earlier focused checkpoint.
Existing completion, fix, and session regression selection passed 35 tests before the refresh tests were added.
The new stdio cases mutate HTTP catalog fixtures on both backend contracts without edit, save, or reload notifications.
They retain document version 7 through missing, present, body-modified, renamed, denied, and recovered observations.
Query-only cases never open a document. They prove empty-query invalidation, added and renamed choices, removal, and no body fetches.
A real provider case proves a changed full-body revision and changed data digest at the same entity identity.
A guarded-repair case first obtains a valid action, then proves that remote invalidation rejects the old token before client dispatch.

The first mutation test expected a separate unavailable diagnostic code. The engine correctly used the rule ID with a dependency category.
That new test expectation was corrected to match the existing explicit incomplete semantics. Production assertions and thresholds were preserved.
The mixed body/query failure test proves that observation expiry precedes network backoff in an idle session.
The held-query test proves that current body diagnostics publish before the unrelated advisory read is cancelled or released.
Final source, client, packaged, and installed-editor gates remain to run against committed inputs below.

### Parent hardening before candidate qualification

The first local candidate was `7d065f0807cacbb9c40ff60cef3ac7a415be40be`.
Its clean `npm run check` passed 1038 source tests and 42 client tests with unchanged coverage thresholds.
This result does not qualify the later corrections.

Parent review identified that zero maximum age must bypass reuse without changing the lifetime of a new observation.
The corrected implementation retains the default 30-second cadence or earlier actual expiry for zero maximum age.
An independent regression proves fresh network reads and no dependency invalidation at the timer floor.
Parent review also reproduced a cross-authority query cache hit through the wrapper.
The owner now pins a normalized access context and rejects mismatches before cached reads, shared work, or body dispatch.
Tests cover principal, installation, permission and credential revisions, scope, policy/profile digests, and unsupported age changes.
The intentional zero-age fresh-read override remains allowed under the same authority.

A newly observed explicit permission denial or credential binding failure now revokes prior dependency eligibility immediately.
Repeated denial remains latched until successful reconciliation, so it cannot continuously cancel the replacement request.
Tests first establish a ready cached query and a valid guarded action, then observe denial before the old body TTL expires.
The old action never reaches client edit dispatch. Authorized-view filtered missing responses retain their separate semantics.
The hardened focused suite passed 24 tests before the final clean gates below.

The first hardened candidate was `e986072c55eebbcb50dcf484c389498271ee34ef`.
Its full source gate reported 1040 passes and two failure records for one failed child and its parent.
The unchanged one-shot 403 regression expected the initial dependency warning.
Unconditional denial invalidation cancelled that initial run before any prior remote claims existed.
A succeeding replacement lookup then hid the warning. This was an implementation regression.
The correction latches initial denial and publishes it honestly. Immediate invalidation only revokes previously established remote claims.
The failed gate remains retained separately. No existing assertion or deadline was changed.

The corrected focused selection passed 77 refresh and existing LSP tests with no failures, cancellations, or skips.
The original initial-403 assertion remains unchanged and passes.

Parent review also exercised ready, denied, recovered, and denied queries before a coordinator cycle could complete.
The original single denial latch did not revoke the new recovered claim on the second denial.
Bounded scope latches now track body reads and query scopes separately.
A fresh foreground recovery re-arms denial checks. A background success only clears its own scope latch.
Repeated identical denial cannot create a cancellation loop through unrelated successful reads.
The independent control covers new-query and same-query recovery without edits or a poll cycle.

The `fe780d9630455bdd11040960a47e97004bde8c8b` source/client gate passed 1042 source and 42 client tests.
The later lifecycle correction synchronously suspends refresh at reload, cleanup failure, and shutdown entry.
A failed configuration load leaves no old timer. Cached requests reject immediately, entered reads receive cancellation, and late responses cannot restore claims.
The final focused selection passed 89 tests, including 26 refresh tests and the unchanged LSP and session-owner regressions.
Final candidate qualification follows below.

The `502d3a4dd42341d1dd9b64796ce411eac1bcbdf4` full gate stopped at lint before running tests.
The new denial-recovery control used arithmetic on a value narrowed to `never` by assertion signatures.
The test now captures that counter as an explicit number. The production implementation is unchanged by this correction.
The failed lint output remains retained. The final full gate uses the corrected committed test input.

### Final phase 3 qualification

Qualified source and test revision: `d6dada9b197a8e8b68a94707ad2f2a3680888224`.
The last production implementation change is `502d3a4dd42341d1dd9b64796ce411eac1bcbdf4`. The next commit corrects a test counter and records evidence.
Later documentation-only commits do not identify a different tested product.
The clean qualification checkout is `/tmp/bve-lsp-phase3-qualified`.
It uses a real matching `npm ci --ignore-scripts` installation, with no dependency-directory symlink.

| Command or check                                                                | Result                                                                                                                                                   |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_SHA=d6dada9b197a8e8b68a94707ad2f2a3680888224 npm run check`             | 1044 source tests and 42 client tests passed. No failures, cancellations, or skips. Architecture, types, lint, formatting, and generated schemas passed. |
| Client coverage in the same gate                                                | 100% lines and 95.88% branches. Existing 90% line and 85% branch thresholds remain unchanged.                                                            |
| `GITHUB_SHA=d6dada9b197a8e8b68a94707ad2f2a3680888224 npm run extension:package` | Linux x64 VSIX built with Node 24.22.1. Build metadata identifies the exact qualified revision.                                                          |
| `npm run test:packaged`                                                         | 1044 tests passed through the packaged runtime and CLI/LSP entry points. No failures, cancellations, or skips.                                           |
| `npm run test:extension -- --case=<case>` under Xvfb                            | Six cases passed on VS Code 1.106.3 and 1.145.2. The retained final reports contain 12 successful executions.                                            |

The installed cases are `catalog-refresh`, `editor-intelligence`, `reference-completion`, `editor-search`, `diagnostics`, and `versioned-fix`.
GUI launches remove inherited `ELECTRON_RUN_AS_NODE`, `BVE_LSP_CONFIG`, and `BVE_MANUAL_CATALOG_TOKEN` values.
Each test uses the installed VSIX and a fresh editor profile.
The first installed loop passed all cases but copied the wrong results directory during evidence collection.
Its collection command failed. The unchanged installed tests ran again with the correct `editor-focused` report path.
The record retains the initial logs and the final complete reports. No test assertion, timeout, or product changed between those installed runs.

The VSIX contains 52,064,547 bytes.
Its SHA-256 is `36564bc8ca0f32ad53939961bfc15c8db3fca5f99578562bd91ac497b529f3e6`.
The client SBOM contains nine components. Its third-party notices match the earlier qualified dependency inventory.
The current client notice SHA-256 is `26a9459ad12db5d8eb1b19a1027eb934cdf09172afcfa69a70e10aac0adba229`.

Artifacts are retained under `.artifacts/lsp-editor-improvements/phase3/d6dada9/`.
They include `qualification-summary.json`, `candidate.json`, gate logs, source/client/packaged inventories, the focused log, primary-source review files, and six installed-report directories.
Every final installed report identifies the same qualified revision and VSIX digest.
Earlier candidate reports remain in their separate revision directories.

### Phase 3 acceptance criteria

| Criterion | Evidence and scope                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-A1     | Mutable HTTP/stdin cases add, remove, rename, and modify teams on both backend contracts. Version 7 and source content remain unchanged. The installed case adds and removes remote teams without edits, saves, or reloads.                                                                             |
| P3-A2     | A remote addition clears the prior missing finding. Empty-query and negative lookup results cannot hide the new team. Query-only sessions exercise this without opening a document.                                                                                                                     |
| P3-A3     | Real body lookup reports missing after removal. Matching remote choices disappear. Rules without an existence requirement do not acquire speculative missing findings.                                                                                                                                  |
| P3-A4     | The old identity disappears and the renamed identity appears. No authored value or document version changes. No automatic client edit occurs.                                                                                                                                                           |
| P3-A5     | A real full-body child-list modification changes the observed dependency digest at the same identity. Fresh body reads and same-version publication prove reevaluation even when the rule outcome stays the same.                                                                                       |
| P3-A6     | Current same-version diagnostics replace or clear previous findings. Aborted late query replies reject before cache admission. Existing coordinator, request-context, publisher, and lifetime regressions remain intact.                                                                                |
| P3-A7     | Expiry and observed remote invalidation revoke a previously offered repair before `workspace/applyEdit`. A fresh explicit query denial also revokes it before the old body TTL expires.                                                                                                                 |
| P3-A8     | Normalized authority mismatches reject before cache reuse or shared work. Explicit denial revokes established claims, initial denial stays visible, and repeated denial cannot continuously cancel recovery. Permission-filtered absence has the limitation below.                                      |
| P3-A9     | Live deletion, invalid replacement, and conflict masks retain precedence over remote results. Local choices remain usable during explicit remote denial.                                                                                                                                                |
| P3-A10    | Deterministic clock tests establish cadence, observation expiry, a positive scheduling floor, zero-age bypass semantics, bounded recent scopes and references, and exponential backoff. Existing provider regressions retain batching, queue, response, and transport bounds.                           |
| P3-A11    | Local source additions reached same-version results in 259 ms on each backend contract at a 250 ms target interval. Packaged observations took 260 ms and 261 ms. Installed additions took 397 ms and 426 ms at a 500 ms interval. A held advisory query cannot delay timely required body diagnostics. |
| P3-A12    | Reload, invalid preparation, cleanup failure, and shutdown suspend refresh immediately. The failed-reload control proves timer cancellation, rejected cached requests, signalled entered reads, and rejected late replies. Existing CLI tests retain single-run behavior.                               |
| P3-A13    | Mutable HTTP fixtures exercise both supported catalog contracts. The installed remote-only case runs on both VS Code pins against the 1.55.3 fixture contract.                                                                                                                                          |
| P3-A14    | The final full source/client gate, packaged harness, and six focused installed cases pass with existing thresholds and assertions.                                                                                                                                                                      |

The installed refresh case made five catalog requests per editor execution across its addition and removal sequence.
The second catalog fixture remained unused in that installed case. The stdio matrix separately exercises both contracts.
These observations qualify the tested local conditions. They are not hard latency or traffic guarantees for arbitrary deployments.
Healthy targets include cadence, configured debounce, and one admitted request budget.
Outages, queue pressure, bounded backoff, and expired observations retain explicit incomplete state rather than fresh claims.

### Verified permission-filtering limitation

The review concern about filtered permission denial was verified against both pinned primary sources.
The [1.55.3 authorization implementation](https://github.com/backstage/backstage/blob/6c66969256572989ed10ee862b26065a0980c0bd/plugins/catalog-backend/src/service/AuthorizedEntitiesCatalog.ts) and [1.56.3 authorization implementation](https://github.com/backstage/backstage/blob/7e29caf1d87edb3c51bd07f85d0f7f8c4f0a33c0/plugins/catalog-backend/src/service/AuthorizedEntitiesCatalog.ts) filter denied entity reads into null batch entries or empty query results.
The pinned [router](https://github.com/backstage/backstage/blob/6c66969256572989ed10ee862b26065a0980c0bd/plugins/catalog-backend/src/service/createRouter.ts) and [response writer](https://github.com/backstage/backstage/blob/6c66969256572989ed10ee862b26065a0980c0bd/plugins/catalog-backend/src/service/response/write.ts) map an empty by-name result to not found.

An HTTP 403 or credential binding failure is observable explicit denial. The fixture uses that separate path for denial and recovery controls.
Permission-framework filtering can instead look like authorized-view absence.
The engine cannot distinguish that response from global deletion through these endpoints.
A missing-reference finding therefore establishes missing from the approved view, not global nonexistence.
This phase does not add a permission broker or a new backend authorization protocol.

### Parent acceptance and phase 4 handoff

Phase 3 is implemented and locally qualified. Parent acceptance is recorded below.
`SessionGeneration.refresh` owns polling, `generation`, `ensureFresh()`, `begin()`, `refreshQueries()`, `suspend()`, and cleanup.
The session passes the dependency generation into validation, schema/editor contributions, and catalog search capability bindings.
The coordinator invalidates current metadata, remote queries, guarded repairs, and publication before remote collection.
Future rule contributions must retain these generation, authority, data, source, and expiry guards.
Facts introduced only by a proposed candidate still need their own authorized collection and eligibility evidence in phase 4.
No CEL/RE2 editor contribution, optional event adapter, external executable loader, or publication is implemented by phase 3.
Phase 5 remains deferred. This candidate has no new cross-OS, remote-client, JetBrains, native Trust, or endurance qualification.

The parent accepted phase 3 after reviewing production changes, failure corrections, documentation, and exact-artifact provenance.
The qualified revision is `d6dada9b197a8e8b68a94707ad2f2a3680888224`. Evidence-only handoff commit: `bfe0d02`.
An independent parent run passed all 39 refresh, request-context, and session-resource cases without failures or skips.
The parent matched all twelve installed executions to the exact VSIX digest and inspected the packaged refresh module and client inventory.
Scoped documentation formatting and diff checks passed. Only documentation changed after the qualified source/test revision.
All P3-A1 through P3-A14 criteria are accepted for the stated local scope and observable authorization behavior.
Parent test evidence remains under `.artifacts/lsp-editor-improvements/phase3/parent-review/`.
Phase 4 is admitted for implementation. Phase 5 remains deferred.

## Phase 4: declarative CEL and RE2 editor contributions

Implementation date: 2026-11-10, America/New_York time.
The [rule contribution guide](rule-editor-contributions.md) defines the independently versioned `bve-editor/1` artifacts and exact behavior.
Trusted launcher configuration can approve finite scalar choices, examples, defaults, descriptions, field paths, and repair enablement.
The host binds each declaration to the exact policy/profile/rule digests, language profile, normalized stage, kind, API version, and path.
Generated schemas and runtime admission preserve the frozen `0.2` policy contract.

Required diagnostics publish before optional preparation.
The actual qualified report establishes applicability. Each admitted scalar candidate reruns the full source, normalization, reference, prerequisite, and rule pipeline.
Fresh authorized reads collect facts for newly introduced references. Candidate interest does not replace the authoritative source dependency inventory.
The shared production pool, original deadline, finite admission, generation, authority, source, lifetime, and expiry guards remain in force.
Candidate evidence identifies actual checked states and coverage. Existing unrelated findings remain explicit.

The phase 2 interfaces carry field, value, hover, and logical repair contributions.
The host matches repair proposals against its candidate evidence before using the existing single-document guarded command path.
Structured includes retain actual payload ranges. Ambiguous mappings and alias targets do not produce repairs.
The new installed case combines CEL and schema RE2, candidate-only catalog additions/removals, stale-token rejection, and post-edit validation.

### Development checks and corrections

Initial direct controls exposed a missing hypothetical baseline when a caller supplied an unchanged source without an explicit baseline.
Preparation now retains the actual baseline or uses the unchanged original snapshot. It cannot infer a baseline for unresolved deletions.
An include control also needed its approved source root. The test now supplies that root.
The stdio fixture initially applied a Component expression to Group documents. An explicit selector now states its intended applicability.
A new pressure assertion initially required two live workers immediately after replacement. The assertion now checks the two-slot ceiling and successful recovery.
Unused imports and two lint errors were corrected before final qualification.

Focused development results include 13 direct contribution cases and nine stdio cases with no failures or skips.
An additional stdio control exposed reference completion returning before declared rule hints.
The host now merges prepared rule hints with reference choices. Both backend contracts pass the repair and post-edit round trip.
These checks use real production workers and both supported HTTP backend contracts where stated.
The held-candidate control publishes required diagnostics and an early source repair before optional I/O completes.
That source token becomes stale at its approved 250 ms freshness bound before client dispatch.
Final source/client, packaged, and installed candidate qualification remains pending at this code checkpoint.
Parent acceptance remains pending. Phase 5 remains deferred.

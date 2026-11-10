# LSP editor improvements implementation record

This record follows the [five-phase implementation plan](lsp-editor-improvements-plan.md).
The branch is `feature/lsp-capabilities-refresh`. Its merged baseline is `d2e54748dbd34e9f1e881c2abf77689cf197b40f`.
Plan commit `4b34f78` defines the authorized scope and acceptance criteria.

## Phase state

| Phase                                           | State                | Parent acceptance                |
| ----------------------------------------------- | -------------------- | -------------------------------- |
| 1: documentation                                | Accepted             | Accepted by parent               |
| 2: contracts and built-in adapters              | Accepted             | Accepted by parent parent review |
| 3: live catalog refresh                         | Not implemented      | Requires accepted phase 2        |
| 4: CEL and RE2 contributions                    | Not implemented      | Requires accepted phase 3        |
| 5: client reliability and release qualification | Deferred by the user | Requires future authorization    |

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

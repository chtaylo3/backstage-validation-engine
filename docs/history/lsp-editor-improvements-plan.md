# LSP editor improvements implementation plan

Status: approved scope for sequential implementation. Phases 1 through 4 are authorized. Phase 5 is deferred.
Plan date: 2026-11-09. Baseline: merged PR #2, commit `d2e54748dbd34e9f1e881c2abf77689cf197b40f`.
Work branch: `feature/lsp-capabilities-refresh`.

This plan defines five phases with separate implementation and acceptance gates.
A capability is a function that an approved provider supplies through a host interface.
The [capability design](../plugin-capabilities-plan.md) supplies the detailed behavior requirements.
The [separation record](lsp-separation-implementation-record.md) records the completed LSP ownership refactor.

## Scope and sequence

| Phase | Scope                                                                                       | State    | Dependency                               |
| ----- | ------------------------------------------------------------------------------------------- | -------- | ---------------------------------------- |
| 1     | Update implementation documentation and qualification evidence                              | Accepted | Merged PR #2                             |
| 2     | Implement capability contracts and adapt built-in providers                                 | Accepted | Accepted phase 1                         |
| 3     | Refresh live catalog dependencies without document edits                                    | Accepted | Accepted phase 2                         |
| 4     | Add CEL and RE2 editor contributions and guarded repairs                                    | Accepted | Accepted phase 3                         |
| 5     | Improve native Trust automation, qualify JetBrains, and complete release endurance evidence | Deferred | Future authorization and final candidate |

The parent agent delegates one phase at a time.
The phase agent implements only its assigned phase and records its evidence.
The parent reviews the changes and runs appropriate checks before accepting the phase.
The next phase starts only after that acceptance. Phase 5 does not start automatically.

Keep SQS, Kafka, the durable hosted controller, and GitHub publication outside these phases.
Keep arbitrary executable plugin loading outside phases 1 through 4.
Built-in adapters and approved declarative rule metadata can implement the capability interfaces without that loader.
Do not publish packages, push the branch, open a PR, or merge this branch as part of these local implementation phases.

## Requirements shared by all phases

- Preserve one validation engine and the existing CLI validation semantics.
- Preserve contract 0.2 compatibility unless a documented, tested migration is necessary.
- Version capability contracts independently. Supply generated schemas and runtime admission, not TypeScript types alone.
- Keep protocol rendering, source ownership, authorization, credentials, ranking, and edit dispatch under host control.
- Preserve document lifetimes, source digests, policy identity, authority scope, and dependency freshness in result admission.
- Keep deadlines, cancellation, caches, queues, and disposal bounded.
- Retain local overlays, invalid replacements, conflicts, and deletion masks when catalog data changes.
- Keep optional editor failures separate from required validation coverage.
- Preserve the existing client coverage thresholds and all applicable regression assertions.
- Preserve unrelated files and the separate planning repository. Add only intended files to commits.
- Use portable repository-relative examples. Do not introduce private workstation paths into tracked content or commit messages.

## Phase 1: update implementation documentation

### Implementation plan

1. Reconcile the separation plan, implementation record, implementation status, and editor documentation.
2. Mark the ownership refactor as implemented and merged. Retain the original assessment and historical test results as dated evidence.
3. Record PR #2, its tested head, merge commit, exact candidate digests, and successful hosted run links.
4. Record the original macOS Trust UI timeout and successful isolated rerun with unchanged assertions and bounds.
5. Separate completed native VS Code and remote qualification from JetBrains, long release workloads, and publication.
6. Keep the unfinished capability, live refresh, and CEL/RE2 authoring work explicit.
7. Create `docs/lsp-editor-improvements-implementation-record.md` for this plan's phase decisions and executed checks.
8. Link this plan from the implementation status and capability design without duplicating competing delivery orders.

### Acceptance criteria

- P1-A1: Current status text identifies the completed phases 0 through 9 and merged PR #2.
- P1-A2: Hosted evidence identifies tested head `6938b8b85c1b5889af3fbe1119684de6577e5b45` and merge `d2e54748dbd34e9f1e881c2abf77689cf197b40f`.
- P1-A3: Evidence records 989 source tests, 989 packaged tests, and 88 installed cases on each of three operating systems.
- P1-A4: Evidence records 36 desktop quick cases and 12 real SSH, dev-container, and WSL2 sessions with matching candidate digests.
- P1-A5: The macOS 87/88 failure and 88/88 rerun remain visible. Deferred release work does not appear complete.
- P1-A6: All five phases have one authoritative order. Phase 5, SQS, Kafka, and hosted governance remain deferred or excluded.
- P1-A7: Documentation formatting and link targets pass review. This phase changes no runtime behavior.

### Validation and handoff

Use the PR, workflow metadata, and retained reports as evidence. Do not infer success from the existence of a workflow.
Make sure that the final post-merge CI status is reported accurately if it differs from the already qualified PR candidate.
Run formatting and diff checks for the changed documents. Do not rerun product suites solely for prose changes.
Commit the documentation and report its scope, evidence sources, and remaining limitations to the parent.

## Phase 2: implement capability interfaces and built-in adapters

### Implementation plan

1. Define versioned manifests, host approval, capability negotiation, context bindings, lifecycle, and typed request/result records.
2. Define validation, fields, values, hover, references, repairs, search, dependency-change, and discovery interfaces.
3. Add generated JSON Schemas, runtime structural admission, semantic admission, and bounded payload limits.
4. Bind requests and replies to invocation identity, source and data digests, policy, authority, deadlines, and generations.
5. Reject unsupported required versions, undeclared functions, altered artifact identities, malformed results, and expired or obsolete replies.
6. Map local cancellation and disposal into the lifecycle. Reject work after disposal and retain bounded cleanup.
7. Adapt current validation, native/schema metadata, catalog references/search, repairs, and discovery through these interfaces.
8. Connect the real feature paths to the adapters. Interfaces that have no caller do not satisfy this phase.
9. Keep source rendering, protocol conversion, history, target resolution, credentials, and guarded edit tokens in the host.
10. Extend architectural boundary checks for new modules and their permitted dependencies.
11. Document each implemented capability, its inputs, outputs, limits, failure states, and required conformance cases.

Default built-ins must remain usable without a new mandatory launcher configuration.
The host approves exact built-in or declarative artifacts before negotiation.
A provider declaration cannot grant network, filesystem, credential, or execution permissions.
An optional unsupported editor function returns no contribution. A missing required evaluator retains incomplete coverage and CI exit 2.

### Acceptance criteria

- P2-A1: Generated capability schemas and runtime admission cover manifests, negotiation, and all implemented function records.
- P2-A2: PC-01 rejection cases cover unknown required versions, tampering, missing dependencies, oversized records, and malformed replies.
- P2-A3: PC-02 preserves core rule outcomes, prerequisites, coverage, native pins, and CLI/editor evaluation semantics.
- P2-A4: Actual completion, hover, definition, repair, search, discovery, and validation paths invoke qualified built-in adapters.
- P2-A5: PC-03, PC-05, PC-06, PC-07, and PC-08 cover existing schema, reference, repair, search, and discovery behavior.
- P2-A6: Tests reject late, duplicate, wrongly bound, or cancelled replies. Disposal releases owned work and rejects new invocations.
- P2-A7: Fields distinguish absent and null values. Existing keys, ambiguous targets, and unsupported source edits retain their current treatment.
- P2-A8: Optional provider failure cannot suppress mandatory findings. Unavailable required validation cannot become a successful empty result.
- P2-A9: The host retains approval and credentials. No authored document or manifest can select executable code or an endpoint.
- P2-A10: Architectural checks, the full source/client gate, packaged tests, and focused installed-editor regression cases pass.

### Validation and handoff

Add behavioral tests with independent expected outcomes and positive controls.
Demonstrate malformed and stale-provider failures at the host boundary, not only through direct parser tests.
Use the existing production CLI/LSP and installed-editor entry points for regression evidence.
Record all public names, schema versions, supported built-ins, and compatibility decisions for phase 3.
Commit the implementation and record the tested revision, commands, counts, and any artifact digests.

## Phase 3: implement live catalog refresh

### Implementation plan

1. Track bounded dependencies for entity bodies, missing references, search queries, and collection membership.
2. Own background refresh within the active LSP resource generation. Share the approved catalog connection and existing admission limits.
3. Refresh the selected open-source dependencies and active or bounded recent search scopes through authorized reads.
4. Use a default target cadence of 30 seconds, shortened by qualified freshness requirements or earlier observation expiry.
5. Define a positive scheduling floor and bounded work. `maxAgeMs: 0` must not create an immediate refresh loop.
6. Batch and deduplicate reads. Apply rate limits, jitter, and bounded failure backoff without treating expired claims as current.
7. Advance a host-owned dependency generation for remote invalidation, even when source versions do not change.
8. Revoke affected metadata, queries, candidate evidence, and repair eligibility. Cancel obsolete dependent work.
9. Admit a new validation request and immutable data snapshot. Do not renew an existing request's deadline or mutate its data.
10. Publish current diagnostics for the same document version and remove findings that fresh evaluation no longer reports.
11. Return fresh eligible choices on subsequent completion/search requests. Keep standard completion lists client-requested.
12. If an active VS Code search picker supports refresh notifications, negotiate that behavior and preserve query, selection, and cancellation.
13. Keep local overlays and masks authoritative during remote updates, expiry, and outages.
14. Cancel timers and pending reads on reload, credential changes, invalid configuration, and shutdown. Reconcile current data after recovery.

Polling is the baseline. Do not assume that Backstage supplies a universal change stream.
The dependency-change interface can accept qualified hints. Hints trigger fresh reads and cannot prove current contents or grant authority.
If change hints are supported, test gaps, resets, duplicates, and reconnect reconciliation.
Keep CLI collection bounded to its run. Do not start an idle refresh service for CLI consumers.

### Acceptance criteria

- P3-A1: PC-11 adds, removes, renames, and modifies teams while a document remains unchanged. No edit, save, or manual reload triggers these cases.
- P3-A2: A new team repairs a previously missing reference and appears in a matching query. Negative lookup and empty-query caches cannot hide it.
- P3-A3: A removed team disappears from refreshed choices and produces a missing-reference finding only when the applicable rule requires existence.
- P3-A4: A rename removes the old identity and adds the new identity. The server never silently rewrites authored values.
- P3-A5: An unchanged identity with changed body data invalidates dependent evaluation. Identity lists alone cannot satisfy this case.
- P3-A6: Diagnostics change at the existing document version. Late reads and runs cannot restore obsolete findings or values.
- P3-A7: Dependency changes and expiry invalidate guarded repairs and candidate evidence before dispatch.
- P3-A8: Permission changes and outages remove affected current claims and retain explicit unavailable or incomplete state.
- P3-A9: Local completion remains usable during remote outages. Local conflicts, invalid replacements, and deletion masks retain precedence.
- P3-A10: Deterministic tests establish the cadence, expiry behavior, scheduling floor, batching, backoff, and bounded dependency inventory.
- P3-A11: Under healthy qualified conditions, the observation target includes the configured cadence and one admitted request budget.
- P3-A12: Reload and shutdown leave no refresh timer, listener, or in-flight read owned by the retired session. CLI exit behavior remains unchanged.
- P3-A13: Mutable HTTP fixtures exercise both supported backend contracts. An installed-editor case proves a remote-only diagnostic change.
- P3-A14: The full source/client gate, packaged tests, and focused installed-editor refresh cases pass without weakening existing tests.

### Validation and handoff

Use deterministic time controls for scheduler cases and response gates for late HTTP replies.
Prove the no-edit condition through document version and content checks.
Use real provider reads against the mutable fixture. A hand-constructed invalidation alone does not prove remote observation.
Record qualified latency and traffic bounds. Distinguish the configured target from measured guarantees and unsupported event streams.
Commit the implementation and document the dependency-generation and invalidation hooks required by phase 4.

## Phase 4: add CEL and RE2 editor contributions

Status: accepted after implementation, exact-candidate qualification, and independent parent review.
The [parent acceptance](lsp-editor-improvements-implementation-record.md#parent-acceptance-of-phase-4) records the executed evidence and supported scope.

### Implementation plan

1. Define approved declarative editor artifacts that bind contributions to exact rules, paths, kinds, API versions, and language profiles.
2. Admit finite field/value metadata, descriptions, examples, defaults, and logical repair proposals through phase 2 interfaces.
3. Prepare contributions asynchronously against qualified subjects, actual selectors, prerequisites, and pinned provider facts.
4. Use the existing managed CEL runtime for selectors, applicability, candidate checks, and repair evaluation.
5. Preserve the two-slot shared pool, 64-job admission limit, profile-specific execution limits, cancellation, and fair scheduling.
6. Use the existing RE2 profiles and semantics. Preserve CEL substring matching and distinct CEL/schema pattern limits.
7. Do not infer an enumeration or a unique repair from an arbitrary predicate or regular expression.
8. Validate finite declared candidates through the applicable pipeline stages before attaching host-owned acceptance evidence.
9. Reevaluate changed selectors, prerequisites, normalization, references, and dependent rules after a proposed value changes.
10. Collect authorized facts for a newly introduced reference. An old observation cannot establish the existence of a new target.
11. Retain advisory labels when evaluation is partial, unknown, unavailable, or only valid for a subset of rules.
12. Map supported logical repairs into the existing one-open-document guarded edit path with exact authored ranges.
13. Bind proposals and acceptance evidence to source, dependency generation, authority, policy, expiry, and document lifetime.
14. Add installed-editor cases that combine CEL, RE2, live catalog changes, completion, hover, and explicit guarded repair.

CEL and RE2 execution already exists. This phase adds editor contributions without replacing that execution.
Keep boolean CEL semantics and existing matching profiles. Do not introduce a value-producing CEL profile or a standalone RE2 rule kind implicitly.
Keep arbitrary executable candidate generators and external plugin loading deferred to a separate approved implementation.
Do not perform CEL evaluation, source parsing, or arbitrary provider execution synchronously in completion handlers.

### Acceptance criteria

- P4-A1: A declared CEL rule supplies eligible field/value hints and safe hover text only for established applicability.
- P4-A2: Candidate evidence identifies the rules actually checked. A single passing predicate cannot claim complete policy compliance.
- P4-A3: Failed, unavailable, or unknown prerequisites suppress prescriptive hints and verified repairs without suppressing validation findings.
- P4-A4: Changing a candidate's selector inputs or reference target triggers the required evaluation and data collection.
- P4-A5: RE2 examples pass the declared profile. Tests distinguish substring and anchored matching and reject unsupported syntax without engine fallback.
- P4-A6: PC-04 covers false results, execution errors, limits, queue pressure, cancellation, worker replacement, and recovery through production workers.
- P4-A7: PC-06 proves supported repair rendering, explicit selection, single-use guards, client rejection, and post-edit validation.
- P4-A8: Edits, close/reopen, remote changes, policy reload, and credential changes reject obsolete candidates and repairs.
- P4-A9: Includes preserve actual payload ranges. Ambiguous mappings, unsupported operations, and multi-file proposals do not produce edits.
- P4-A10: Combined CEL/RE2 workloads preserve validation and typing admission. Provider work cannot create a pool per document or bypass budgets.
- P4-A11: Existing rule semantics and the frozen CEL corpus remain intact. CLI and editor decisions agree on the same pinned inputs.
- P4-A12: The full source/client gate, packaged harness, focused contribution cases, and ordinary portable installed-editor suite pass.

### Validation and handoff

Use production worker execution and actual policy/data bindings for acceptance tests.
Use positive and negative candidate controls. Show that stale or rejected proposals fail before client edit dispatch.
Test the actual installed extension and shared stdio protocol, not only direct contribution functions.
Record the supported declaration format, capability matrix, failure semantics, and measured resource limits.
Commit the implementation and update the phase record. Stop before phase 5.

## Phase 5: client reliability and release qualification, deferred

### Future implementation plan

1. Diagnose and fix native Workspace Trust automation using retained UI evidence and unchanged product trust assertions.
2. Qualify declared JetBrains products and LSP4IJ versions with installed-client workflows.
3. Qualify an exact final candidate through the supported OS/editor matrix, repeated races, longer endurance, and release suites.
4. Exercise real catalog integration and supported upgrade behavior. Distinguish the synthetic predecessor from historical release upgrades.
5. Produce the final support matrix, artifact provenance, qualification limits, and publication readiness record.

### Future acceptance criteria

- P5-A1: Trust tests prove restricted behavior, explicit native consent, persistence, unrelated-folder isolation, and revocation.
- P5-A2: Repetition demonstrates the native UI fix without disabled trust enforcement, hidden trust API calls, or relaxed assertions.
- P5-A3: Declared installed JetBrains clients pass shared capabilities, cancellation, restart, diagnostics, and guarded edit scenarios.
- P5-A4: Required race, endurance, real-backend, and exact-artifact release gates pass for the final candidate and declared support matrix.
- P5-A5: Missing environments and historical-upgrade limitations remain explicit. Publication requires separate user authorization.

This phase is planned but deferred by the user. Do not delegate it or run its long release workloads now.

## Phase evidence and parent acceptance

For every active phase, the implementation record must contain the following information:

- The phase state, implementation commits, and tested source revision.
- The changed boundaries and public configuration or capability contracts.
- The acceptance IDs and concrete evidence that satisfies them.
- Executed commands, test counts, failures, and unresolved limitations.
- Exact candidate digests for installed or packaged evidence where applicable.
- The parent review result and the decision to admit the next phase.

Use focused checks during implementation. Run the complete relevant gates at the phase boundary.
Do not count planned commands, generated reports, or a provider's self-declared result as executed qualification.
Keep failed evidence and state why a later run is accepted. Do not lower thresholds to obtain acceptance.

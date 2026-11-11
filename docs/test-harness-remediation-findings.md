# Test harness remediation finding register

Status: frozen assessment baseline for the approved [remediation plan](test-harness-remediation-plan.md).
Assessment date: 2026-11-10.
Inspected revision: `865a68e7fe2aa9c55f991f345ab4c6dea293907e`.
This register includes all 68 numbered findings and all 18 supplemental gaps.
It supplies the amended acceptance work without requiring the original untracked report.

## Reading the register

`Open` means that the requested evidence remains missing.
`Partial` means that some evidence exists, but the full recommendation remains incomplete.
`Clarification` means that the recommendation needs a narrower claim or an optional maintenance change.
These states describe the assessment baseline. They do not claim when coverage was added.
Record later implementation states in the [implementation record](test-harness-remediation-record.md).

Priority 1 addresses false-success paths and critical evidence gaps.
Priority 2 covers conformance, boundaries, and behavioral hardening.
Priority 3 covers housekeeping and scope corrections.
Original severity is retained separately from implementation priority.
H7 remains deferred and requires separate user authorization.

Every acceptance requirement below also uses the shared controls in the plan.
Each requirement needs an independent expected outcome and executed evidence.
A partial finding cannot close through an already-covered subset.
Evidence links name the inspected files. Line numbers are baseline locations, which can change during implementation.

## Complete package mapping

| Package | Entries | Finding IDs                                                                                                                                                                                                      |
| ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1      | 8       | R4-F13, R5-F1, R5-F2, R5-F3, R5-F4, R5-F5, R5-F6, R5-F9                                                                                                                                                          |
| H2      | 29      | R3-F1, R3-F2, R3-F3, R3-F4, R3-F5, R3-F6, R3-F7, R3-F8, R3-F9, R3-F10, R3-F11, R3-F12, R3-F13, R3-F14, R3-F15, R3-F16, R3-H1, R3-H2, R3-H3, R3-H4, R3-U1, R3-U2, R3-U3, R3-U4, R3-U5, R3-U6, R3-U7, R3-U8, R3-U9 |
| H3      | 13      | R1-F1, R1-F2, R1-F3, R1-F4, R1-F5, R1-F6, R1-F7, R1-F8, R1-F9, R1-F10, R1-F11, R1-F12, R1-F13                                                                                                                    |
| H4      | 12      | R2-F1, R2-F2, R2-F3, R2-F4, R2-F5, R2-F7, R2-F8, R2-F9, R2-F10, R5-F7, R5-F8, R5-F10                                                                                                                             |
| H5      | 15      | R4-F1, R4-F2, R4-F3, R4-F4, R4-F5, R4-F6, R4-F8, R4-F9, R4-F10, R4-F11, R4-U1, R4-U2, R4-U3, R4-U4, R4-U5                                                                                                        |
| H6      | 7       | R2-F6, R2-F11, R4-F14, R4-F15, R5-F11, R5-F12, R5-F13                                                                                                                                                            |
| H7      | 2       | R4-F7, R4-F12                                                                                                                                                                                                    |

The numbered baseline contains 52 open, 14 partial, and two clarification findings.
The supplemental baseline contains 15 open and three partial gaps.
Each of the 86 entries has exactly one accountable package.

## Corrections that constrain implementation

Keep required production Backstage dependencies in the packaged runtime.
Use the correct existing contract for normal CLI results and input/configuration errors.
Keep permission-filtered absence separate from explicit access rejection and global nonexistence.
Document deliberate stricter local substitution behavior instead of silently changing it to mimic upstream.
Retain legitimate client-delivery race tests and independent fixed coordinate vectors.
Do not turn a platform-specific count update into a new cross-platform qualification claim.

## H1: Release evidence rejects false success

### R4-F13: Release verdict independently verifies resource budgets

Baseline: Open. Priority: 1. Original severity: Low.

Evidence: [extensions/vscode/test/qualification.ts](../extensions/vscode/test/qualification.ts) (line 44), [scripts/verify-extension-qualification.mjs](../scripts/verify-extension-qualification.mjs) (line 15).

Acceptance requirement: Recheck approved budgets and raw metrics at the verdict, including relevant load reports. Reject insufficient slope windows and excessive latency/growth.

Amendment: Confirmed: verifyMetrics accepts excessive latency and a large RSS leak that verifyResourceGrowth rejects. This is a verifier control, not a claim that the entire release workflow accepted that fixture.

### R5-F1: Runner missing-report case must drive host accounting

Baseline: Open. Priority: 1. Original severity: High.

Evidence: [test/integration/backstage/lib/driver.mjs](../test/integration/backstage/lib/driver.mjs) (line 197), [scripts/backstage-test-env.mjs](../scripts/backstage-test-env.mjs) (line 445).

Acceptance requirement: Run an actual driver/host phase that exits successfully without its report and assert failed or unexecuted target rows plus failing aggregate status.

Amendment: The current case only removes a file, runs an unrelated zero-exit process and asserts ENOENT. Generic evidence rejection tests do not cover this orchestration path.

### R5-F2: Runner build-failure accounting

Baseline: Open. Priority: 1. Original severity: High.

Evidence: [scripts/backstage-test-env.mjs](../scripts/backstage-test-env.mjs) (line 807), [scripts/backstage-test-env.mjs](../scripts/backstage-test-env.mjs) (line 783).

Acceptance requirement: Inject failure through the actual build phase into scratch run evidence and assert the environment.build row, remaining cases and final verdict.

Amendment: The existing RUN exit 23 image demonstrates a Docker failure, not host build-failure accounting.

### R5-F3: Editor crash evidence accounting

Baseline: Partial. Priority: 1. Original severity: Med.

Evidence: [test/integration/backstage/lib/editor.mjs](../test/integration/backstage/lib/editor.mjs) (line 340), [test/integration/backstage/lib/driver.mjs](../test/integration/backstage/lib/driver.mjs) (line 374).

Acceptance requirement: Put the entered editor crash through the real evidence.run path in a scratch inventory and prove failed classification plus subsequent-case execution.

Amendment: The crash and process cleanup are real. The helper then writes failed status itself, so the report overstates that the entire crash test is tautological.

### R5-F4: Validate every expected CLI report shape and provenance

Baseline: Open. Priority: 1. Original severity: Med.

Evidence: [test/integration/backstage/lib/clients.mjs](../test/integration/backstage/lib/clients.mjs) (line 208), [src/cli/main.ts](../src/cli/main.ts) (line 184).

Acceptance requirement: Select the expected result/error envelope for each case. Require normal validation-result provenance and bind source/policy/profile/activation identities. Validate errors explicitly.

Amendment: Configuration/input error envelopes intentionally lack validation provenance. Requiring provenance on every JSON output would be wrong. Build identity belongs to artifact metadata, not an invented result field.

### R5-F5: VSIX payload allowlist and crafted archive tests

Baseline: Open. Priority: 1. Original severity: Med.

Evidence: [test/integration/backstage/lib/vsix.mjs](../test/integration/backstage/lib/vsix.mjs) (line 36), [scripts/package-extension.mjs](../scripts/package-extension.mjs) (line 100).

Acceptance requirement: Use a positive payload/dependency allowlist and crafted archive controls for nested SQLite, backend application files, seeds and unrelated dependencies.

Amendment: Confirmed forbidden fixture acceptance. Keep legitimate production catalog-model dependencies. A blanket ban on every @backstage package would break the application.

### R5-F6: Observe editor coverage for parity

Baseline: Partial. Priority: 1. Original severity: Med.

Evidence: [test/integration/backstage/editor/suite.mjs](../test/integration/backstage/editor/suite.mjs) (line 463), [test/integration/backstage/lib/editor.mjs](../test/integration/backstage/lib/editor.mjs) (line 374).

Acceptance requirement: Obtain actual host coverage through an approved read-only interface and compare normalized coverage records with CLI output.

Amendment: Obtaining a guarded fix indirectly proves required coverage eligibility. The boolean is still not an observed coverage array and cannot establish full parity.

### R5-F9: Top-level cleanup and interruption status

Baseline: Open. Priority: 2. Original severity: Low-Med.

Evidence: [scripts/backstage-test-env.mjs](../scripts/backstage-test-env.mjs) (line 823), [test/integration/backstage/lib/driver.mjs](../test/integration/backstage/lib/driver.mjs) (line 269).

Acceptance requirement: Extract or expose host status aggregation for no-Docker tests covering cleanup failure, interruption, failed children and unfinished target reports.

Amendment: Child evidence persistence and cleanup errors have some direct controls. They do not test all host aggregate-status paths.

## H2: LSP behavior and stale-work rejection

### R3-F1: Stale-version test masks the behavior under test

Baseline: Open. Priority: 1. Original severity: High.

Evidence: [test/lsp.test.ts](../test/lsp.test.ts) (line 368), [src/lsp/workspace-state.ts](../src/lsp/workspace-state.ts) (line 194).

Acceptance requirement: After sending stale changes, observe retained content through a request or a later incremental edit that does not overwrite the disputed field.

Amendment: Confirmed by mutation: the unchanged test passes with the stale/equal-version guard removed in an isolated compiled copy.

### R3-F2: Every superseded publication must be rejected

Baseline: Open. Priority: 1. Original severity: Med.

Evidence: [test/lsp.test.ts](../test/lsp.test.ts) (line 319), [test/lsp-owners.test.ts](../test/lsp-owners.test.ts) (line 72).

Acceptance requirement: Assert every captured publication for the target URI has the permitted generation/version after entered/cancelled barriers.

Amendment: Publisher/coordinator tests are stronger now, but the cited wire test still excludes only version 1 and checks the last result.

### R3-F3: Clear already-published findings on close over stdio

Baseline: Partial. Priority: 2. Original severity: Med.

Evidence: [test/lsp.test.ts](../test/lsp.test.ts) (line 341), [extensions/vscode/test/cases/race-close-reopen.case.ts](../extensions/vscode/test/cases/race-close-reopen.case.ts) (line 12), [test/lsp-owners.test.ts](../test/lsp-owners.test.ts) (line 101).

Acceptance requirement: Add a raw stdio control that first observes a nonempty finding and then the empty close notification for that same URI.

Amendment: The installed editor already tests close/reopen behavior and publisher lifetime tests were added. The report's claim of unit-only coverage is too broad.

### R3-F4: Cancellation response contracts

Baseline: Partial. Priority: 2. Original severity: Med.

Evidence: [test/lsp-completion.test.ts](../test/lsp-completion.test.ts) (line 219), [test/lsp-request-context.test.ts](../test/lsp-request-context.test.ts) (line 27).

Acceptance requirement: Assert the allowed cancellation response shape, including isIncomplete where used, over a child stdio server. Add hover and definition cancellation controls.

Amendment: An in-process real JSON-RPC cancellation already proves provider abort and empty items. It is not the complete response-form or feature matrix.

### R3-F5: Watched local candidates must actually change

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/lsp-completion.test.ts](../test/lsp-completion.test.ts) (line 321), [test/lsp-catalog-refresh.test.ts](../test/lsp-catalog-refresh.test.ts) (line 447).

Acceptance requirement: Delete or rename the watched local dependency and prove its formerly present completion disappears after an observable processing barrier.

Amendment: New remote catalog refresh tests do this for remote candidates. The cited local-watch test still sends a Changed notification without changing the file.

### R3-F6: Exact reference-completion result text

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/completion.test.ts](../test/completion.test.ts) (line 133).

Acceptance requirement: Compare each complete resulting source string, then independently parse it and inspect the owner value.

Amendment: Current checks accept any edit containing the reference and retained comment.

### R3-F7: JSON field insertion outcome

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/editor-intelligence.test.ts](../test/editor-intelligence.test.ts) (line 82).

Acceptance requirement: Assert the inserted property/value, preserved existing members and valid JSON. Include insertion with members on both sides.

Amendment: JSON.parse success alone also accepts a no-op edit.

### R3-F8: Independent scalar-edit application

Baseline: Partial. Priority: 2. Original severity: Med.

Evidence: [test/scalar-fixes.test.ts](../test/scalar-fixes.test.ts) (line 17), [test/lsp-fixes-integration.test.ts](../test/lsp-fixes-integration.test.ts) (line 58).

Acceptance requirement: Apply the direct scalar and included-payload edits with TextDocument.applyEdits or an independent offset oracle.

Amendment: Integration and new rule-repair cases already use an independent editor library. The cited direct scalar tests still reuse SourceLineIndex.

### R3-F9: Real scalar, frame, fix and credential boundaries

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/scalar-fixes.test.ts](../test/scalar-fixes.test.ts) (line 110), [test/editor-credentials.test.ts](../test/editor-credentials.test.ts) (line 47), [test/lsp-fixes.test.ts](../test/lsp-fixes.test.ts) (line 7).

Acceptance requirement: Add exact-limit acceptance and limit-plus-one rejection using documented values. Include UTF-8 multibyte scalars and explicit constant-value assertions.

Amendment: Capability and array-index boundary tests added later do not replace these particular boundaries.

### R3-F10: Unfinished-YAML syntax and hover assertions

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/editor-workspace.test.ts](../test/editor-workspace.test.ts) (line 83).

Acceptance requirement: Assert the required diagnostic code/content, expected hover text and plaintext kind in this wire scenario.

Amendment: Other tests now assert plain descriptions, but this named syntax scenario still checks only notification arrival and hover existence.

### R3-F11: Client delivery race versus server pre-dispatch race

Baseline: Clarification. Priority: 3. Original severity: Low.

Evidence: [test/lsp-fixes-integration.test.ts](../test/lsp-fixes-integration.test.ts) (line 190), [test/lsp-fixes-integration.test.ts](../test/lsp-fixes-integration.test.ts) (line 108), [extensions/vscode/test/cases/race-apply-delivery.case.ts](../extensions/vscode/test/cases/race-apply-delivery.case.ts) (line 13), [extensions/vscode/test/cases/race-before-apply.case.ts](../extensions/vscode/test/cases/race-before-apply.case.ts) (line 6).

Disposition requirement: Keep both orderings distinct. No replacement with a different race is needed. Optional test comments can clarify the client-delivery simulation.

Amendment: The cited test intentionally models client rejection after dispatch. Real didChange-before-dispatch and installed suspended-server delivery races already exist.

### R3-F12: Initial index-pending response

Baseline: Open. Priority: 2. Original severity: Low.

Evidence: [test/lsp-completion.test.ts](../test/lsp-completion.test.ts) (line 73), [test/completion.test.ts](../test/completion.test.ts) (line 330).

Acceptance requirement: Gate index preparation and assert the exact early incomplete/empty response, then release it and assert the positive candidate.

Amendment: Eventually polling proves eventual readiness and can hide an incorrect initial reply.

### R3-F13: Synchronization independent of internal awaits

Baseline: Open. Priority: 3. Original severity: Low.

Evidence: [test/lsp-session-resources.test.ts](../test/lsp-session-resources.test.ts) (line 75), [test/lsp-coordinator.test.ts](../test/lsp-coordinator.test.ts) (line 51).

Acceptance requirement: Replace fixed event-loop-turn counts with explicit entered/disposed/activated signals where those events are under test.

Amendment: Many newer concurrency cases already use explicit gates. The cited lifetime tests remain coupled to internal await counts.

### R3-F14: FIFO token boundary survivor

Baseline: Open. Priority: 2. Original severity: Low.

Evidence: [test/lsp-fixes.test.ts](../test/lsp-fixes.test.ts) (line 290).

Acceptance requirement: Prove the oldest token is evicted and the next-oldest remains usable at the exact documented capacity.

Amendment: A newest-token success does not establish the intended capacity.

### R3-F15: Independent client capability gates

Baseline: Open. Priority: 2. Original severity: Low.

Evidence: [test/lsp-fixes-integration.test.ts](../test/lsp-fixes-integration.test.ts) (line 243), [test/harness/lsp-client.ts](../test/harness/lsp-client.ts) (line 101).

Acceptance requirement: Omit each required edit/diagnostic/code-action capability independently and assert no edit dispatch.

Amendment: All-on and all-off cases do not detect a missing individual guard.

### R3-F16: Fixed fixture positions

Baseline: Clarification. Priority: 3. Original severity: Low.

Evidence: [test/lsp.test.ts](../test/lsp.test.ts) (line 368), [test/lsp.test.ts](../test/lsp.test.ts) (line 71).

Disposition requirement: Treat fixed line/character positions as maintenance concerns. Derive incidental cursor locations where fixtures change, while retaining independent expected coordinate vectors.

Amendment: Literal positions are valid test oracles for fixed fixtures. They are not by themselves a behavioral coverage defect.

### R3-H1: Harness can reject dynamic registrations

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [test/harness/lsp-client.ts](../test/harness/lsp-client.ts) (line 68).

Acceptance requirement: Add configurable registration rejection and test host failure/recovery without accepting the registration first.

Amendment: Supplemental harness limitation from the report.

### R3-H2: Harness captures client-visible log messages

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [test/harness/lsp-client.ts](../test/harness/lsp-client.ts) (line 63).

Acceptance requirement: Capture window/logMessage and use it in error-reason and stopped-state controls.

Amendment: Supplemental harness limitation from the report.

### R3-H3: Position encoding negotiation

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [test/harness/lsp-client.ts](../test/harness/lsp-client.ts) (line 99).

Acceptance requirement: Offer alternative and unsupported encodings and verify the protocol negotiation/rejection behavior.

Amendment: The production contract can remain UTF-16. The test must show what happens when another encoding is offered.

### R3-H4: Workspace root negotiation

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [test/harness/lsp-client.ts](../test/harness/lsp-client.ts) (line 97).

Acceptance requirement: Allow variable rootUri/workspaceFolders and test mismatch/containment handling.

Amendment: Installed multi-root coverage exists. It does not exercise every raw initialize/root mismatch.

### R3-U1: Duplicate didOpen

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [src/lsp/workspace-state.ts](../src/lsp/workspace-state.ts) (line 170), [test/harness/lsp-client.ts](../test/harness/lsp-client.ts) (line 95).

Acceptance requirement: Send duplicate opens with different text and prove the first lifetime/source remains authoritative.

Amendment: The implementation guard exists. A direct behavioral test was not found.

### R3-U2: Open-document and change-notification ceilings

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [src/lsp/workspace-state.ts](../src/lsp/workspace-state.ts) (line 174), [src/lsp/workspace-state.ts](../src/lsp/workspace-state.ts) (line 235).

Acceptance requirement: Exercise 1000 accepted versus 1001 rejected documents and content changes, with explicit incomplete/recovery semantics.

Amendment: Request-context capacity is unit-tested through a different operation. It does not establish these boundaries.

### R3-U3: Completion/search budgets, minimum prefix and cache ceilings

Baseline: Partial. Priority: 2. Original severity: not separately assigned.

Evidence: [test/completion.test.ts](../test/completion.test.ts) (line 419), [test/completion.test.ts](../test/completion.test.ts) (line 330), [src/lsp/completion.ts](../src/lsp/completion.ts) (line 35).

Acceptance requirement: Add controlled timing for 50 ms completion and 500 ms search, one-character rejection/two-character admission, and cache-capacity/eviction controls.

Amendment: Cache freshness/rollback, held provider cancellation and responsiveness are already tested. Exact budgets and cache ceilings remain incomplete.

### R3-U4: Fix registry 32-action and 64-candidate ceilings

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [src/lsp/fixes.ts](../src/lsp/fixes.ts) (line 18), [test/lsp-fixes.test.ts](../test/lsp-fixes.test.ts) (line 290).

Acceptance requirement: Test exact actions/candidates capacity, truncation and selection at both edges.

Amendment: The newer 16-candidate evaluation limit is a different bound.

### R3-U5: Wire requests before initialize and after shutdown

Baseline: Partial. Priority: 2. Original severity: not separately assigned.

Evidence: [test/lsp-request-context.test.ts](../test/lsp-request-context.test.ts) (line 29), [test/harness/lsp-client.ts](../test/harness/lsp-client.ts) (line 95).

Acceptance requirement: Add actual JSON-RPC lifecycle/error-response tests around initialization and shutdown.

Amendment: RequestContexts now tests uninitialized/stopped admission. The raw protocol response contract remains uncovered.

### R3-U6: Ambiguous definition produces no target

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [test/editor-intelligence.test.ts](../test/editor-intelligence.test.ts) (line 168), [src/lsp/editor.ts](../src/lsp/editor.ts) (line 937).

Acceptance requirement: Provide competing matching definitions and assert no navigation target while preserving a unique-target positive control.

Amendment: The branch exists in the host but the reported ambiguity control was not found.

### R3-U7: Discovery entry/depth/file limits

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [test/editor-workspace.test.ts](../test/editor-workspace.test.ts) (line 20), [src/lsp/discovery.ts](../src/lsp/discovery.ts) (line 1).

Acceptance requirement: Test the documented 10000-entry, 32-level and 1000-file boundaries and failure/recovery behavior.

Amendment: Matching, exclusion and symlink rejection are already tested at small sizes.

### R3-U8: Credential file exact size and symlink rejection

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [test/editor-credentials.test.ts](../test/editor-credentials.test.ts) (line 47), [src/host/catalog-config.ts](../src/host/catalog-config.ts) (line 27).

Acceptance requirement: Add exact 16 KiB admission and over-limit rejection plus symlink and replacement controls.

Amendment: Rotation and the 16 KiB-plus-one rejection already exist. They do not cover both remaining requirements.

### R3-U9: Schema enum repair application and revalidation

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [test/editor-intelligence.test.ts](../test/editor-intelligence.test.ts) (line 191).

Acceptance requirement: Select an enum repair through the guarded command, independently apply its text edit, send didChange and assert the target rule passes.

Amendment: Proposal enumeration and other rule/const repair round trips do not prove this particular enum path.

## H3: Independent core and CLI controls

### R1-F1: Rules-stage mapping of runtime failures

Baseline: Open. Priority: 1. Original severity: High.

Evidence: [test/cel-rules.test.ts](../test/cel-rules.test.ts) (line 129), [src/core/cel-rules.ts](../src/core/cel-rules.ts) (line 77).

Acceptance requirement: Exercise each failure class through executePolicyRules and assert rule status, reason, coverage, interruption and result exit code.

Amendment: New worker/error tests do not assert the full rules-stage mapping.

### R1-F2: CEL corpus error identity

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/cel-runtime.test.ts](../test/cel-runtime.test.ts) (line 56), [test/fixtures/cel-qualification.json](../test/fixtures/cel-qualification.json) (line 5).

Acceptance requirement: Pin expected error codes in the corpus and assert them for every error case.

Amendment: Dedicated runtime tests already check some exact codes. The corpus still accepts any CelError.

### R1-F3: CEL structural limits

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [src/runtime/cel/evaluator.ts](../src/runtime/cel/evaluator.ts) (line 90), [test/cel-runtime.test.ts](../test/cel-runtime.test.ts) (line 87).

Acceptance requirement: Add attainable positive/negative controls for AST depth/nodes, literal entries and argument counts. State which earlier bound wins when limits overlap.

Amendment: Classification is already implemented: parser failures become parse and invalid_policy. The report overstates that it is undecided.

### R1-F4: CEL function and differential coverage

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/fixtures/cel-qualification.json](../test/fixtures/cel-qualification.json) (line 2), [.github/workflows/ci.yml](../.github/workflows/ci.yml) (line 1).

Acceptance requirement: Add missing positive functions, heterogeneous literals, rejected extension cases and an independent CEL-Go comparison in CI. Repin reviewed corpus inputs.

Amendment: The frozen 43-case corpus remains useful and must not be regenerated from implementation output.

### R1-F5: YAML specification vectors

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/parsing.test.ts](../test/parsing.test.ts) (line 106), [test/parsing.test.ts](../test/parsing.test.ts) (line 161).

Acceptance requirement: Add explicit accepted core tags, YAML 1.2 directive, alias-key cases and a cited core-schema table.

Amendment: Several scalar cases already exist. The missing work is broader specification coverage, not absence of all YAML 1.2 tests.

### R1-F6: Default engine and release boundaries

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/parsing.test.ts](../test/parsing.test.ts) (line 280), [test/policy-releases.test.ts](../test/policy-releases.test.ts) (line 145).

Acceptance requirement: Add exact-default limit and limit-plus-one pairs for the reported parser/CEL/snapshot/release limits, including seven-day authority age and byte-sensitive inputs.

Amendment: New capability pattern and array-index boundaries cover different limits and do not close this finding.

### R1-F7: Independent JSON Schema conformance

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/schema-rules.test.ts](../test/schema-rules.test.ts) (line 18), [src/compatibility/custom-schemas.ts](../src/compatibility/custom-schemas.ts) (line 1).

Acceptance requirement: Vendor a curated official draft-07 conformance subset and test each documented supported or excluded feature.

Amendment: Other schema/metadata tests cover more than type/required/const. There is still no independent official conformance suite.

### R1-F8: SARIF schema conformance in automation

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/cli.test.ts](../test/cli.test.ts) (line 239), [src/reporting/sarif.ts](../src/reporting/sarif.ts) (line 1).

Acceptance requirement: Validate normal, incomplete and error SARIF outputs against a pinned OASIS 2.1.0 schema.

Amendment: Existing field-level assertions remain valuable but do not establish schema conformance.

### R1-F9: Canonical JSON independent vectors

Baseline: Open. Priority: 3. Original severity: Low.

Evidence: [test/json.test.ts](../test/json.test.ts) (line 11), [src/core/json.ts](../src/core/json.ts) (line 23).

Acceptance requirement: Add non-BMP key ordering and ECMAScript numeric representation vectors with independent expected strings.

Amendment: Fixed fixture coordinates and canonical vectors must remain independent of the implementation under test.

### R1-F10: Policy signature failure specificity

Baseline: Open. Priority: 2. Original severity: Low.

Evidence: [test/policy-releases.test.ts](../test/policy-releases.test.ts) (line 117).

Acceptance requirement: Assert the expected failure reason for each tampering variant and verify at least one signature independently with node:crypto.

Amendment: Do not replace every expected failure with a signature error when earlier structural admission is the intended rejection.

### R1-F11: Per-request rule scheduling and prerequisite states

Baseline: Partial. Priority: 2. Original severity: Low.

Evidence: [test/cel-rules.test.ts](../test/cel-rules.test.ts) (line 251), [test/rule-contributions.test.ts](../test/rule-contributions.test.ts) (line 182).

Acceptance requirement: Observe request-specific scheduling against a shared pool and assert blocked dependents after not_applicable and incomplete prerequisites.

Amendment: Shared-pool ceilings and several blocked-prerequisite paths are now tested. They do not cover every reported request-specific case.

### R1-F12: CLI options, signals and output failures

Baseline: Open. Priority: 2. Original severity: Low.

Evidence: [test/cli.test.ts](../test/cli.test.ts) (line 105), [src/cli/main.ts](../src/cli/main.ts) (line 195).

Acceptance requirement: Add subprocess controls for --baseline, --data, --help, SIGINT/SIGTERM and output-write failure exit 2.

Amendment: Current tests cover successful atomic output and several exit-2 paths, but not these specific paths.

### R1-F13: CEL program and regex cache bounds

Baseline: Open. Priority: 3. Original severity: Low.

Evidence: [src/runtime/cel/evaluator.ts](../src/runtime/cel/evaluator.ts) (line 112), [test/cel-runtime.test.ts](../test/cel-runtime.test.ts) (line 35).

Acceptance requirement: Exercise more than 256 distinct programs and patterns and observe bounded cache behavior plus correct recompilation.

Amendment: The implementation clears caches at the ceiling. An LRU policy must not be invented unless the contract requires it.

## H4: Catalog compatibility and convergence

### R2-F1: Permission filtering versus explicit access denial

Baseline: Partial. Priority: 1. Original severity: High (suspected).

Evidence: [test/harness/fake-backstage.ts](../test/harness/fake-backstage.ts) (line 210), [test/catalog-api.test.ts](../test/catalog-api.test.ts) (line 140), [docs/lsp-editor-improvements-implementation-record.md](../docs/lsp-editor-improvements-implementation-record.md) (line 360).

Acceptance requirement: Separate plugin-access rejection from permission-policy DENY in the fake, test filtered results end to end and add a real permission-policy control.

Amendment: Both pinned upstream authorization sources confirm filtered absence. Phase 3 documents the ambiguity. Ordinary missing data cannot prove global nonexistence.

### R2-F2: Raw by-refs compatibility

Baseline: Open. Priority: 2. Original severity: Med (suspected).

Evidence: [test/harness/fake-backstage.ts](../test/harness/fake-backstage.ts) (line 343), [test/catalog-api.test.ts](../test/catalog-api.test.ts) (line 112).

Acceptance requirement: Make raw fake by-refs requests follow pinned request/parser/database behavior. Add canonical, shorthand, malformed and case variants.

Amendment: Pinned upstream request parsing accepts strings without defaulting references. Its database lookup uses the supplied references. The report's lowercasing description also needs correction.

### R2-F3: 404 response classification controls

Baseline: Open. Priority: 1. Original severity: Med.

Evidence: [test/harness/fake-backstage.ts](../test/harness/fake-backstage.ts) (line 21), [src/providers/transport.ts](../src/providers/transport.ts) (line 247).

Acceptance requirement: Allow explicit status/body/content-type fault combinations and test empty, HTML and mismatched 404 bodies as unavailable.

Amendment: invalid-body faults currently return HTTP 200. A by-refs 404 control is not a single-entity malformed-404 control.

### R2-F4: HTTP retry timing and cancellation

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/catalog-provider.test.ts](../test/catalog-provider.test.ts) (line 377), [test/catalog-provider.test.ts](../test/catalog-provider.test.ts) (line 396).

Acceptance requirement: Test retry timing with controlled time, date-form Retry-After, 503 Retry-After, POST retry, disconnect retry and abort during backoff.

Amendment: 503 retry count and connection-wide cooldown already have controls. The remaining timing and method cases are distinct from LSP refresh backoff.

### R2-F5: Substitution parity and deliberate divergences

Baseline: Partial. Priority: 2. Original severity: Med (suspected).

Evidence: [test/backstage-substitutions.test.ts](../test/backstage-substitutions.test.ts) (line 94), [test/backstage-substitutions.test.ts](../test/backstage-substitutions.test.ts) (line 166), [docs/substitutions.md](../docs/substitutions.md) (line 1).

Acceptance requirement: Add pinned upstream-derived behavior tables and document mixed mappings, nested returned placeholders and stricter JSON/YAML handling as explicit profile choices.

Amendment: Both pinned PlaceholderProcessor versions reject non-string resolver targets. The report's suggestion that those targets are left alone is incorrect. Do not change safe local-profile semantics blindly.

### R2-F7: Kind-scoped reference extraction

Baseline: Open. Priority: 2. Original severity: Low.

Evidence: [src/policy/profile.ts](../src/policy/profile.ts) (line 23), [test/backstage-references.test.ts](../test/backstage-references.test.ts) (line 157), [docs/source-references.md](../docs/source-references.md) (line 8).

Acceptance requirement: Either scope default contexts by entity kind or document them as an intentional over-approximation. Add processor-derived relation/reference cases.

Amendment: Pinned BuiltinKindsEntityProcessor scopes relations by kind and emits inverse relations. The current profile is path-based.

### R2-F8: Projection control independence

Baseline: Open. Priority: 3. Original severity: Low.

Evidence: [test/catalog-suggestions.test.ts](../test/catalog-suggestions.test.ts) (line 16), [test/harness/fake-backstage.ts](../test/harness/fake-backstage.ts) (line 256).

Acceptance requirement: Send an intentionally unprojected response and assert client admission/projection, or narrow the claim to the normal projected response.

Amendment: The current absence assertion cannot independently demonstrate client-side stripping.

### R2-F9: Release tag variants

Baseline: Open. Priority: 3. Original severity: Low.

Evidence: [test/release-refresh.test.ts](../test/release-refresh.test.ts) (line 53).

Acceptance requirement: Add lightweight tags, annotated chains and chain-depth rejection controls.

Amendment: The existing fake always returns an annotated tag.

### R2-F10: Complete seed relation expectations

Baseline: Open. Priority: 3. Original severity: Low.

Evidence: [test/backstage-environment.test.ts](../test/backstage-environment.test.ts) (line 66), [test/integration/backstage/data/baseline.json](../test/integration/backstage/data/baseline.json) (line 138).

Acceptance requirement: Compare explicit complete expected relation tuples, including inverse and defaulted relationships.

Amendment: Existence of one ownedBy and one memberOf entry does not validate the intended graph.

### R5-F7: Mutation convergence must exclude obsolete relationships

Baseline: Partial. Priority: 1. Original severity: Med.

Evidence: [test/integration/backstage/lib/catalog.mjs](../test/integration/backstage/lib/catalog.mjs) (line 50), [test/integration/backstage/data/mutation.json](../test/integration/backstage/data/mutation.json) (line 136).

Acceptance requirement: Add absentRelations to the seed schema and convergence check. Assert obsolete ownership/API edges disappear and require the intended component/resource system and inverse edges.

Amendment: Confirmed stale ownership/API relations pass converge. A System-to-Domain partOf expectation already exists, so the report's blanket statement about missing system edges is inaccurate.

### R5-F8: Real CLI failures must assert their specific reason

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [test/integration/backstage/lib/driver.mjs](../test/integration/backstage/lib/driver.mjs) (line 122), [src/providers/transport.ts](../src/providers/transport.ts) (line 265).

Acceptance requirement: Assert native/YAML rule identifiers, incomplete coverage and correct credential/outage reason codes for each case.

Amendment: Current client semantics deliberately combine HTTP 401/403 as permission_denied. Preserve that contract or document/change it explicitly rather than asserting a nonexistent distinction.

### R5-F10: Reader-token write restriction

Baseline: Open. Priority: 2. Original severity: Low-Med (suspected).

Evidence: [test/integration/backstage/app-config.test.yaml](../test/integration/backstage/app-config.test.yaml) (line 32), [test/integration/backstage/lib/driver.mjs](../test/integration/backstage/lib/driver.mjs) (line 105).

Acceptance requirement: Use a known valid non-read endpoint with administrator and reader positive controls, then prove the intended reader restriction. Otherwise mark it unverified.

Amendment: The current authentication matrix exercises read endpoints. This review did not execute a new real-backend authorization experiment.

## H5: Installed editor outcomes and measurement policy

### R4-F1: Performance budgets and readiness timeouts overlap

Baseline: Open. Priority: 1. Original severity: High.

Evidence: [extensions/vscode/test/endurance.ts](../extensions/vscode/test/endurance.ts) (line 49), [extensions/vscode/test/fixture.ts](../extensions/vscode/test/fixture.ts) (line 17).

Acceptance requirement: Choose stated, initially provisional performance requirements and separate percentile budgets from larger observation timeouts. Add controls that exceed a budget without timing out.

Amendment: The claim that none of these budgets can ever fail is too absolute: cold/edit/restart measurements include multiple awaited stages. The overlapping completion budget remains especially weak.

### R4-F2: Resource measurement windows and budget rationale

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [extensions/vscode/test/resources.ts](../extensions/vscode/test/resources.ts) (line 37), [extensions/vscode/test/endurance.ts](../extensions/vscode/test/endurance.ts) (line 58), [test/extension-resources.test.ts](../test/extension-resources.test.ts) (line 20).

Acceptance requirement: Document or remove the extra quarter-window exclusion. Test a leak inside the discarded interval and justify caps from requirements. State that short runs do not measure a 100-operation slope.

Amendment: Negative growth tests exist and long epochs exercise slope. This does not justify silently excluding additional post-warmup samples.

### R4-F3: Configuration failures must fail for the expected reason

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [extensions/vscode/test/configuration-recovery.ts](../extensions/vscode/test/configuration-recovery.ts) (line 7), [extensions/vscode/test/cases/config-missing.case.ts](../extensions/vscode/test/cases/config-missing.case.ts) (line 2).

Acceptance requirement: For each installed configuration-fault mode, inspect the expected sanitized message or code, then prove recovery.

Amendment: A generic failure to start can satisfy every mode.

### R4-F4: Unapproved-file absence needs an ordered barrier

Baseline: Open. Priority: 2. Original severity: Med (suspected).

Evidence: [extensions/vscode/test/cases/workspace-multi-root.case.ts](../extensions/vscode/test/cases/workspace-multi-root.case.ts) (line 25).

Acceptance requirement: After opening the unapproved document, obtain a positive approved-document round trip and assert same-server continuity before absence checks.

Amendment: The test already obtains an approved diagnostic before the unapproved open. That earlier event does not establish processing of the later event.

### R4-F5: Dirty-watch processing barrier

Baseline: Open. Priority: 2. Original severity: Med (suspected).

Evidence: [extensions/vscode/test/cases/race-dirty-watch.case.ts](../extensions/vscode/test/cases/race-dirty-watch.case.ts) (line 13).

Acceptance requirement: Prove the relevant native watcher event was processed while the dirty buffer remained authoritative before checking absence.

Amendment: A generic fresh action does not identify the filesystem event. Later revert/repair controls test another state.

### R4-F6: Picker cancellation and stale-selection completion barrier

Baseline: Open. Priority: 2. Original severity: Med (suspected).

Evidence: [extensions/vscode/test/cases/editor-search.case.ts](../extensions/vscode/test/cases/editor-search.case.ts) (line 49), [extensions/vscode/src/extension.ts](../extensions/vscode/src/extension.ts) (line 41).

Acceptance requirement: Wait for observable picker-command completion or the specific stale-selection rejection before asserting unchanged text.

Amendment: Native Enter/Escape acknowledgements do not prove the asynchronous command finished. Positive insertion already has a text barrier.

### R4-F8: User-visible crash and stop outcomes

Baseline: Partial. Priority: 2. Original severity: Med.

Evidence: [extensions/vscode/test/cases/server-crash.case.ts](../extensions/vscode/test/cases/server-crash.case.ts) (line 13), [extensions/vscode/test/cases/shutdown.case.ts](../extensions/vscode/test/cases/shutdown.case.ts) (line 9).

Acceptance requirement: Assert the expected output message, diagnostic state and no new findings after a later edit while stopped.

Amendment: Actual process death and recovery are already observed. The report overstates reliance on status flags, but the user-visible checks remain absent.

### R4-F9: Configuration reload must change behavior

Baseline: Open. Priority: 2. Original severity: Low-Med.

Evidence: [extensions/vscode/test/cases/editor-intelligence.case.ts](../extensions/vscode/test/cases/editor-intelligence.case.ts) (line 47), [test/editor-workspace.test.ts](../test/editor-workspace.test.ts) (line 111).

Acceptance requirement: Change trusted policy or selected sources before installed reload, then assert changed suggestions/diagnostics with the same server.

Amendment: Window-reload and source-level configuration tests cover different paths. The cited installed command can still be a no-op.

### R4-F10: Diagnostic disappearance must not be explained by server death

Baseline: Partial. Priority: 2. Original severity: Low-Med (suspected).

Evidence: [extensions/vscode/test/cases/versioned-fix.case.ts](../extensions/vscode/test/cases/versioned-fix.case.ts) (line 13), [extensions/vscode/test/cases/catalog-refresh.case.ts](../extensions/vscode/test/cases/catalog-refresh.case.ts) (line 10), [extensions/vscode/test/cases/rule-contributions.case.ts](../extensions/vscode/test/cases/rule-contributions.case.ts) (line 99).

Acceptance requirement: Add same-PID/running and surviving-finding controls to the remaining legacy disappearance scenarios.

Amendment: New catalog-refresh and rule-contribution scenarios already include these positive controls. Several older watcher/fix/trust scenarios still do not.

### R4-F11: Saturation branch must actually execute

Baseline: Open. Priority: 2. Original severity: Low-Med.

Evidence: [extensions/vscode/test/cases/endurance-saturation.case.ts](../extensions/vscode/test/cases/endurance-saturation.case.ts) (line 39).

Acceptance requirement: Deterministically produce an incomplete validation and require the no-guarded-fix branch to execute before recovery.

Amendment: All observed runs can complete without entering the branch.

### R4-U1: Installed search clipboard and persisted ranking

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [extensions/vscode/test/cases/editor-search.case.ts](../extensions/vscode/test/cases/editor-search.case.ts) (line 30), [test/extension-client.test.ts](../test/extension-client.test.ts) (line 1).

Acceptance requirement: Test no-editor clipboard fallback and actual installed history ranking/persistence across a fresh client activation.

Amendment: Current installed picker selection/cancellation tests do not exercise these branches.

### R4-U2: Installed hover constraints and ambiguous navigation

Baseline: Partial. Priority: 2. Original severity: not separately assigned.

Evidence: [extensions/vscode/test/cases/rule-contributions.case.ts](../extensions/vscode/test/cases/rule-contributions.case.ts) (line 40), [extensions/vscode/test/cases/editor-intelligence.case.ts](../extensions/vscode/test/cases/editor-intelligence.case.ts) (line 33).

Acceptance requirement: Assert actual constraint text and empty results for ambiguous definitions in the installed editor.

Amendment: Declared-rule descriptions/provenance and unique navigation now have installed controls. This closes part of the earlier broad absence claim.

### R4-U3: Installed discovery and reload failure behavior

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [extensions/vscode/test/cases/editor-intelligence.case.ts](../extensions/vscode/test/cases/editor-intelligence.case.ts) (line 47), [test/editor-workspace.test.ts](../test/editor-workspace.test.ts) (line 20).

Acceptance requirement: Exercise real installed include/exclude selection, discovery bounds and fail-closed configuration recovery.

Amendment: Source-level discovery/reload controls exist. They are not installed-client qualification.

### R4-U4: Installed credential-file rotation without restart

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [test/editor-credentials.test.ts](../test/editor-credentials.test.ts) (line 9), [extensions/vscode/test/cases/rule-contributions.case.ts](../extensions/vscode/test/cases/rule-contributions.case.ts) (line 12).

Acceptance requirement: Rotate the actual configured token file while the installed server remains alive, observe denial/recovery and reject old repairs.

Amendment: Source/provider rotation and protocol credential-revision replacement are distinct controls.

### R4-U5: Installed dependency-warning and policy-error severity

Baseline: Open. Priority: 2. Original severity: not separately assigned.

Evidence: [test/lsp.test.ts](../test/lsp.test.ts) (line 288), [extensions/vscode/test/cases/catalog-refresh.case.ts](../extensions/vscode/test/cases/catalog-refresh.case.ts) (line 7).

Acceptance requirement: Assert both severities on actual installed client diagnostics with positive rule/category controls.

Amendment: Raw stdio severity assertions do not establish the installed representation.

## H6: Evidence inventories and documentation

### R2-F6: Fake-contract versus real-backend claims

Baseline: Partial. Priority: 3. Original severity: Med.

Evidence: [docs/testing-harness.md](../docs/testing-harness.md) (line 156), [test/catalog-provider.test.ts](../test/catalog-provider.test.ts) (line 167), [docs/lsp-separation-implementation-record.md](../docs/lsp-separation-implementation-record.md) (line 128).

Acceptance requirement: Describe fake API-contract coverage accurately and distinguish the native-model pins from backend pins. Parameterize provider paths that need two-target evidence.

Amendment: Later real-backend development reports pass both versions at different revisions. A retained older hosted release report covers both. These do not turn fake-only tests into real-backend tests.

### R2-F11: Stale catalog harness documentation

Baseline: Open. Priority: 3. Original severity: Low (docs).

Evidence: [docs/testing-harness.md](../docs/testing-harness.md) (line 140), [docs/catalog-provider.md](../docs/catalog-provider.md) (line 4), [docs/backstage-compatibility.md](../docs/backstage-compatibility.md) (line 32).

Acceptance requirement: Update implemented by-query behavior, supported backend patch versions and stale qualification statements.

Amendment: Preserve dated historical evidence while correcting current claims.

### R4-F14: Scenario counts and qualification scope

Baseline: Partial. Priority: 3. Original severity: Low (docs).

Evidence: [docs/vscode-qualification.md](../docs/vscode-qualification.md) (line 9), [docs/lsp-editor-improvements-implementation-record.md](../docs/lsp-editor-improvements-implementation-record.md) (line 486).

Acceptance requirement: Label the 44-case cross-OS baseline explicitly and distinguish the current 46-case Linux inventory. Derive counts from versioned inventories where possible.

Amendment: The original 42-case number was corrected. New phase records now contain 92 ordinary executions. Do not imply new cross-OS qualification by simply replacing 44 with 46.

### R4-F15: Screenshot evidence integrity

Baseline: Open. Priority: 3. Original severity: Low.

Evidence: [scripts/extension-test-ui.mjs](../scripts/extension-test-ui.mjs) (line 209), [extensions/vscode/test/qualification.ts](../extensions/vscode/test/qualification.ts) (line 3).

Acceptance requirement: Verify required screenshots exist, are nonempty valid PNGs and correspond to declared UI steps, or describe them as optional diagnostic evidence.

Amendment: The current screenshot function writes decoded bytes without validating them. Product trust assertions provide separate evidence.

### R5-F11: Release caller documentation and upload regression guard

Baseline: Partial. Priority: 3. Original severity: Low.

Evidence: [test/backstage-release-workflow.test.ts](../test/backstage-release-workflow.test.ts) (line 48), [test/backstage-release-workflow.test.ts](../test/backstage-release-workflow.test.ts) (line 77), [docs/backstage-release-test-plan.md](../docs/backstage-release-test-plan.md) (line 333), [.github/workflows/backstage-release-qualification.yml](../.github/workflows/backstage-release-qualification.yml) (line 76).

Acceptance requirement: Explain the manually approved release path exposed through ci.yml and assert always() on evidence upload in the static test.

Amendment: Automated ordinary CI already avoids Docker. Manual exact-revision gating and actual always() upload are implemented. The outstanding work is accurate documentation and guarding that behavior.

### R5-F12: Independent evidence fixtures and targeted invalid mutations

Baseline: Open. Priority: 3. Original severity: Low.

Evidence: [test/backstage-release-evidence.test.ts](../test/backstage-release-evidence.test.ts) (line 95), [test/backstage-release-evidence.test.ts](../test/backstage-release-evidence.test.ts) (line 148).

Acceptance requirement: Add an independent recorded/golden valid fixture or independent inventory expectations plus mutations for wrong editor version, SQLite driver and empty targets.

Amendment: Constructing a valid unit fixture from expected inputs is not inherently wrong. The missing independent check can conceal a shared expectation-loader omission.

### R5-F13: Proposal path and policy validity evidence

Baseline: Open. Priority: 3. Original severity: Low (docs).

Evidence: [docs/backstage-release-test-plan.md](../docs/backstage-release-test-plan.md) (line 71), [test/integration/backstage/lib/clients.mjs](../test/integration/backstage/lib/clients.mjs) (line 38).

Acceptance requirement: Reconcile the documented proposals directory with inline proposals and retain the relevant policy validity/expiry metadata in sanitized evidence.

Amendment: The engine already checks policy authority during execution. The remaining issue is reproducible harness documentation and evidence.

## H7: Deferred client and final release qualification

### R4-F7: Abrupt remote transport loss

Baseline: Open. Priority: 2. Original severity: Med.

Evidence: [extensions/vscode/test/cases/remote-session.case.ts](../extensions/vscode/test/cases/remote-session.case.ts) (line 109), [scripts/test-extension-remote.mjs](../scripts/test-extension-remote.mjs) (line 544).

Acceptance requirement: Add an entered-session connection-loss or network-cut stage and observe remote cleanup/recovery before host teardown.

Amendment: Current real remote sessions prove graceful close/reconnect. Abrupt loss is distinct and belongs with future client qualification.

### R4-F12: Late activation in restricted or virtual workspaces

Baseline: Open. Priority: 3. Original severity: Low (suspected).

Evidence: [extensions/vscode/test/cases/compat-virtual.case.ts](../extensions/vscode/test/cases/compat-virtual.case.ts) (line 13), [extensions/vscode/test/trust.ts](../extensions/vscode/test/trust.ts) (line 57).

Acceptance requirement: Use a defined activation/settling barrier and recheck inactivity, absent commands and unchanged diagnostics.

Amendment: Native Trust and virtual-workspace tests are real. Their early inactivity assertion can still miss delayed activation. Trust reliability work remains deferred.

## Pinned upstream evidence

These sources informed the amended Backstage requirements.
They are immutable source references, not evidence of an executed backend test.
H4 must retain explicit profile differences and execute its required backend controls.

- [entities-1.55.3.ts](https://github.com/backstage/backstage/blob/6c66969256572989ed10ee862b26065a0980c0bd/plugins/catalog-backend/src/service/DefaultEntitiesCatalog.ts).
- [entities-1.56.3.ts](https://github.com/backstage/backstage/blob/7e29caf1d87edb3c51bd07f85d0f7f8c4f0a33c0/plugins/catalog-backend/src/service/DefaultEntitiesCatalog.ts).
- [entities-request-1.55.3.ts](https://github.com/backstage/backstage/blob/6c66969256572989ed10ee862b26065a0980c0bd/plugins/catalog-backend/src/service/request/entitiesBatchRequest.ts).
- [authorized-1.55.3.ts](https://github.com/backstage/backstage/blob/6c66969256572989ed10ee862b26065a0980c0bd/plugins/catalog-backend/src/service/AuthorizedEntitiesCatalog.ts).
- [authorized-1.56.3.ts](https://github.com/backstage/backstage/blob/7e29caf1d87edb3c51bd07f85d0f7f8c4f0a33c0/plugins/catalog-backend/src/service/AuthorizedEntitiesCatalog.ts).
- [placeholder-1.55.3.ts](https://github.com/backstage/backstage/blob/6c66969256572989ed10ee862b26065a0980c0bd/plugins/catalog-backend/src/processors/PlaceholderProcessor.ts).
- [placeholder-1.56.3.ts](https://github.com/backstage/backstage/blob/7e29caf1d87edb3c51bd07f85d0f7f8c4f0a33c0/plugins/catalog-backend/src/processors/PlaceholderProcessor.ts).
- [builtin-kinds-1.55.3.ts](https://github.com/backstage/backstage/blob/6c66969256572989ed10ee862b26065a0980c0bd/plugins/catalog-backend/src/processors/BuiltinKindsEntityProcessor.ts).

# Test harness remediation plan

Status: approved for sequential implementation of H1 through H6. H7 remains deferred.
Plan and approval date: 2026-11-10.
Original assessment revision: `865a68e7fe2aa9c55f991f345ab4c6dea293907e`.
Implementation baseline: `38085eed9e2a77ebe50b414a23aaf21c6004c199`, merged [PR #3](https://github.com/chtaylo3/backstage-validation-engine/pull/3) on `master`.
Work branch: `feature/test-harness-remediation`.

This plan addresses the intent-versus-implementation review with the corrections from the follow-up assessment.
It defines what each test must prove, the evidence required for acceptance, and the order for implementation.
The [finding register](test-harness-remediation-findings.md) supplies a separate acceptance requirement for every finding.
The [agent handoff](test-harness-remediation-handoff.md) defines implementation instructions.
The [implementation record](test-harness-remediation-record.md) records package evidence and parent acceptance.

## Baseline and authority

The original review is the user-owned, untracked `out/test-harness-review.md`.
Its SHA-256 is `3814987bbc5b962b5638cecde322054d33db400d52a7ae212adec7e5530cd5d7`.
Preserve that file without changes. The register makes this plan usable without that local file.
The original report names revision `5a277c3`, which no longer resolves after history replacement.
The assessment compares current files with the report text. It does not claim an exact diff from that revision.

The assessment contains 68 numbered findings: 52 open, 14 partial, and two requiring clarification.
It also contains 18 supplemental gaps: 15 open and three partial.
These counts describe evidence gaps. They do not imply 67 application defects.
Partial coverage does not prove when a test was added.

The accepted LSP work uses source/test revision `54ce7a932c46b85e70f3fec0a68c15852af7e28b` for its final local qualification.
The [LSP implementation record](lsp-editor-improvements-implementation-record.md#final-executed-qualification) states its scope and limits.
That evidence remains historical. It does not qualify later remediation changes.

## Scope and approval

The user approved proceeding after the parent described H1 and the sequential package handoff.
The active scope is H1 through H6, with one package assigned to one subagent at a time.
Parent acceptance is required before the next package starts. H7 is not admitted by this approval.
The parent can divide a large package into small commits while preserving its complete acceptance gate.
Each package can have a separate PR. Do not add remediation implementation to PR #3.

H7 remains deferred. It overlaps the previously deferred LSP phase 5 and requires separate user authorization.
External executable plugin loading, SQS, Kafka, hosted governance, package publication, and automated PR merging remain outside this plan.
Preserve the shared engine, contract 0.2 behavior, capability ownership rules, and current credential boundaries.
A product defect found through stronger tests needs the smallest justified correction and its regression control.
Document any public contract change before implementation. Do not invent a new field or failure code to satisfy a test.

Implementation also identified [open finding N1](test-harness-remediation-record.md#additional-open-finding-n1), beyond the original 86 findings.
Duplicate-key CEL map literals retain the last value in both pinned implementations, despite the language-defined error.
N1 remains unresolved and receives no conformance or supported-vector claim. H6 must preserve that disposition.
This finding does not expand H7 or authorize an additional language-semantics change.

## Delivery order

| Package | Outcome                                                            | Dependency                                        | State    |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------- | -------- |
| H1      | Release evidence rejects false success                             | Approval and baseline recorded                    | Accepted |
| H2      | LSP tests prove observable behavior and reject stale work          | Accepted H1                                       | Accepted |
| H3      | Core and CLI tests use independent contracts and boundary controls | Accepted H2                                       | Accepted |
| H4      | Catalog fixtures and convergence match declared backend behavior   | Accepted H3                                       | Accepted |
| H5      | Installed tests prove the intended editor outcomes                 | Accepted H4                                       | Admitted |
| H6      | Evidence inventories and documentation state the actual scope      | Accepted H5                                       | Waiting  |
| H7      | Final client, transport, and endurance qualification               | Separate authorization and accepted H1 through H6 | Deferred |

Package ownership is exhaustive and exclusive in the register.
Cross-package dependencies can share helpers, but each finding has one accountable package.
H1 cannot claim final installed-performance qualification before H5 defines its approved budget policy.
H4 owns the real-backend proof for permission filtering and reader restrictions.
H7 owns release-wide client qualification, not the focused real-backend controls needed to accept H4.

## Shared acceptance requirements

An oracle is the independent expected result of a test.
A positive control demonstrates that valid input succeeds.
A negative control demonstrates that a specific invalid state fails for the intended reason.
Each new behavioral test needs an observable outcome and both controls where the behavior has two sides.
Use the public CLI, child stdio server, installed extension, or actual host runner when the requirement concerns that boundary.
Direct helper tests can support those controls but cannot replace them.

Use fixed specification vectors, independently authored fixtures, published schemas, or a separate client library for expected results.
Do not derive expected values from the same implementation that produces the actual result.
Do not let a successful empty result prove coverage. Observe the required finding, rule state, or coverage record.
Before asserting absence, obtain an ordered processing barrier and prove that the relevant service remains alive.
Retain every diagnostic publication within a race window. A correct final result cannot excuse an earlier stale publication.

Use controlled time and entered/released gates for deterministic timing and ordering.
Do not use arbitrary sleeps or internal await counts as proof that an operation completed.
Keep observation timeouts larger than product budgets. A test must distinguish a budget violation from an observation timeout.
State the units and inclusivity of each limit. Test the binding limit when several bounds overlap.
Avoid allocating unbounded fixtures to reach a deliberately bounded path.

For each repaired false-success path, retain a focused fault-injection demonstration.
The faulty variant must fail the new test, and the corrected variant must pass.
Use isolated copies or explicit test seams. Do not leave disabled guards or modified dependencies in the source tree.
Broad mutation-testing adoption is outside this plan. The required controls target the reviewed defects.

Preserve coverage thresholds, existing assertions, failure logs, and unchanged-rerun evidence.
Do not skip a failing case, increase a budget, or change an expected answer solely to make the gate pass.
Record a justified requirement change separately from the implementation that follows it.
Use repository-relative paths and synthetic identities in tracked documents and evidence.
Do not expose tokens, local connection details, private workstation paths, or database contents.

## H1: reject false success in release evidence

### Implementation and documentation

Start with the actual host execution path for missing reports, build failure, editor crash, and cleanup status.
Introduce a narrow injectable process/environment boundary only if the runner lacks a usable test seam.
Keep production orchestration in the exercised path. Write scratch reports outside the release evidence inventory.
Separate the injected target failure from the expected failure of the containing control case.

Validate the report variant expected by each CLI scenario.
Normal validation results require their declared provenance. Input and configuration errors require their existing error envelope.
Bind source, policy, profile, and activation fields to independent expected identities.
Bind build identity through artifact metadata. Do not add an undocumented build field to validation results.

Replace the editor parity success boolean with actual normalized coverage observations.
Keep this observation read-only and host-approved. Do not expose credentials or general debug access through the protocol.
Compare the same pinned source, policy, and native profile in the CLI and editor.
Retain a negative mismatch control and an unrelated failing rule.

Define an explicit VSIX payload and dependency policy from the actual runtime closure.
Permit required production dependencies, including `@backstage/catalog-model`.
Reject unrelated packages, backend application files, seeds, SQLite files, and undeclared lockfiles at every nested path.
Retain explicitly declared production lock metadata needed to identify the immutable dependency graph.
Cover misleading filenames and path normalization. The normal packaged candidate must still pass.

Make the release metric verdict recompute applicable budget and resource decisions from raw samples.
Reject absent budgets, malformed measurements, inconsistent summaries, and insufficient required measurement windows.
Until H5 accepts a revised policy, enforce the declared current policy and label its limitations.
H5 must rerun these controls after any approved budget change.
Update the release plan, evidence contract documentation, and VS Code qualification guide where these rules change.

### Acceptance criteria

- H1-A1: Missing-report and build-failure controls execute the real host path and produce the expected case rows, aggregate failure, and exit status.
- H1-A2: The editor crash control observes an entered editor, its actual death, host classification, subsequent-case execution, and owned-process cleanup.
- H1-A3: Cleanup failure, interrupted children, unfinished reports, and failed children cannot yield a successful aggregate result.
- H1-A4: Each expected CLI result or error shape is admitted explicitly. Removing normal-result provenance or changing a bound identity fails the scenario.
- H1-A5: CLI/editor parity compares actual coverage records. An injected missing or mismatched required record fails parity.
- H1-A6: The clean VSIX passes. Crafted forbidden contents fail inspection independently of filename depth or archive ordering.
- H1-A7: Excessive latency, RSS, growth, or an insufficient required slope window fails the metric verdict without relying on workload exit status.
- H1-A8: Focused no-Docker controls pass. Production-backend scenarios remain declared when they require later H4 evidence.

### Validation and handoff

Run the affected runner, evidence, package, client, and verifier tests.
Run types and lint if the host seam or protocol projection changes.
Record the normal inventory and scratch inventories separately.
H1 acceptance proves verifier behavior, not final performance compliance or a new real-backend release qualification.

## H2: prove LSP behavior and stale-work rejection

### Implementation and documentation

First repair the stale-version and superseded-publication controls.
Observe retained source immediately after a stale change. Do not overwrite the disputed field before observation.
Capture all publications for the target URI after explicit entered/cancelled barriers.
Make a guard-removed isolated variant fail the stale-version test.

Extend the child stdio harness to reject dynamic registration, capture logs, vary roots, and offer position encodings.
Test requests before initialization, after shutdown, and during cancellation through actual JSON-RPC responses.
Keep the supported UTF-16 contract. State the negotiated response for other offers.
Observe a nonempty diagnostic before close, then the empty notification for that URI.

Apply edits with `TextDocument.applyEdits` or an independent offset implementation.
Compare complete expected text, then parse it and inspect the intended field and preserved members.
Change the actual watched dependency and wait for its processing barrier.
Gate index construction to observe the initial incomplete response before the ready response.
Test each client capability independently and test ambiguous navigation with a unique-target positive control.

Cover exact document, change, discovery, credential, cache, action, and candidate limits from the register.
Keep the existing 16-candidate evaluation bound separate from action and candidate proposal limits.
Use an independent wall-clock guard for resource safety, without replacing controlled-time budget assertions.
Document client-visible lifecycle, limits, cancellation, and credential behavior in the LSP and editor guides.

### Acceptance criteria

- H2-A1: The isolated stale-version faulty variant fails. Equal or older changes cannot affect the observed authoritative source.
- H2-A2: Every publication in each controlled race satisfies the permitted document lifetime, version, and generation.
- H2-A3: Raw stdio tests cover close clearing, allowed cancellation shapes, registration rejection, encoding/root negotiation, and protocol lifecycle errors.
- H2-A4: Field, value, scalar, included-payload, and enum repairs produce the independently expected text and pass the intended revalidation.
- H2-A5: A real local file deletion or rename removes its candidate after an observable watch-processing event.
- H2-A6: Exact limits have admitted and rejected controls, documented units, bounded cleanup, and a recovery observation.
- H2-A7: Clarifications R3-F11 and R3-F16 preserve legitimate race tests and fixed independent coordinate vectors.
- H2-A8: Focused source and packaged stdio tests pass without changing the shared engine or weakening host admission.

### Validation and handoff

Run the affected workspace, coordinator, request, completion, fix, discovery, credential, and intelligence suites.
Exercise the packaged stdio entrypoint where the changed assertions concern the wire protocol.
Record actual selected test names and counts. A harness option without a test that uses it does not close a gap.

## H3: complete independent core and CLI controls

### Implementation and documentation

Start with rules-stage failure mapping through `executePolicyRules`.
Assert rule state, reason, required coverage, interruption, and CLI exit behavior for each declared failure class.
Cover request-specific scheduling and blocked prerequisites against the shared pool.

Keep the CEL corpus frozen until a reviewed update pins explicit inputs, expected error codes, and provenance.
Add missing supported functions, mixed literals, excluded extensions, and an independent CEL-Go comparison.
Pin the external comparator toolchain and version. Keep normal corpus tests offline and deterministic.
A separate CI comparison can use the pinned comparator without requiring network access in each source test.
Record and approve any intentional semantic difference before changing corpus expectations.

Add cited YAML core-schema vectors, a curated official draft-07 subset, and pinned OASIS SARIF schema admission.
Retain source licenses and integrity digests for vendored vectors and schemas.
Distinguish supported behavior, explicit exclusions, and deliberate stricter admission.
Use independent canonical JSON vectors and at least one independent cryptographic signature control.

Test default limits at the documented boundary, including multibyte inputs and seven-day authority age.
If an earlier limit makes a deeper ceiling unreachable, prove the earlier rejection and document that relationship.
Exercise more than 256 distinct programs and patterns without inventing an LRU promise.
Use subprocess controls for CLI options, signals, and output-write failures with bounded child cleanup.
Update parsing, CEL, contracts, and CLI guides for supported semantics and failure reasons.

### Acceptance criteria

- H3-A1: Each runtime failure class maps to the independently expected rule state, coverage, interruption, and exit status.
- H3-A2: Every CEL corpus error checks its expected identity. The pinned independent comparator reports reviewed matches or explicit documented differences.
- H3-A3: YAML, JSON Schema, canonical JSON, SARIF, and signature controls use independently sourced expected results.
- H3-A4: Documented limits have exact admitted/rejected controls or an explicit proof that an earlier limit binds first.
- H3-A5: Request-specific scheduling, blocked prerequisites, and bounded cache recompilation have positive and negative observations.
- H3-A6: CLI option, signal, and write-failure controls exercise subprocess behavior and assert exact outcomes without leaked children.
- H3-A7: The full source/client gate and packaged CLI regressions pass with existing thresholds and frozen historical evidence preserved.

### Validation and handoff

Run focused core and CLI suites during development, followed by the package acceptance gates above.
Retain the independent comparator version, corpus digest, schema origins, and license records.
Do not substitute successful compilation for behavioral conformance.

## H4: establish catalog compatibility and convergence evidence

### Implementation and documentation

Separate explicit plugin access rejection from permission-policy filtering in the fixture model.
Use pinned backend sources and actual backend controls for permission-filtered absence.
Do not claim that missing data establishes global deletion.
Cover malformed status/body/content-type combinations, raw by-refs variants, retry timing, cancellation, projection, and tag resolution.

Create reviewed behavior tables for substitutions and relation extraction.
Keep safe local restrictions as explicit profile choices where upstream differs.
Either scope reference contexts by entity kind or label and test the intentional over-approximation.
Compare complete expected graph tuples, including relevant inverse and defaulted edges.

Extend seed admission with expected-absent relations and reject obsolete edges during convergence.
Do not require unrelated or generated graph edges to disappear without a declared expectation.
Cover the existing System-to-Domain expectation and the missing component/resource and inverse directions.
Record catalog convergence separately from client cache convergence.

Use real CLI outcomes for native errors, YAML errors, unavailable data, and credential failures.
Preserve the existing `permission_denied` contract for HTTP 401/403 unless a versioned change is separately approved.
Prove reader restrictions with a known valid non-read endpoint, an administrator positive control, and a reader read positive control.
Do not add unsupported production write features merely to make this test possible.
Update compatibility, substitutions, reference, provider, and Backstage environment documentation.

### Acceptance criteria

- H4-A1: Fixture controls distinguish explicit rejection from filtered absence, and focused real-backend cases prove the declared permission behavior.
- H4-A2: Canonical, shorthand, malformed, and case variants match the pinned raw by-refs contract or a documented client normalization step.
- H4-A3: Empty, HTML, and mismatched 404 responses cannot become authoritative missing entities.
- H4-A4: Controlled retry cases assert method, timing, cancellation, attempt count, and final classification.
- H4-A5: Substitution, projection, reference, tag, and graph tests use independent expected cases and explicit deliberate divergences.
- H4-A6: Convergence rejects obsolete required-absent edges and accepts the complete declared graph after actual ingestion.
- H4-A7: Real-backend CLI cases assert the intended rule or failure reason. Reader restriction controls demonstrate an actual authorization difference.
- H4-A8: Both supported backend targets run the applicable focused cases with exact application and artifact identities recorded.

### Validation and handoff

Use no-Docker fixture/unit tests for normal iteration.
Use existing locked Backstage applications and normal ingestion for the focused real-backend acceptance cases.
Never insert SQLite rows directly. Keep generated data and credentials outside tracked files.
Preserve the existing CI host-network and Docker Desktop/WSL2 published-port approaches to authenticated SSH testing.
Record an unavailable environment as blocked evidence. Do not mark the associated finding accepted without the required run.

## H5: prove installed editor outcomes and measurement policy

### Implementation and documentation

Replace generic failure assertions with the expected sanitized error or code and an observed recovery.
Add ordered barriers after unapproved opens, watcher events, and picker cancellation or stale selection.
Change actual trusted configuration before reload and prove changed behavior with the same server.
Require an incomplete saturation branch to execute and then recover.
For disappearing findings, retain a surviving finding and prove same-server continuity.

Cover installed search clipboard/history behavior, hover constraints, ambiguous definitions, discovery recovery, credential rotation, and severity.
Use installed editor observations rather than only source-provider tests.
Retain source digests, document versions, policy identity, and PID observations where needed.
Keep native Workspace Trust activation redesign and abrupt transport loss in H7.

Define the performance policy before changing thresholds.
State normative or provisional budgets, units, percentile calculation, warmup, sample inclusion, and minimum operation counts.
Record current measurements and the reason for each proposed threshold.
Separate budget failure from a larger observation timeout. Do not present short runs as slope qualification.
Remove or justify the additional discarded quarter-window and demonstrate a leak in that interval.
Feed the accepted policy into H1's independent metric verdict and rerun its faulty-input controls.
Update the VS Code qualification and editor guides with the supported observation scope.

### Acceptance criteria

- H5-A1: Each configuration fault fails for its expected reason and recovers through the intended installed command.
- H5-A2: Every absence assertion covered by this package follows a relevant processing barrier and a live-server positive control.
- H5-A3: Reload changes actual suggestions or diagnostics while retaining the server PID. Stop/crash cases expose the expected user-visible state.
- H5-A4: Saturation tests prove that the incomplete branch executed and that guarded fixes remain unavailable until valid recovery.
- H5-A5: Each supplemental installed-editor gap has an actual installed positive and negative control.
- H5-A6: The documented performance policy rejects over-budget samples before the observation timeout and measures only its declared windows.
- H5-A7: H1's metric controls pass under the accepted policy, including a retained leak and insufficient-slope negative control.
- H5-A8: Focused installed cases pass on both supported VS Code versions for the available platform. Reports name that platform explicitly.

### Validation and handoff

Run affected source/client gates and installed cases against one exact candidate per platform/version matrix.
Retain the VSIX digest, server revision, expected inventory, actual case results, and raw measurements.
Do not infer cross-platform qualification from a Linux-only run.
Final remote, JetBrains, Trust reliability, and long workloads remain H7 work.

## H6: reconcile inventories, evidence, and documentation

### Implementation and documentation

Create independent valid evidence and inventory expectations that do not reuse the verifier's expectation loader.
Add targeted mutations for wrong editor versions, wrong SQLite drivers, and empty target matrices.
Make manually approved CI release entry points and unconditional evidence uploads explicit in documentation and regression guards.
Keep ordinary automated CI free of the real Backstage release workload.

Reconcile inline repair proposals with the documented directory layout.
Record relevant policy validity and expiry fields in sanitized evidence.
Label historical cross-platform inventories separately from current Linux inventories.
Validate required screenshot integrity and step attribution, or classify screenshots as optional diagnostics and remove completeness claims.
Keep native Trust outcome assertions independent of screenshot availability.
Update the implementation status and testing guides with accepted packages and remaining deferred work.

### Acceptance criteria

- H6-A1: Independent golden evidence passes, and each targeted version, driver, inventory, and report mutation fails for its intended reason.
- H6-A2: CI documentation and static controls preserve manual exact-revision release gating and `always()` evidence retention.
- H6-A3: Scenario counts derive from versioned inventories and retain exact revision, client, platform, and mode attribution.
- H6-A4: Proposal and policy evidence documentation matches the actual loader and retained sanitized reports.
- H6-A5: Screenshot claims match enforced integrity and attribution rules, or clearly state their optional diagnostic role.
- H6-A6: Every H1 through H6 finding has parent-accepted evidence or an explicit unresolved disposition. Deferred H7 findings remain open.

### Validation and handoff

Run evidence and workflow guard tests plus documentation formatting, link, and traceability inspections.
Run the full source/client gate and packaged suite for the final H1 through H6 candidate.
Report the remaining client/release qualification limits rather than treating those gates as release publication approval.

## H7: deferred client and final release qualification

This package requires separate authorization. It does not start after H6 automatically.
It includes abrupt SSH/network loss and late restricted/virtual-workspace activation findings.
It also retains the earlier LSP phase 5 work: native Trust reliability, installed JetBrains qualification, and longer final-candidate workloads.
Define exact supported clients, platforms, repetitions, budgets, and artifact identities before execution.

### Acceptance criteria

- H7-A1: An entered real remote session loses transport abruptly. Cleanup and recovery are observed before host teardown.
- H7-A2: Restricted and virtual workspaces remain inactive through a defined activation barrier. Trusted activation has a positive control.
- H7-A3: Native Workspace Trust automation passes the approved repeated matrix without weaker assertions or hidden reruns.
- H7-A4: Supported installed JetBrains clients demonstrate the declared functionality against the exact final candidate.
- H7-A5: Long endurance and release runs satisfy the approved performance policy with complete measurements and matching artifact identities.
- H7-A6: All failures, reruns, skipped or unexecuted cases, and platform limits remain visible in the acceptance record.

Publication or merge requires the user's separate instruction. Successful H7 evidence does not authorize either action.

## Changes already included in the merged baseline

PR #3 merged feature head `bffe5e7c1e41112e46fb3e9163c2fabaa90de6ea`.
It includes the capability, live catalog refresh, and CEL/RE2 editor work accepted earlier.
The baseline also includes two corrections made after the original assessment.

Commit `c845838` waits for queued reloads and consistently rejects retired repair commands.
It includes controlled protocol and resource-lifetime tests for overlap, failure, shutdown, stale tokens, and fresh repairs.
Commit `bffe5e7` handles cancelled read-only readiness requests and native button movement after pointer focus.
Its controls preserve successful-read requirements, error propagation, the existing deadline, and native mouse release on failure.

Reuse these controls in later packages. Do not replace their strong assertions or implement the same corrections again.
They do not close a complete H1 finding or the broader deferred client reliability work.
The register remains the frozen assessment baseline. Later finding dispositions belong in the implementation record.
Record exact new evidence before closing any related recommendation.

## Completion and documentation gate

The register is the frozen baseline. Record changed states and acceptance evidence in the implementation record.
Do not rewrite the original report or erase its caveats when a finding closes.
Each package record must name its acceptance criteria, actual test selectors, tested revision, counts, artifact digests, and limitations.
The parent must inspect representative changed tests and repeat appropriate independent controls before acceptance.
An unexecuted required case remains open. A clarification closes through an explicit parent-reviewed disposition, not an unrelated test.

Before implementation, make sure that all 86 register entries have exactly one package and specific acceptance work.
Make sure that all relative documentation links resolve and that formatting passes for changed documents.
Preserve the user-owned report, ignored evidence, and separate planning repository.
This planning change does not require a new product test run.

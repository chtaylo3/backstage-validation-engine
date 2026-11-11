# Test harness remediation implementation record

Status: H1 through H5 are accepted within their recorded scope. H6 is implemented and awaits parent review. H7 remains deferred. R4-F10 remains Partial, and additional N1 remains open.
Created: 2026-11-10.
The [plan](test-harness-remediation-plan.md) defines scope and acceptance criteria.
The [register](test-harness-remediation-findings.md) preserves the amended baseline findings.
The [handoff](test-harness-remediation-handoff.md) defines agent and parent responsibilities.

## Approval and baseline

User approval: the user said "proceed" after the parent described starting H1 and sequential package handoffs.
Approval date: 2026-11-10. Active scope: H1 through H6, subject to parent acceptance between packages.
H7 remains deferred and requires separate authorization.
Branch: `feature/test-harness-remediation`.
Implementation baseline: `38085eed9e2a77ebe50b414a23aaf21c6004c199` on `master`.
[PR #3](https://github.com/chtaylo3/backstage-validation-engine/pull/3) is merged.
Its final feature head is `bffe5e7c1e41112e46fb3e9163c2fabaa90de6ea`.
The remediation documents were not included in that PR.
No push, additional PR, publication, or merge is authorized for this remediation branch by this approval.

## Merged corrections carried into remediation

The merged feature includes controlled queued-reload and guarded-repair corrections from `c845838`.
It also includes bounded provider-readiness cancellation and focus-scroll input controls from `bffe5e7`.
The complete local source gate passed 1,084 tests and 42 client tests at that final feature head.
The exact-commit stamped candidate passed 1,084 packaged tests and four focused installed case/version checks on Linux.
The separate development-labelled local installed run passed 92 checks and remains distinct from the stamped candidate evidence.

Hosted macOS and Ubuntu installed jobs passed 92 checks each in both updated runs.
The [PR run](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42943383455) and
[push run](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42943376242) retain that evidence.
These are pre-merge feature results. They do not qualify later remediation changes.
The pre-merge PR CI run subsequently completed with an overall successful conclusion.
The original numbered findings and supplemental gaps remain frozen in the register.
No complete H1 finding closes through these baseline corrections.

## Package state

| Package | Agent state | Parent decision | Required next evidence                                                     |
| ------- | ----------- | --------------- | -------------------------------------------------------------------------- |
| H1      | Complete    | Accepted        | Scoped evidence and limitations recorded below                             |
| H2      | Complete    | Accepted        | Scoped evidence and limitations recorded below                             |
| H3      | Complete    | Accepted        | Scoped evidence recorded below. N1 remains open.                           |
| H4      | Complete    | Accepted        | Scoped backend evidence and limitations recorded below                     |
| H5      | Complete    | Accepted        | Desktop scope accepted. R4-F10 retains a Partial native Trust disposition. |
| H6      | Complete    | Pending         | Evidence, inventory, and scope reconciliation recorded below               |
| H7      | Deferred    | Not admitted    | Separate authorization and final-candidate qualification                   |

## Required record for each package

Copy this structure into a package section when implementation begins.
Keep failed checks and later reruns visible.
Do not mark a criterion accepted from a proposed command or an old candidate.

```text
Package:
User approval reference and scope:
Assigned agent:
Implementation baseline and branch:
Implementation revision:
Changed behavior and compatibility decisions:
Assigned finding IDs:
Acceptance mapping: criterion -> test selector -> expected outcome -> evidence
Positive and negative control outcomes:
Faulty variant outcome, if applicable:
Executed commands and exact selectors:
Counts: passed / failed / cancelled / skipped / unexecuted
Artifact revision, digest, platform, client, backend, and mode:
Failed attempts and unchanged reruns:
Documentation updates:
Unresolved criteria and limitations:
Parent inspection and independently repeated controls:
Parent decision and date:
Next package admitted:
```

## Finding dispositions

The approval and baseline update alone closed no findings.
The following dispositions record parent acceptance after implementation and independent controls.
H2, H3, and H4 dispositions appear in their per-finding traceability tables below.
Additional N1 remains open beyond the original frozen register.
Use `Accepted`, `Partial`, `Open`, or `Deferred` for implementation state.
Use `Clarified` only for a parent-reviewed correction to the original recommendation.

| Finding | Package | State    | Criterion and evidence                                                 | Parent decision                                          |
| ------- | ------- | -------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| R4-F13  | H1      | Accepted | H1-A7: raw metric and independent 16-control replay                    | Accepted under current policy. H5 owns policy revision.  |
| R5-F1   | H1      | Accepted | H1-A1: actual host missing-report control                              | Accepted                                                 |
| R5-F2   | H1      | Accepted | H1-A1: actual host build-failure control                               | Accepted                                                 |
| R5-F3   | H1      | Accepted | H1-A2: installed crash, host accounting, later case, and PID cleanup   | Accepted within focused Linux qualification              |
| R5-F4   | H1      | Accepted | H1-A4: actual CLI variants, identities, and archive parity             | Accepted. H4 retains backend-specific reason assertions. |
| R5-F5   | H1      | Accepted | H1-A6: actual clean candidate and crafted archive controls             | Accepted                                                 |
| R5-F6   | H1      | Accepted | H1-A5: actual CLI/LSP parity, reload revocation, installed observation | Accepted. H4 retains real-backend parity qualification.  |
| R5-F9   | H1      | Accepted | H1-A3: actual host cleanup/interruption/unfinished controls            | Accepted                                                 |

## Planning validation

The original planning validation ran on 2026-11-10 at `865a68e7fe2aa9c55f991f345ab4c6dea293907e`.
Scoped Prettier formatting passed for all four remediation documents.
A read-only inspection resolved all 184 local document and source links, including the cited qualification anchor.
The same inspection matched all 86 unique findings to the amended assessment and exactly one package each.
It retained every acceptance requirement, caveat, baseline state, and source reference.
All 51 package acceptance identifiers are unique.

The original review's SHA-256 still matches the recorded baseline.
The local head and the pushed remote feature head both identify `865a68e7fe2aa9c55f991f345ab4c6dea293907e`.
No tracked file or application source changed during that original planning validation.
The four documents were local and uncommitted at that checkpoint.
Validation details remain under `.artifacts/test-intent-assessment/remediation-plan-validation.json`.
No product test suite, backend qualification, installed-client run, or implementation delegation belongs to this planning gate.

## Approved handoff validation

The parent recorded approval and created the remediation branch at merged commit `38085eed9e2a77ebe50b414a23aaf21c6004c199`.
Scoped formatting passed for all four documents. The local link inspection resolved all 184 targets.
The traceability inspection matched all 86 unique findings to one package each and all 51 package acceptance identifiers.
Frozen source references were matched against the original inspected Git revision instead of assuming unchanged current line numbers.
The original review's digest still matches its recorded baseline.
The four approved documents form the planning commit before the H1 assignment.
No application source changed and no product test run belongs to this documentation gate.
Validation remains in `.artifacts/test-intent-assessment/approved-remediation-plan-validation.json`.

## H1 accepted implementation

Assigned agent: `harness_h1_release_evidence`. User approval and package scope remain as recorded above.
The parent accepted H1 after the agent handoff and independent controls recorded below.
Implementation starts from planning commit `17f4fab` on `feature/test-harness-remediation`.
The exact tested implementation is `f7d54158aa0024bd331952c6f8d572d8402dd059`.
The final record is a documentation-only update after that qualification.

### Behavior and compatibility

The [evidence contract](release-evidence-contract.md) defines the revised admission rules and interfaces.
The production host and no-Docker subprocess controls now share target orchestration and aggregate status logic.
Missing reports cannot become fresh successful inventories. Failed builds, children, cleanup, and unfinished rows retain failure evidence.
The entered native crash reaches `evidence.run`, retains a failed row, confirms owned server death, and permits a later independent editor case.
Scratch reports stay separate from the positive release inventory.

CLI scenarios select normal JSON, error JSON, or SARIF before reading process output.
Normal results require CI mode, CI enforcement, expected outcome/exit, and independently bound source/policy/profile/activation/installation/repository identities.
Missing credentials and invalid source snapshots retain their legitimate outer error envelope without validation provenance.
Build identity remains artifact metadata.

The additive `coverageObservation` launcher permission defaults to disabled.
The read-only request and installed API bind observations to current document URI/version/digest and validation/dependency generations.
Unavailable, unsynchronized, stale, foreign, untrusted, stopped, or disconnected states do not expose current coverage.
The paired CLI/LSP test retains an unrelated failing rule and compares complete coverage records.
The only normalization requires and removes the exact verified CLI `policy/signed-release` authority record.
The LSP consumes an approved launcher policy instead of authenticating that signed release.
Each client separately binds its own aggregate source snapshot. Buffer origin and version can legitimately change that digest.

The VSIX policy uses the host-approved production dependency closure and immutable lock.
Required Backstage dependencies and declared production lock metadata remain permitted.
Nested forbidden payloads, unrelated dependencies, undeclared locks, duplicate paths, traversal, and malformed compiled suffixes fail admission.
The final real candidate passes the same inspector.

The final metric verdict reads both load sizes and required soaks.
It recomputes latency percentiles and retained resource growth against host-approved current budgets.
Required soak slopes need a retained 100-operation span. Short load runs do not claim that qualification.
Budget values and the existing additional quarter-sample exclusion remain unchanged. H5 owns their later policy review.

### Acceptance mapping and executed controls

Every row records agent evidence. The separate parent decision below defines accepted scope.

| Criterion | Boundary and selector                                                                                                                             | Observed outcome                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1-A1     | `backstage-host-runner.test.ts`: actual host subprocess `missing-report` and `build-failure`                                                      | Positive exits 0. Both injected targets exit 1 with failed aggregates, durable host classification, and unexecuted remaining rows.                                                                                                                                                                                                            |
| H1-A2     | `test-extension.mjs --verify-failures`, native `crash` control                                                                                    | Entered VS Code 1.145.2 dies. Scratch host rows are one failed and one passed. The recorded owned server PID is dead. The following diagnostics case passes.                                                                                                                                                                                  |
| H1-A3     | Actual host subprocess `cleanup-failure`, `interrupted-child`, `failed-child`, and `unfinished-report`                                            | Every target exits 1 and retains failed or unexecuted rows. Cleanup runs. Empty/duplicate declarations and missing targets also fail admission.                                                                                                                                                                                               |
| H1-A4     | `lsp-coverage-observation.test.ts`, installed CLI archive parity, and archive credential control                                                  | Actual normal results bind all required identities. Missing provenance, changed identities, IDE mode, or an inconsistent exit fails. Actual invalid-snapshot and missing-credential errors use the explicit error envelope and exit 2.                                                                                                        |
| H1-A5     | Actual CLI/child-stdio paired test, entered reload gates in `lsp-reload-fixes.test.ts`, client bridge test, installed `coverage-observation` case | Full shared records agree. Missing/mismatched/undeclared records fail. Both entered reloads return null at unchanged document version. Fresh coverage has a higher generation. Installed default-off, opt-in observation, bindings, and revocation pass on both pinned editors.                                                               |
| H1-A6     | `backstage-vsix.test.ts` and final real VSIX inspection                                                                                           | The normal 5,079-file candidate passes. Twenty forbidden/malformed path variants fail in both archive orders. Archive-local lock tampering also fails.                                                                                                                                                                                        |
| H1-A7     | `extension-qualification.test.ts`, `extension-resources.test.ts`, final verifier integration                                                      | Excessive latency, retained RSS/handles, growth slope, forged summaries/budgets, malformed PID/timing, missing data, and insufficient required slope windows fail. The independently authored 475-low/25-high p95 vector passes. The 474-low/26-high vector fails. Load checks enforce their applicable limits without claiming a soak slope. |
| H1-A8     | Full source/client gate, full packaged gate, retained host controls, and focused installed Linux checks                                           | All final gates pass with no cancellation or skips. No Docker, actual-backend, performance-compliance, JetBrains, or release-wide qualification is claimed. H4 and deferred H7 retain their required work.                                                                                                                                    |

Four isolated faulty variants remove the latency limit, resource verdict, missing-report admission, or VSIX path policy.
Each variant makes its new control fail with an assertion. None fails from a missing module or unrelated launch error.
The corrected candidate passes those controls. Mutations remain outside the source checkout.

### Exact commands, counts, and artifacts

All final commands use committed inputs at `f7d54158aa0024bd331952c6f8d572d8402dd059` on Linux x64 with Node 24.22.1.
The source/client and packaged gates use separate temporary worktrees and separate `.test-dist` directories.
Native launches use `env -u ELECTRON_RUN_AS_NODE` under `xvfb-run -a`.
The original review is absent from those clean worktrees and remains unchanged in the user checkout.

| Command or control                                                                                                   | Final executed result                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                                                                                      | Architecture, types, lint, formatting, schemas, 1,098 source tests, and 43 client tests pass. No failures, cancellation, or skips. Client coverage is 100% lines and 96% branches. |
| `GITHUB_SHA=<tested revision> npm run extension:package`                                                             | Correctly stamped final VSIX passes identity and payload inspection.                                                                                                               |
| `GITHUB_SHA=<tested revision> npm run cli:package`                                                                   | CLI archive has the tested revision, unchanged lock, and `sourceDirty: false`.                                                                                                     |
| `npm run test:packaged`                                                                                              | Final unchanged repeat passes 1,098 tests with zero failure, cancellation, or skip. The earlier failure remains below.                                                             |
| `scripts/backstage-runner-controls.mjs <fault> <scratch-directory>`                                                  | Seven actual host subprocess scenarios. The positive exits 0. Each of six faults exits 1 with retained failed aggregate evidence.                                                  |
| `scripts/test-extension.mjs --case=coverage-observation`                                                             | Two installed cases pass, one each on VS Code 1.106.3 and 1.145.2.                                                                                                                 |
| `scripts/test-extension.mjs --verify-failures`                                                                       | Three expected-fault controls pass across six real editor sessions on VS Code 1.145.2. Each failed session is followed by a successful session.                                    |
| Packaged-runtime `lsp-coverage-observation.test.js` with the offline-installed CLI archive and packaged stdio server | Two tests pass. The archive's normal-result/missing-credential control also observes exact exits 0 and 2.                                                                          |
| Retained `faulty-controls.mjs`                                                                                       | All four faulty variants are detected by assertion failures. These expected failures do not enter release inventory.                                                               |

Final VSIX SHA-256: `3581c49a27c3bed6fa96ccd95bc23b59743b355b91d63aaf2d79719aaed7b67e`.
Its size is 52,085,040 bytes. The build stamp records `linux-x64`, Node `24.22.1`, and the exact tested revision.
Bundled Node SHA-256: `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`.
Final CLI archive SHA-256: `ca98f4617476329a871fbf806767276c9a678141aae3cf4ad08756a407015c4c`.
The CLI archive installs successfully into an isolated offline prefix.
Installed reports bind the same tested revision and VSIX checksum.

Retained evidence is under `.artifacts/harness-remediation/H1/agent-final/` in the user checkout.
`qualification-summary.json` records identities and final counts.
`source-gate/check.log`, `packaged.log`, and `inventories/` retain complete final gate evidence.
`native/` retains installed reports, logs, current coverage records, crash scratch accounting, and owned-PID cleanup proof.
`host-controls/` retains the seven final target reports and their separate scratch aggregates.
`faulty-variants/` retains the isolated mutations and failing test output.
`candidates/` retains the final VSIX, CLI archive, and CLI metadata/checksums.

### Failed attempts and limitations

The first focused development run passed 17 of 18 checks.
Its actual paired test exposed the legitimate CLI-only signed-release coverage record.
The parent approved the narrow normalization above. Later focused and complete gates pass with that requirement.
Initial type/lint runs found development errors. Corrections preserve the existing checks and limits.

Successful earlier complete gates at `79ae47e` and `0036190` remain preliminary evidence.
They do not qualify the final candidate. Their logs retain the recorded revisions.
The first final-worktree package command supplied an incorrect `GITHUB_SHA`.
The inspector rejects that archive. It remains under `rejected-stamp/` and receives no qualification claim.
The later correctly stamped final candidate has the identity recorded above.

The first full packaged run at the final revision reports 1,096 passed and two failed test nodes out of 1,098.
One nested `conflict` assertion in `lsp-catalog-refresh.test.ts` did not observe its initial `te-remote` suggestion.
The failed child and containing test account for both failed nodes.
The unchanged isolated selector passes four tests. The unchanged complete packaged repeat passes all 1,098.
The cause remains unclassified. Concurrent activity coincided with the first run but does not establish causation.
No assertion, timeout, budget, or catalog-refresh implementation changed for either rerun.
`packaged-attempt-1.log` and `packaged-conflict-isolated.log` retain both observations.

H1 proves evidence rejection and focused Linux installed behavior.
The production Docker adapter and modified real-backend parity/crash drivers do not receive backend qualification through these no-Docker controls.
H4 owns the required actual-backend acceptance. H5 owns later performance policy work. H7 remains deferred.
No hosted run, full installed inventory, endurance run, transport release matrix, publication, push, PR, or merge belongs to this H1 qualification.
The original review SHA-256 still matches `3814987bbc5b962b5638cecde322054d33db400d52a7ae212adec7e5530cd5d7`.

### Parent acceptance

Parent decision: accepted on 2026-11-10. All eight H1 criteria pass within the stated scope.
The agent handoff is documentation commit `bcd13d62aacc3ab251665a593fed0197cee2c7bc`.
Only the implementation record differs from the tested source revision `f7d54158aa0024bd331952c6f8d572d8402dd059` at that handoff.
The parent inspected the production host path, request admission, metric verdict, payload policy, and complete qualification reports.
The parent retained the narrow signed-release normalization and the distinct CLI/editor source identities described above.

| Criterion | Parent inspection and independent evidence                                                                                                                               | Decision                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| H1-A1     | Repeated actual positive, missing-report, and build-failure subprocesses. Verified exit, aggregate, cleanup, and case rows.                                              | Accepted                       |
| H1-A2     | Matched native crash and subsequent successful editor reports to the exact VSIX. Inspected entered run phase, scratch host rows, and observed owned-server death.        | Accepted                       |
| H1-A3     | Repeated actual cleanup failure, interrupted child, failed child, and unfinished-report controls. All fail their aggregate verdict.                                      | Accepted                       |
| H1-A4     | Repeated the packaged actual CLI/LSP pair. Inspected scenario-selected variants, bound identities, archive CLI controls, and legitimate error envelopes.                 | Accepted                       |
| H1-A5     | Repeated packaged coverage and entered reload tests. Inspected both installed observations and default-denied client forwarding.                                         | Accepted                       |
| H1-A6     | Repeated inspection of the final real VSIX and seven injected payload faults. The clean candidate passes. Every fault fails admission.                                   | Accepted                       |
| H1-A7     | Independently authored 16 metric controls pass. These cover the exact p95 edge, forged reports, retained leaks, slope windows, malformed samples, and short-load limits. | Accepted under retained policy |
| H1-A8     | Inspected final source/client/packaged inventories and no-Docker controls. Preserved H4 backend, H5 policy, and H7 release limitations.                                  | Accepted within declared scope |

The parent repeated three packaged protocol tests with the candidate's bundled Node, CLI entrypoint, and stdio entrypoint.
All three passed with zero failure, cancellation, or skip. No compilation changed those candidate inputs.
The seven host subprocess states and eight archive controls passed their independently selected expectations.
The parent recomputed the final VSIX checksum and matched all four installed reports to that same artifact and source revision.
The parent preserved the first packaged failure as unclassified and inspected its unchanged focused and complete reruns.
No budget, assertion, timeout, or catalog-refresh implementation changed to obtain those reruns.

Independent evidence remains under `.artifacts/harness-remediation/H1/parent-baseline/`.
`final-packaged-protocol.log` records the three actual protocol tests.
`final-host-review.json`, `final-archive-review.json`, and `final-artifact-review.json` record the final candidate controls and identities.
`metric-review.json` records the 16 independent metric controls at the tested source revision.
The earlier baseline and draft archive probes remain separate from final evidence.
The original review retains its recorded SHA-256. The tracked diff has no targeted private workstation path.

H2 is admitted next on `feature/test-harness-remediation`, starting from the parent acceptance commit.
The frozen finding register remains unchanged. Only these eight implementation dispositions are accepted.
No remote write, new PR, publication, merge, actual-backend qualification, or deferred H7 work belongs to this decision.

## H2 accepted implementation

Assigned agent: `harness_h2_lsp_behavior`. Handoff date: 2026-11-11.
The user approved H1 through H6 on 2026-11-10 with sequential parent gates. H7 remains deferred.
H2 starts from H1 acceptance commit `be94423ebd96a50f0ac32143f4760968e3240f2b` on `feature/test-harness-remediation`.
The exact tested source and tests are `103c754d0464ee724a6565795482b1085fc01a2a`.
Production code last changed in `043a6a5`. Later implementation commits change tests and documentation only.
This final record update is documentation only. H1 acceptance and the frozen register remain unchanged.
The parent accepted H2 after the agent handoff and independent controls below.

### Changed behavior and compatibility

The stale-version control observes the authoritative document before another edit can mask it.
A later incremental edit changes only the description. Removed older/equal-version guards fail the strengthened control.
Entered HTTP gates hold every superseded generation. The test inspects all publications after the complete race and shutdown.
Publisher controls also compare complete delivery histories for old and reopened document lifetimes.
Coordinator and resource lifetime tests use entered, retiring, activated, failed-registration, and disposed signals.
They no longer depend on fixed event-loop-turn counts in the cited suites.

The real child harness permits explicit initialize parameters and independent capability omissions.
It captures client log messages and can reject watcher registration before it succeeds.
Rejected registration produces the exact sanitized warning. Save changes actual owner validation, then restoration recovers it.
A later trusted reload accepts a new registration. The first registration remains rejected.
Raw cancellation controls write a request and its matching `$/cancelRequest` frame together to the child.
The client SDK does not short-circuit those requests. The response must come from the child.
Positive completion, hover, and unique definition controls precede the three empty cancellation shapes.

The wire adapter now returns `-32002` before successful initialization and `-32600` after shutdown starts.
It applies the same lifetime guard to standard, custom, shutdown, duplicate-initialize, and unknown requests.
Pre-initialize source notifications cannot create an authoritative document.
The stdio adapter uses admitted shutdown state for EOF/exit. SDK receipt of a rejected shutdown cannot authorize exit 0.
The [LSP guide](lsp.md#protocol-lifecycle-admission) records this justified correction and the primary protocol sources.
Inner request admission, trusted roots, and the existing UTF-16 negotiation policy remain intact.
Unsupported-only encoding offers still fail initialization. Client roots cannot widen the launcher source selection.
Rejected setup now waits for observed, bounded child termination before fixture removal.

Reference completions, JSON field insertions, scalar edits, and included-payload edits compare complete independently expected text.
`TextDocument.applyEdits`, JSON parsing, and YAML parsing supply independent application and content controls.
Enum repair uses the guarded command, applies the actual versioned edit, sends `didChange`, and retains an unrelated failing rule.
Required-field insertion retains its explicit blank placeholder. It passes the nonempty-value rule only after a separate value edit.
Local watch deletion now waits for the exact captured source digest with the deleted dependency and retained buffer identities.
Only then does it assert the old candidate absent and obtain a live hover reply.

The [limit table](lsp.md#editor-limits-and-recovery) defines inclusive counts, UTF-8 units, binding limits, and recovery.
The 1,000-document wire fixture uses the supported 250 ms debounce to isolate count admission from zero-debounce stress.
Open-count overflow stays incomplete after an ordinary close. A fresh trusted server recovers it.
Unique-file overflow instead makes its affected buffer unavailable and follows synchronization recovery.
Change overflow requires full synchronization. Discovery recovers after the excess entry, depth, or file is removed.
The entry fixture uses unmatched files so the 1,000-selected-file ceiling does not hide the 10,000-entry boundary.
Controlled clocks distinguish 49/50 ms completion fallback and 499/500 ms advisory search cancellation.
Cache fixtures distinguish 32/33 scopes and exactly 262,144/262,145 serialized report bytes.
Complete oversized frame bodies and headers cannot pass through truncation errors after a size guard is removed.

Credential tests admit a real authenticated 16,384-byte file and reject the next byte.
They test atomic replacement, actual symbolic-link rejection, and recovery with the same provider.
The host now compares path-entry identity with the opened handle before and after capture.
The [credential guide](editor-features.md#configuration-and-credentials) explains the portable fallback and its Node source.
A Linux simulation disables only `O_NOFOLLOW`. New entry checks still reject the actual symbolic link.
Removing those checks in that simulation makes the test fail. This does not claim Windows execution.
The test attempts symbolic-link creation on every platform. Only actual Windows permission denial records that subcontrol as unavailable.
CI continues to reject skipped harness tests. No platform limitation silently becomes a passing security claim.
The shared validation engine and credential authority bindings remain unchanged.

### Acceptance mapping

These are agent results. The separate parent acceptance below defines their accepted scope.

| Criterion | Executed boundary and independent expected result                                                                                                                                                                                            | Agent result                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| H2-A1     | `lsp.test.ts` observes retained URI/version/digest after stale notifications before any masking edit. Three isolated stale/equal/older faulty variants fail that assertion.                                                                  | Ready                             |
| H2-A2     | Every rapid-change publication belongs to version 4 after held/cancelled generations. `lsp-owners`, coordinator, and session-resource suites retain complete histories and explicit lifetime barriers.                                       | Ready                             |
| H2-A3     | Actual child requests cover close clearing, three cancellation shapes, rejected/recovered registration, logs, roots, encodings, duplicate opens, every supported request family outside its lifetime, and rejected-shutdown exit codes.      | Ready                             |
| H2-A4     | Complete expected text, independently parsed members, guarded enum/include round trips, surviving unrelated findings, and actual revalidation establish edit outcomes. Ambiguous definitions return none while unique targets remain usable. | Ready                             |
| H2-A5     | Actual unlink plus watched-file notification reaches the independently authored deleted-file snapshot. Only then do completion absence and live hover checks run.                                                                            | Ready                             |
| H2-A6     | Exact scalar/frame/edit/token/action/candidate, document/change, discovery, credential, timing/prefix, and cache boundaries retain admitted, rejected, and applicable recovery observations.                                                 | Ready within executed Linux scope |
| H2-A7     | R3-F11 retains both distinct client-delivery and server-before-dispatch races. R3-F16 retains independent fixed UTF-16 coordinate vectors. Neither clarification invents a product change.                                                   | Proposed clarifications           |
| H2-A8     | Full source/client and full packaged gates pass from the same committed inputs. Shared engine and host admission remain intact. New wire/boundary files enter both focused script inventories.                                               | Ready                             |

### Per-finding traceability

Each row has executed evidence in the full source and packaged logs below.
The quoted selector or file identifies its focused control. The parent accepted the implementation dispositions below.
R3-F11 and R3-F16 are clarified after parent inspection. They do not require replacement behavior.

| Finding | Criterion    | Selector and observed outcome                                                                                                                                                                                                    | Implementation state | Parent decision                      |
| ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------ |
| R3-F1   | H2-A1        | `UTF-16 incremental edits preserve same-line emoji offsets and reject stale document versions`: retained coverage identity before description-only edit. Removed guard and separate equal/older variants fail.                   | Accepted             | Accepted                             |
| R3-F2   | H2-A2        | `rapid editor changes cancel old HTTP and never publish superseded diagnostics` and `lsp-owners.test.ts`: every captured publication satisfies the allowed version/lifetime history.                                             | Accepted             | Accepted                             |
| R3-F3   | H2-A3        | `child stdio publishes a nonempty finding before an ordered close clear`: nonempty syntax finding precedes the same URI/version clear.                                                                                           | Accepted             | Accepted                             |
| R3-F4   | H2-A3        | `child cancellation responses retain the declared completion, hover and definition shapes`: real paired wire frames produce exact empty shapes. Entered-provider and completed-local cancellation controls remain distinct.      | Accepted             | Accepted                             |
| R3-F5   | H2-A5        | `included YAML completion edits the open payload scalar and watch refreshes invalidate candidates`: actual unlink, exact deleted source digest, absent old candidate, and live hover.                                            | Accepted             | Accepted                             |
| R3-F6   | H2-A4        | `empty YAML values, quotes, JSON and CRLF preserve punctuation/comments and UTF-16 offsets`: complete resulting strings and parsed owner values match independent expectations.                                                  | Accepted             | Accepted                             |
| R3-F7   | H2-A4        | `JSON field completion produces valid JSON including insertion between existing members`: inserted lifecycle, preserved neighbors, complete expected text, and valid revalidation after value entry.                             | Accepted             | Accepted                             |
| R3-F8   | H2-A4        | `scalar-fixes.test.ts` and included guarded round trip: independent edit application preserves complete source and validates the intended rule.                                                                                  | Accepted             | Accepted                             |
| R3-F9   | H2-A6        | Scalar 4,096/4,097 bytes, 64/65 generated repairs, complete 8 MiB/next-byte frames, 8 KiB/next-byte headers, 16/17 edits, 16 KiB/next-byte replacements and credentials. Independent constants are explicit.                     | Accepted             | Accepted                             |
| R3-F10  | H2-A3        | `stdio completion and hover work on unfinished YAML while authoritative validation reports syntax`: exact `yaml/syntax`, `Invalid YAML syntax.`, plaintext hover, and expected component-type description.                       | Accepted             | Accepted                             |
| R3-F11  | H2-A7        | `the client version check rejects an edit if typing races its delivery` stays distinct from `stdio stale, forged and reopened fix requests never reach workspace/applyEdit`. The explanatory comment preserves both orderings.   | Clarified            | Clarified                            |
| R3-F12  | H2-A8        | `an entered local-index gate produces an exact incomplete reply before the ready candidate`: actual preparation promise enters before empty/incomplete response, then release admits the literal team candidate.                 | Accepted             | Accepted                             |
| R3-F13  | H2-A2        | `lsp-coordinator.test.ts` and `lsp-session-resources.test.ts`: entered/retiring/activated/disposed/failure signals replace the cited fixed turn counts.                                                                          | Accepted             | Accepted                             |
| R3-F14  | H2-A6        | `token storage uses bounded FIFO eviction`: 129 issued tokens evict the oldest while the next-oldest remains usable at capacity 128.                                                                                             | Accepted             | Accepted                             |
| R3-F15  | H2-A3        | `each missing required client capability independently denies fix dispatch`: separate apply-edit, document-change, literal-action, and diagnostic-data omissions yield no dispatch.                                              | Accepted             | Accepted                             |
| R3-F16  | H2-A7        | Fixed independent coordinate vectors remain. Incidental fixture cursors can derive offsets without replacing those expected vectors.                                                                                             | Clarified            | Clarified                            |
| R3-H1   | H2-A3        | `rejected watcher registration reports its reason and save still refreshes the live child`: initial rejection, changed saved-file outcome, restoration, then accepted registration after trusted reload.                         | Accepted             | Accepted                             |
| R3-H2   | H2-A3        | The same registration test inspects the exact client log warning. The lifecycle matrix retains the stopped log count after ordered request responses.                                                                            | Accepted             | Accepted                             |
| R3-H3   | H2-A3        | `child encoding offers select UTF-16 or reject unsupported-only offers`: absent, UTF-16, mixed UTF-8/16, mixed UTF-32/16, UTF-8-only, and unsupported offers retain the declared contract.                                       | Accepted             | Accepted                             |
| R3-H4   | H2-A3        | `client roots cannot widen the trusted filesystem source selection`: no client root, foreign root, and mixed folders keep approved diagnostics and reject the actual outside file.                                               | Accepted             | Accepted                             |
| R3-U1   | H2-A1, H2-A3 | `duplicate child didOpen cannot replace the first document lifetime or bytes`: different version/text cannot replace the original observed coverage binding.                                                                     | Accepted             | Accepted                             |
| R3-U2   | H2-A6        | `lsp-boundaries.test.ts`: 1,000 authoritative documents versus document 1,001, incomplete latch and fresh-server recovery. Exactly 1,000 changes admit validation, while 1,001 require full synchronization.                     | Accepted             | Accepted                             |
| R3-U3   | H2-A6        | Controlled 50/500 ms selectors, one/two-character remote prefix, 32/33 cache scopes, and 262,144/262,145 cache bytes. Next-oldest scopes survive eviction.                                                                       | Accepted             | Accepted                             |
| R3-U4   | H2-A6        | `fix registry caps actions at 32 and retains precisely the first 64 eligible candidates`: both action edges and candidates 1, 32, 33, 64, and 65 have independent admission outcomes.                                            | Accepted             | Accepted                             |
| R3-U5   | H2-A3        | `child stdio rejects lifecycle requests before initialize and after shutdown` and `a rejected pre-initialize shutdown cannot authorize a successful EOF or exit`: exact errors and actual exit 1.                                | Accepted             | Accepted                             |
| R3-U6   | H2-A4        | `hover and definition resolve an unqualified reference to its unique local entity`: unique target remains positive, competing matching definitions return no target.                                                             | Accepted             | Accepted                             |
| R3-U7   | H2-A6        | Three actual filesystem discovery selectors admit 10,000 entries, depth 32, and 1,000 files. Each next value rejects with exact `Discovery exceeds limits.` and recovers after removal.                                          | Accepted             | Accepted                             |
| R3-U8   | H2-A6        | `catalog credential files rotate between authenticated requests without replacing the provider`: authenticated byte boundary, real atomic replacement, actual symlink rejection, recovery, and isolated missing-flag simulation. | Accepted             | Accepted within executed Linux scope |
| R3-U9   | H2-A4        | `schema enum repair applies the selected guarded edit and revalidates only its intended rule`: selected internal value reaches the actual edit, target rule passes, unrelated rule remains failed.                               | Accepted             | Accepted                             |

### Final commands, counts, and candidate

All final gates use committed inputs at `103c754d0464ee724a6565795482b1085fc01a2a` on Linux x64 with Node 24.22.1.
Source/client and packaged gates run serially in separate clean worktrees. Their source-file inventories match.
Each child test uses actual subprocesses. No sandbox file-only result supplies these counts.
The final gates pass on their first attempts at this revision.

| Command or control                                           | Executed final result                                                                                                                                                                         |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                              | Architecture, types, lint, formatting, schemas, 1,143 source tests, and 43 client tests pass. Zero failure, cancellation, skip, or todo. Client coverage remains 100% lines and 96% branches. |
| `GITHUB_SHA=$(git rev-parse HEAD) npm run extension:package` | Correctly stamped 5,079-file VSIX builds from the verified revision.                                                                                                                          |
| `npm run test:packaged`                                      | 1,143 tests pass against the bundled Node, actual staged stdio, and staged CLI entrypoints. Zero failure, cancellation, skip, or todo.                                                        |
| Real VSIX payload inspection                                 | The candidate passes the immutable H1 payload/lock policy and exact revision/runtime checks.                                                                                                  |
| `faulty-variants-final.py`                                   | All 13 isolated controls satisfy their independently selected outcomes. Five positive controls pass. Eight faulty variants fail through the intended assertions.                              |

Final VSIX SHA-256: `5b11d8a622bfc14f9d486a3dedcf0b88181a99dec12f1a27803c8e6a79a0a8b0`.
Size: 52,085,635 bytes. Target: `linux-x64`. Runtime: Node `24.22.1`.
Bundled Node SHA-256: `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`.
The source and packaged test inventories contain 634 top-level tests and 1,143 total test nodes.
The client inventory contains 43 tests. These counts come from the retained runner inventories.
No new CLI archive or installed editor inventory belongs to this package.

The isolated controls use full compiled copies outside the source checkout.
The stale-version selector fails when the complete guard is removed, when equal versions are accepted, and when older versions are accepted.
The lifecycle selector fails when wire lifetime admission is removed.
The rejected-shutdown selector fails when stdio trusts SDK receipt instead of admitted shutdown.
The complete-frame selector fails when either payload or header size admission is removed.
The credential selector passes with `O_NOFOLLOW` disabled and entry checks retained. It fails when those checks are also removed.
The failing assertions identify the disputed behavior. None passes through a missing module, launch error, truncation substitute, or unrelated timeout.
These scratch fault results do not enter a successful release or backend inventory.

### Failed attempts and retained scope

Development evidence remains separate from final qualification.
The first focused run reports 205 passed and two failed checks. New fixture assumptions caused those failures.
The close fixture expected native rejection but contained invalid YAML. Its expected code now names the actual syntax contract.
The cancellation positive first needed observable local-index readiness. Its eventual positive remains separate from the controlled initial-index test.
The second focused run reports 89 passed and four failed checks.
Three controls expected a wrapper error instead of the scanner's existing exact error. The 1,000-document zero-debounce batch timed out.
The revised count fixture uses the existing supported 250 ms debounce. No product limit, request budget, or observation timeout increases.
The corrected protocol/boundary run passes 22 checks with no skips.
A later edit run reports 37 passed and one failed check from an unquoted-key assumption.
The safe quoted-key expectation is explicit. Placeholder failure and later filled-value success remain separate.
Type/lint development errors and their corrections remain in the logs.

The first complete gates at `9d6326c6790322260ec149a78137cad07908a786` pass 1,143 source, 43 client, and 1,143 packaged tests.
Eight isolated controls also pass there. Those results remain preliminary and do not qualify the final test revision.
A final audit replaces incomplete oversized frame fixtures with complete frames.
The first strengthened frame run reports four passed and two failed test nodes because truncation needs its distinct expected error.
The corrected frame selector passes all six nodes. Fresh complete gates then pass at the final revision above.
No production file changes between the preliminary and final qualified revisions.

Final evidence is under `.artifacts/harness-remediation/H2/agent-final/` in the user checkout.
`qualification-summary.json` records revision, artifact, platform, scope, and counts.
`check.log`, `package.log`, `packaged.log`, and `inventories/` retain the final gates and JUnit reports.
`candidates/` retains the final real VSIX, build stamp, and independent payload inspection.
`faulty-variants/` retains all 13 exact selectors, mutations, exit outcomes, and logs.
`development/` retains failed development attempts and the control scripts.
`preliminary-9d6326c/` retains the earlier gates, inventories, candidate, and eight isolated controls.

This evidence qualifies the full source/client and packaged harness on Linux x64.
It does not qualify an installed editor, actual Backstage backend, Docker, hosted OS matrix, endurance, transport release matrix, or publication.
The missing-flag experiment simulates that platform condition on Linux. It is not Windows execution.
H4 retains required actual-backend evidence. H5 retains installed editor and measurement-policy work. H7 remains deferred.
The original review SHA-256 remains `3814987bbc5b962b5638cecde322054d33db400d52a7ae212adec7e5530cd5d7`.
No push, PR, publication, merge, H3 implementation, or further delegation occurs in H2.

### Parent acceptance

Parent decision: accepted on 2026-11-11. All eight H2 criteria pass within the recorded Linux scope.
The agent handoff is `ec2274cfb8584c75be355b275da710c392b0a465`.
Only the LSP guide, editor guide, and implementation record differ from the exact qualified source `103c754d0464ee724a6565795482b1085fc01a2a` at that handoff.
The parent inspected every finding's mapping, expected outcomes, barriers, faults, and retained qualification inventories.
The parent preserves 27 accepted implementation findings and two clarified recommendations.

| Criterion | Parent inspection and independent evidence                                                                                                                                                                                                                                                                                        | Decision                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| H2-A1     | Reproduced the old false pass at the H1 source. The strengthened test passes with the correct guard and fails with that guard removed before another edit can mask the result.                                                                                                                                                    | Accepted                         |
| H2-A2     | Inspected complete publication histories and entered lifetime barriers. Repeated the rapid-change race through the final packaged stdio server.                                                                                                                                                                                   | Accepted                         |
| H2-A3     | Used independent raw JSON-RPC frames against the actual package. Initialization, shutdown, unknown-method, foreign-document, EOF, and exit outcomes match fixed expected codes. Inspected the child cancellation, registration, root, and encoding controls.                                                                      | Accepted                         |
| H2-A4     | Inspected complete text and independent edit application. Repeated guarded enum and included-payload repairs and individual capability omissions against the actual package.                                                                                                                                                      | Accepted                         |
| H2-A5     | Repeated actual dependency deletion, the exact changed snapshot barrier, candidate removal, and live hover through the packaged server.                                                                                                                                                                                           | Accepted                         |
| H2-A6     | Repeated independently authored workspace count/change/recovery controls through the packaged module. Repeated real packaged credential byte limits, symlink rejection, and recovery. Removed frame guards fail their intended complete-frame assertions. Inspected controlled timing, cache, discovery, action, and token edges. | Accepted within executed scope   |
| H2-A7     | Inspected both distinct delivery races and retained independent UTF-16 vectors. R3-F11 and R3-F16 receive clarification dispositions.                                                                                                                                                                                             | Accepted with two clarifications |
| H2-A8     | Matched the source/client/packaged inventories, revision, runtime, and real VSIX checksum. Confirmed that shared core, runtime, policy, and lockfile inputs do not change in H2.                                                                                                                                                  | Accepted                         |

The independent raw protocol probe does not reuse the child test harness or SDK.
It observes `-32002` before initialization, `-32601` for an initialized unknown method, and `-32600` after shutdown.
The normal shutdown exits 0. Two separately rejected pre-initialize shutdowns exit 1 after EOF or exit.
The actual packaged credential reader admits 16,384 raw bytes, rejects 16,385 bytes and a symbolic link, and recovers with a regular replacement.
Five independently authored workspace observations cover exact document/change counts, unavailable input, and full resynchronization.
The independent packaged race, watch, repair, and capability repeat passes nine checks with zero failure, cancellation, or skip.

The parent also ran six isolated guard controls from compiled modules that match the packaged originals byte for byte.
Correct and restored versions each pass the stale-version and framing selectors.
Removing the stale-version, payload-size, header-size, or admitted-shutdown guard causes its intended assertion failure.
The parent inspected all 13 agent fault controls, including the credential experiment without `O_NOFOLLOW`.
That experiment remains a Linux simulation and does not qualify Windows execution.

The parent recomputed the final VSIX checksum and size. They match the artifact identity recorded above.
All three final inventories report success without failures, cancellation, skips, or todo cases.
The source and packaged file inventories match exactly.
Independent evidence remains under `.artifacts/harness-remediation/H2/parent/`.
`raw-protocol-candidate.json`, `rejected-shutdown-candidate.json`, and `packaged-credential-review.json` retain actual packaged responses.
`workspace-boundary-candidate.json`, `final-guard-review.json`, `packaged-behavior-review.log`, and `inventory-review.json` retain the other parent checks.

Parent probe setup needed a compiled-indentation matcher correction and a nested inventory-summary reader correction.
Those corrections changed no candidate input. The first matcher attempt remains under `review-attempt-1/`.
The original review retains its recorded digest. The history path scan remains part of this acceptance evidence.

H3 is admitted next on `feature/test-harness-remediation`, starting from the parent acceptance commit.
H4 retains actual-backend evidence. H5 retains installed editor and performance-policy work. H7 remains deferred.
No push, PR, publication, merge, hosted qualification, installed-client qualification, or H3 implementation belongs to this H2 decision.

## H3 accepted implementation

Assigned agent: `harness_h3_core_cli`. The parent accepted the scoped package on 2026-11-11.
The user approved H1 through H6 sequentially on 2026-11-10. H3 starts after accepted H2.
The admitted baseline is `c7feb6baa4417afcf1d6fc9bf1596e6c3801be3d` on `feature/test-harness-remediation`.
The source/test candidate is `313c9ea9fdac26a7666a51ae7d1cfd2380775e09`.
The later handoff changes only this implementation record.

### Behavior and compatibility

The rules-stage controls inject all 17 declared CEL failures through `executePolicyRules`.
They assert independent rule states, reasons, required coverage, interruption, and result exit 2.
Positive controls execute all rules successfully through a production pool and return exit 0.
Actual CLI subprocesses also exercise seven attainable interpreter failure classes.
Not-applicable and incomplete prerequisites block dependents. Independent rules still execute.
Separate one-worker and one-outstanding-job requests run alongside a default request against one production pool.
Entered and released gates prove each request's concurrency without assigning pool ownership to a request.
Observation guards and failure cleanup bound the test harness itself.

The original 43-case CEL corpus retains its bytes and historical digest.
A versioned sidecar pins exact error codes and 18 additional fixed cases.
The pinned CEL-Go comparator retains each original expression and maps JSON entity numbers to CEL doubles.
Its fixed expectations distinguish parse, check, evaluation, and boolean-result admission.
Go accepts `1 + 1` and returns integer `2`. The report retains that raw successful value.
The `result_type` adapter applies BVE's existing boolean-result rule.
One reviewed profile difference remains: Go accepts `getFullYear`, while BVE rejects that unallowlisted method with `profile`.

The new positive literal cases demonstrated the interpreter's restrictive homogeneous-literal default.
The parent approved heterogeneous literal support before the correction.
Commit `3c4ca8a` documents that behavior before the implementation commit.
The only interpreter configuration change is `homogeneousAggregateLiterals: false`.
The stronger AST test also demonstrated that the vendor parser's frame limit did not enforce actual AST depth.
Commit `8c61144` defines root-depth-zero semantics before the iterative admission guard.
That guard rejects AST depth 65 with `parse` before recursive regex traversal or evaluation.
A unary chain at depth 64 executes successfully. The existing ceiling remains 64.

The official draft-07 subset executes 181 unmodified expected-valid flags from 32 accepted feature groups.
An additional upstream group receives an explicit remote-reference exclusion control.
The curated source contains 33 complete upstream feature files and its MIT license.
Unselected groups receive no conformance claim. Strict lone-`if` admission and recursive references remain explicit exclusions.
YAML controls cite the 1.2.2 core table and retain explicit tags, directive, alias-key, and non-JSON exclusions.
Canonical controls retain fixed UTF-16 key ordering and ECMAScript numeric strings.
Unsafe integral doubles remain excluded under contract 0.2.
`node:crypto` verifies the published RFC 8032 vector and signatures over separately constructed release bytes.
Tampering tests assert the structural or integrity failure that occurs first.

Unmodified OASIS 2.1.0 Errata 01 schema bytes qualify normal, incomplete, and error SARIF.
Pinned test-only `ajv-draft-04` and `ajv-formats` enforce draft-04 structure and full formats.
Invalid URI, URI-reference, date-time, version, and missing-tool controls fail admission.
The only regex compatibility setting is `unicodeRegExp: false` for the schema's legacy pattern.
The minimal devDependency lock update adds these two validators. Production dependencies remain unchanged.

Default controls reach exact parser, CEL input, snapshot, canonical JSON, and release boundaries.
They retain UTF-8 multibyte inputs, seven-day host age, and exclusive authority expiry.
Quoted sequences reach 100,000 syntax/value nodes at exactly 200,000 tokens.
An extra scalar crosses the earlier token bound. Aliases independently reach 100,000 expanded values.
Expansion reaches one MiB per document and 16 MiB across documents before rejecting one extra byte.
A one-document fixture reaches the diagnostic quota independently of the document quota.
The expression ceiling prevents an authored AST above 4,096 nodes and unique-key 1,000-entry maps.
The tests retain these earlier rejections without changing ceilings.
More than 256 programs and patterns demonstrate cache clearing, bounded reuse, and correct recompilation.
No least-recently-used policy is introduced.

The actual CLI controls cover `--baseline`, `--data`, `--help`, output-write failure, SIGINT, and SIGTERM.
The baseline has a distinct prior revision. Supplied data is nonempty and differs from the default snapshot.
That data controls the exact publication deadline. Expired and future data fail admission.
Validated-but-substituted baseline/data faults fail the corrected caller-specific provenance assertions.
The signal controls wait for an entered HTTP request before sending the signal.
They observe incomplete cancellation, exit 2, connection closure, and process death.
Output rename failure retains a redacted stdout envelope and removes temporary files.
Successful output writes retain their original behavior.

### Accepted finding and acceptance mapping

The parent accepted these thirteen original findings after independent controls and inspection. N1 remains separately open.

| Finding | Criterion | Independent expected result and executed boundary                                                                                                                                                                          | Implementation state | Parent decision |
| ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------- |
| R1-F1   | H3-A1     | `core-failure-mapping.test.ts`: fixed 17-row state/reason/interruption/outcome table, complete required coverage, blocked dependents and exits. Actual CLI runs cover seven interpreter failures.                          | Accepted             | Accepted        |
| R1-F2   | H3-A2     | `cel-runtime.test.ts` and comparator: every error in the original corpus and sidecar requires its fixed identity. Wrong error identity is a retained faulty variant.                                                       | Accepted             | Accepted        |
| R1-F3   | H3-A4     | `default-boundaries.test.ts`: actual AST depth 64/65, parser frames, list 1,000/1,001 and call arguments 32/33. Earlier expression/node and unique-map bounds remain explicit.                                             | Accepted             | Accepted        |
| R1-F4   | H3-A2     | Frozen original plus 18 reviewed function/mixed-literal/exclusion inputs. Pinned CEL-Go comparison runs locally and in a separate CI job. One approved timestamp-method difference remains explicit.                       | Accepted             | Accepted        |
| R1-F5   | H3-A3     | `independent-conformance.test.ts`: cited YAML core scalars, all seven explicit JSON-compatible tags, 1.2 directive, alias-key and stricter JSON exclusions.                                                                | Accepted             | Accepted        |
| R1-F6   | H3-A4     | Exact default byte/count/depth boundaries and first-excess controls. Earlier raw-source/token/expression bounds are proven and documented. Host age admits seven days structurally and rejects that exclusive end instant. | Accepted             | Accepted        |
| R1-F7   | H3-A3     | Official pinned draft-07 subset: 181 fixed valid flags, safe local references, and explicit rejected profile features. Source license and byte digests remain retained.                                                    | Accepted             | Accepted        |
| R1-F8   | H3-A3     | Actual normal/incomplete/error CLI SARIF and formatter controls pass the unmodified OASIS schema through a draft-04 validator with full formats. Targeted invalid variants fail.                                           | Accepted             | Accepted        |
| R1-F9   | H3-A3     | Fixed RFC/ECMAScript string vectors include supplementary UTF-16 key order and numeric edge representations. Unsafe integral doubles remain rejected.                                                                      | Accepted             | Accepted        |
| R1-F10  | H3-A3     | Exact tamper rejection code/path/message. Independent RFC 8032 and separately constructed release signing bytes pass `node:crypto`, while altered messages/signatures fail.                                                | Accepted             | Accepted        |
| R1-F11  | H3-A5     | Two lowered per-request scheduling controls share one real pool with a default request. Not-applicable and every incomplete prerequisite block dependents without preventing independent work.                             | Accepted             | Accepted        |
| R1-F12  | H3-A6     | Actual CLI options, output-file success/failure, and POSIX SIGINT/SIGTERM. Every signal observes entered work, result exit 2, closed connection and dead process.                                                          | Accepted             | Accepted        |
| R1-F13  | H3-A5     | Compilation spies observe pre-ceiling reuse, cache clearing after 256 entries, and correct recompilation across 800 programs/patterns.                                                                                     | Accepted             | Accepted        |

H3-A7 requires the exact-candidate source/client and packaged results below.
The guides updated are parsing, CEL runtime, contracts, and policy CLI.
The frozen findings register and accepted H1/H2 evidence remain unchanged.

### Exact commands and final evidence

All final commands use committed inputs at `313c9ea9fdac26a7666a51ae7d1cfd2380775e09` on Linux x64.
Node is `24.22.1`. npm is `11.19.1`.
Separate clean worktrees use separate `.test-dist` directories and actual locked dependencies.
Source/client, packaged, scratch faults, comparator, and archive CLI controls run sequentially.
No native editor or backend load overlaps these gates.

| Command or control                                                                                                                  | Final executed result                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --offline --no-audit --no-fund --cache <verified-cache>`                                                                    | 275 locked packages installed. Install scripts and lock integrity remain enabled.                                                                                                  |
| `npm run check`                                                                                                                     | Architecture, types, lint, formatting, schemas, 1,273 source tests and 43 client tests pass. Zero failure, cancellation, skip, or todo. Client coverage: 100% lines, 96% branches. |
| `GITHUB_SHA=$(git rev-parse HEAD) npm run extension:package`                                                                        | Clean exact-revision VSIX passes stamp and payload inspection. 5,079 files.                                                                                                        |
| `GITHUB_SHA=$(git rev-parse HEAD) npm run cli:package`                                                                              | Final metadata binds the tested revision and root lock with `sourceDirty: false`.                                                                                                  |
| `npm run test:packaged`                                                                                                             | All 1,273 tests pass with zero failure, cancellation, skip, or todo. Source/packaged inventories contain the same 75 test files.                                                   |
| Offline `npm install --prefix <fresh-prefix> <archive>`                                                                             | Final CLI archive installs 24 packages from the existing verified registry cache.                                                                                                  |
| `BVE_TEST_CLI_ENTRY=<installed-entry> <packaged-node> --test --test-concurrency=1 --test-timeout=30000 .test-dist/test/cli.test.js` | All 22 tests pass through the installed archive entry. Includes distinct baseline/data, freshness, errors, formats, actual signals, and output failure.                            |
| `go -C scripts/cel-go mod verify`                                                                                                   | All pinned comparator modules verify.                                                                                                                                              |
| `GO_BINARY=<pinned-go> node scripts/compare-cel-go.mjs <report>`                                                                    | 61 reviewed comparisons pass. One approved timestamp-method difference remains explicit. Go's successful nonboolean integer value is retained before the BVE admission adapter.    |
| Retained `run-faulty-controls.mjs`                                                                                                  | Nine production faults are detected. Corrected versions pass all 149 selected test nodes. Expected faulty executions fail 15 nodes across nine separate runs.                      |

The nine faults restore homogeneous literals, remove AST admission, change exact errors, remove program-cache clearing,
change queue-failure mapping, swap actual request lane limits, return successful output-write exit, or substitute validated baseline/data values.
Eight faults produce the intended assertion failures. The homogeneous default produces three unexpected typed evaluation failures and their containing failure.
The corrected candidate passes every corresponding control.
The old sorted observer passes swapped production lanes. The earlier default-valued flag observer passes both validated-value substitutions.
The corrected observers fail those same production faults at request-specific count or provenance assertions.
Scratch failure reports remain separate from normal release and test inventories.

| Criterion | Final evidence and parent decision                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H3-A1     | Complete 17-code rules-stage table and seven actual CLI interpreter classes pass. Accepted.                                                                                                       |
| H3-A2     | All 61 corpus inputs require fixed outcomes/error identities and pass pinned Go comparison. One reviewed profile difference remains. N1 remains separately open. Accepted for this curated scope. |
| H3-A3     | Cited YAML, 181 official draft-07 flags, unmodified OASIS draft-04/full formats, fixed canonical JSON, and independent signatures pass. Accepted.                                                 |
| H3-A4     | Exact defaults and first-excess controls pass, with earlier binding ceilings documented. Accepted.                                                                                                |
| H3-A5     | Caller-bound scheduling, blocked prerequisites, and cache clearing/recompilation pass. Their focused faults fail. Accepted.                                                                       |
| H3-A6     | Distinct supplied options, data freshness, POSIX signals, output failure, and observed cleanup pass through actual subprocesses and the installed archive. Accepted on the executed platform.     |
| H3-A7     | Final exact-revision source/client, packaged, and installed archive CLI gates pass. Historical evidence and original review remain preserved. Accepted.                                           |

Final VSIX SHA-256: `94a6756c4e10e54a9c8ad319d351ae2bf556c3a46a2759033690db7e2bbc8a25`.
Its size is 52,086,896 bytes. The build stamp names the tested revision, Node version, and `linux-x64`.
Bundled Node SHA-256 remains `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`.
Final CLI archive SHA-256: `0feeb3eb31506c617c72985ccf97f024ab2138b529eaa6461745b04a05fed076`.
Its size is 531,684 bytes. These final test-only commits leave its production payload bytes unchanged.
Its separate final metadata binds the exact tested revision and immutable dependency lock.
Root lock SHA-256: `dbd025198eb555e06edf78f0c8f420eef786c445a9eaf01b488ea34ec4669b8b`.

The independent comparator uses CEL-Go `v0.26.1`, commit `8e7beb65e9a70f501fd743c3b70b2a0a2fadac52`.
Its Go module checksum is `h1:iPbVVEdkhTX++hpe3lzSk7D3G3QSYqLGoHOcEio+UXQ=`.
The toolchain is Go `1.26.11` on Linux amd64.
The official archive SHA-256 is `9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec`.
`toolchain.sha256` also retains the actual executable digest. The module lock digest appears in the comparison report.
Original corpus SHA-256 remains `5dbcd903f3caaff62067c4c99e0f04e21d980c53827825536fba4176a74d4fc1`.
Sidecar SHA-256 is `09884eddbbf1468a446c27a12e932ecac3f0e32923624aae532b1cae01cd1377`.
The unmodified OASIS schema SHA-256 is `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`.
The source manifest retains every schema/vector/license origin and digest, including the full OASIS Notices section.

Final evidence is under `.artifacts/harness-remediation/H3/agent-final/`.
`qualification-summary.json` binds counts, inputs, candidate identities, control outcomes, and open N1.
`source-gate/`, `packaged-gate/`, and `inventories/` retain full normal execution logs and inventories.
`candidates/` retains the actual VSIX, CLI archive, checksums, metadata, build stamp, and component inventories.
`comparison.json`, `comparison.log`, and `comparator-module-verification.log` retain the final independent comparison.
`faulty-variants/` retains all nine compiled variants, corrected/faulty logs, exact mutations, and weak-observer source evidence.
`duplicate-map-investigation/` retains the separate unresolved N1 observations.
Earlier committed candidates remain under `preliminary-c2175f8/`, `preliminary-7ade4b7/`, and `preliminary-1789d87/`.
The original review SHA-256 remains `3814987bbc5b962b5638cecde322054d33db400d52a7ae212adec7e5530cd5d7`.

### Additional open finding N1

N1 is OPEN: duplicate-key map literals retain the last value instead of the language-defined error.
This is additional unresolved work beyond the original 86 frozen findings.
The parent required this explicit disposition on 2026-11-11. No existing BVE profile exception covers it.
N1 remains visible through H6 and parent/user summaries. It does not enter the supported 61-vector corpus.
It is not an approved intentional semantic difference, a fix, or proof of full CEL conformance.

The bounded probe used exact source revision `7ade4b7f4542c0bf8651ae37d102c6ec09a016d8` after its source gate.
The final candidate changes only scheduling and CLI tests after that revision. The production evaluator remains byte-for-byte identical.
BVE production workers and CEL-Go `v0.26.1` both returned `true` for these original expressions:

| Case                     | Expression                                  | Entity input                 | BVE / Go observed |
| ------------------------ | ------------------------------------------- | ---------------------------- | ----------------- |
| Constant duplicate       | `{'a': 1, 'a': 2}['a'] == 2`                | `{}`                         | `true` / `true`   |
| Constant unique positive | `{'a': 1, 'b': 2}['b'] == 2`                | `{}`                         | `true` / `true`   |
| Derived duplicate        | `{entity.a: 1, entity.b: 2}[entity.a] == 2` | `{"a":"same","b":"same"}`    | `true` / `true`   |
| Derived unique positive  | `{entity.a: 1, entity.b: 2}[entity.b] == 2` | `{"a":"first","b":"second"}` | `true` / `true`   |

The [CEL language definition](https://github.com/cel-expr/cel-spec/blob/21ec6f4e52e8d694687ff9ed7408d3eccbb955d7/doc/langdef.md#L358-L362)
at revision `21ec6f4e52e8d694687ff9ed7408d3eccbb955d7`, lines 358 through 362, requires an error for duplicate keys.
Thus the two implementations agree in this probe but do not meet that language requirement.
The parent retained production behavior for this scoped H3 handoff and left N1 open.
`agent-final/duplicate-map-investigation/` retains exact inputs, raw Go/BVE outputs, and the pinned language source.

### Failed development attempts and limitations

Development used uncommitted H3 inputs above the admitted baseline and the two semantic-documentation commits.
Those attempts do not qualify the final source/test candidate.
Their logs remain under `.artifacts/harness-remediation/H3/development/`.
The first focused run passed 151 of 160 test nodes and failed nine.
Three heterogeneous-literal failures demonstrated the product defect. Their containing test also failed.
Two schema groups needed explicit existing-profile exclusions. Their containing test also failed.
The alias-key fixture needed whitespace after its alias token. Its original spelling was invalid YAML syntax.
The initial SARIF adapter rejected the legacy `id` keyword and did not provide full draft-04 admission.
The parent required the pinned draft-04/format validators instead of claiming structural equivalence.

The second focused run passed 172 of 174 nodes.
One failure exposed the missing actual AST-depth guard through interpreter stack exhaustion.
The other was an RFC signature transcription error. The corrected bytes match the published vector.
The later development focused run passed 208 of 208 nodes.
Additional default/scheduling controls passed 33 of 33. The final CLI/schema/scheduling development selector passed 110 of 110.
The first scoped formatter invocation also included `.prettierignore`, which has no supported parser.
Later invocations format only supported intended files.
Development type/lint runs found ordinary fixture typing, unsafe-spread/destructuring, and numeric-literal errors.
Corrections preserve the declared precision vector through `Number` conversion of its fixed decimal string.
No assertion, product ceiling, coverage threshold, or request deadline was weakened.

The initial locked install stalled while fetching the public `yazl` tarball.
A bounded fetch of that exact tarball succeeded. The parent verified and terminated the stalled installer with SIGTERM.
The installer exited 143. Its chained behavior gate never started.
The replacement used `npm ci --offline --no-audit --no-fund` with the verified task cache and install scripts enabled.
Temporary npm-cache rotation removed the original verbose debug log before harvesting.
The redirected setup log, actual exit observation, and parent cleanup accounting remain in `setup-attempts.json`.
No behavior log is missing through that cache rotation.

The first scratch fault runner required every fault to produce an assertion error.
Restoring homogeneous literals instead produces unexpected `CelError` with `evaluation` in the three fixed positive cases.
The parent approved an exact semantic-failure matcher for those three cases. Other faults still require assertion failures.
The first runner failure remains separate in `faulty-variants-attempt-1/`.
One comparator launch used the module directory instead of the repository root and failed before reading inputs.
The unchanged comparator passes from the required root. `comparison-attempt-1.log` retains that launch error.
One offline CLI install used a cache containing tarballs but lacking a required registry metadata response.
The same archive installs offline from the existing verified registry cache. Both setup logs remain retained.

Earlier complete gates remain preliminary: `c2175f8` passed source/client, `7ade4b7` passed source/client/packaged,
and `1789d87` also passed installed CLI, comparator, and seven fault controls.
The provenance commit added the full published OASIS notice before the final source selection.
Parent review then required caller-specific scheduling assertions and distinct baseline/nonempty-data flag inputs.
Their replacement controls reject the reviewed sorted-count and validated-but-substituted false-success paths.
The final candidate receives complete qualification after those test corrections. No previous run substitutes for it.

The complete source/client and packaged gates qualify Linux x64 only in this local run.
Windows does not deliver POSIX SIGINT/SIGTERM through Node's child-process API.
The Windows source gate retains portable CLI option/write controls and does not claim graceful-signal qualification.
The CI comparator is wired but no hosted CI result is claimed.
Normal source tests remain offline and need no Go installation.
No real-backend, installed editor, native-client, endurance, H4, or deferred H7 qualification belongs to H3.
The shared engine, contract 0.2, host trust, and existing limits remain authoritative.
The agent handoff preceded the separate parent decision below.

### Parent acceptance

Parent decision: accepted on 2026-11-11 for all seven H3 criteria within the declared curated and Linux scope.
Documentation handoff: `fb93066fbc5b11921d89029386350e6536e0c678`.
Only this record differs from qualified source/test revision `313c9ea9fdac26a7666a51ae7d1cfd2380775e09` at that handoff.
The parent inspected all thirteen finding mappings, independent expectations, boundaries, source licenses, faults, and complete inventories.
The two documented interpreter corrections and timestamp-method exclusion retain their reviewed scope.
N1 remains an unresolved language-compatibility finding. It receives no supported-vector or approved-exception claim.

| Criterion | Independent parent evidence                                                                                                                                                                                                     | Decision                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| H3-A1     | All seventeen fixed typed failures cross the actual packaged rules API with expected states, reasons, required blocked coverage, interruption, outcome, and exit 2. Actual archive CLI repeats cover seven interpreter classes. | Accepted                                     |
| H3-A2     | Repeated the sixty-one-case comparison from final committed inputs. Verified the official Go tag and toolchain archive. Inspected frozen corpus bytes, exact error identities, adapters, and the timestamp difference.          | Accepted for curated scope. N1 remains open. |
| H3-A3     | Reviewed YAML, official draft-07 flags, complete licenses, and signature controls. Repeated fixed canonical JSON vectors and twenty-one actual formatter/schema verdicts. Disabling formats fails the invalid-date assertion.   | Accepted                                     |
| H3-A4     | Inspected exact defaults, first-excess cases, and earlier binding proofs. Actual packaged workers accept unary and binary depth 64 and reject 65, including a nested map overflow.                                              | Accepted                                     |
| H3-A5     | Inspected caller-bound scheduling, prerequisites, compilation spies, and their focused faults. The old sorted observer passes swapped production lanes. The request-specific observer fails.                                    | Accepted                                     |
| H3-A6     | Repeated twelve actual installed-archive CLI checks. Independently constructed both default substitutions: old observers pass, current observers fail, and restoration passes.                                                  | Accepted on the executed platform            |
| H3-A7     | Recomputed VSIX/CLI hashes, sizes, lock digest, and stamps. Matched source/client/packaged and installed CLI counts to the exact qualified revision.                                                                            | Accepted                                     |

Twelve additional vectors execute through the actual packaged managed workers.
They cover mixed literals, unary/binary/nested depth, preserved arithmetic and method exclusions, boolean results, and forbidden host calls.
Both workers remain healthy and are observed closed afterward.
The seventeen mapping controls use fixed error injection through the shipped rules API.
They remain distinct from the separate actual worker execution.

The independent SARIF probe admits and rejects all twenty-one fixed normal, incomplete, and error variants as expected.
An isolated format-disabled validator fails the intended invalid-date assertion.
The canonical probe covers fourteen numeric cases, including eight documented unsafe-integral rejections, plus UTF-16 sorting and nonfinite rejection.
Its first exploratory assumption that all finite RFC samples were admitted was incorrect. The documented restrictions remain unchanged.

The independent installed CLI repeat passes twelve nodes with zero failure, cancellation, skip, or todo.
Five isolated option controls confirm both earlier false passes and the restored positive through byte-identical packaged CLI code.
The repeated comparator passes sixty-one cases with the same one reviewed profile difference.
The parent inspected all nine agent faults and their corrected results.
N1 source and raw observations were independently reviewed. Its evaluator source is unchanged across the investigated and qualified revisions.

Evidence remains under `.artifacts/harness-remediation/H3/parent/`.
`managed-cel-candidate.json`, `rules-mapping-candidate.json`, and `canonical-candidate.json` retain independent expected outcomes.
`sarif-verdict-candidate.json`, `sarif-fault-review.json`, and `installed-cli-review.log` retain format and subprocess observations.
`cli-substitution-review.json` retains five false-pass/restoration controls.
`cel-go-candidate.json`, `cel-go-tag-review.json`, `n1-source-review.json`, and `artifact-inventory-review.json` retain provenance and scope.
`setup-cleanup.json` records the observed installer termination before any behavior gate started.
The original review retains its recorded digest. History and link validation accompany this documentation decision.

H4 is admitted next on `feature/test-harness-remediation`, starting from the parent acceptance commit.
All thirteen original H3 dispositions are accepted. Additional N1 remains open and must survive H6 reconciliation.
No hosted run, push, PR, publication, merge, actual-backend qualification, installed-editor qualification, or deferred H7 work belongs to this decision.

## H4 catalog compatibility and convergence

Status: parent accepted on 2026-11-11. All twelve original H4 findings are accepted within the declared scope.
Assigned agent: `harness_h4_catalog_backends`.
Scope: H4 only, all 12 assigned findings and H4-A1 through H4-A8.
Source/test qualification revision: `60e9ac4031908127400cd6a8b9debadb5a286e90`.
The later documentation commit records this evidence. It does not change the qualified runtime or tests.

### Implementation and reviewed contract decisions

The fake separates plugin access rejection from permission-service filtering. Raw by-refs requests retain the caller's strings.
The production client still canonicalizes references before transport. HTTP 401 and 403 still produce `permission_denied`.
A filtered 404, `null`, or empty list describes only the authorized view. It cannot prove global deletion.

The parent approved a deterministic test-app permission service on both pinned backends.
It delegates the actual `ServerPermissionClient` before it overrides an admitted read decision for authenticated `bve-filtered` credentials.
The reader's native restrictions remain intact. Both actual runs observe the native reader refresh DENY and administrator refresh ALLOW.
This covers actual catalog permission-service DENY filtering. It does not qualify a remote permission backend or conditional resource policy.

The parent approved preserving contract 0.2's CLI projection.
Actual CLI results expose `owner-exists`, `dependency_unavailable`, and the declared unavailable coverage reason.
They do not expose provider transport codes. Separate actual provider calls establish `permission_denied` for HTTP 401/403 and `offline` for outage.
The record does not infer those distinct transport causes from CLI JSON alone.

The default reference profile still selects paths across entity kinds. This over-approximates kind applicability for selected owner/system/API paths.
It does not extract every backend relation field. Membership, dependencies, subcomponent, System-domain, and Domain-parent contexts remain omitted.
The independent processor tables cover those backend relations separately. No public profile or result field changed.

### Accepted finding dispositions

| Finding | Criteria            | Independent expectation and executed control                                                                                                                                                                                                                     | Candidate disposition                                                  | Implementation state | Parent decision            |
| ------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------- | -------------------------- |
| R2-F1   | H4-A1, H4-A8        | Fake/provider tests separate plugin 403 from filtered missing. Both actual catalogs return admin/reader 200, filtered by-name 404, by-refs `null`, and query omission. Authenticated decision logs bind the read permission and native decision.                 | Implemented and executed within the reviewed permission-service scope  | Accepted             | Accepted in declared scope |
| R2-F2   | H4-A2, H4-A8        | Raw fake and actual backend requests preserve canonical keys, order, duplicates, shorthand, malformed, empty, whitespace, and case variants. Actual non-string requests return 400. Client normalization remains separate.                                       | Implemented and executed                                               | Accepted             | Accepted                   |
| R2-F3   | H4-A3               | Single-entity empty, HTML, missing-message, and mismatched-status 404 responses remain unavailable with `invalid_response`. Valid present and valid missing responses recover. Bypassing admission fails the new assertion.                                      | Implemented and executed                                               | Accepted             | Accepted                   |
| R2-F4   | H4-A4               | Six controlled-clock cases assert GET/POST, exact delta/date delays, 503, disconnect retry, two-attempt exhaustion, and cancellation. A zero-backoff variant fails the scheduled-delay assertion without a timeout.                                              | Implemented and executed                                               | Accepted             | Accepted                   |
| R2-F5   | H4-A5, H4-A8        | Thirteen fixed substitution cases run against both actual pinned processors. Separate local expectations run with both native adapters. Source hashes, Apache license, and published NOTICE remain pinned.                                                       | Explicit safe-profile differences preserved and executed               | Accepted             | Accepted                   |
| R2-F7   | H4-A5, H4-A8        | Eight fixed kind cases compare complete processor tuples, inverse/defaulted edges, and separate local selected-path references. Actual processors on both targets match the tables.                                                                              | Deliberate selected-path kind over-approximation documented and tested | Accepted             | Accepted in declared scope |
| R2-F8   | H4-A5               | A deliberately unprojected response includes private metadata/spec fields. The client returns canonical identities only. A wrong-kind response fails admission.                                                                                                  | Implemented and executed                                               | Accepted             | Accepted                   |
| R2-F9   | H4-A5               | Lightweight, two-link, and four-link tags resolve to the fixed commit. A fifth annotated link fails before artifact fetch.                                                                                                                                       | Implemented and executed                                               | Accepted             | Accepted                   |
| R2-F10  | H4-A5, H4-A6, H4-A8 | Independent golden tuples define 22 baseline and 18 mutation edges. Both actual ingestions contain all tuples, including component/resource System inverses and the existing System-Domain pair. A same-count wrong tuple fails.                                 | Implemented and executed                                               | Accepted             | Accepted                   |
| R5-F7   | H4-A6, H4-A8        | Seed schema and admission require `absentRelations`. Convergence rejects old ownership and API edges. Actual mutation converges with three absent tuples. Removing the guard fails the isolated test.                                                            | Implemented and executed                                               | Accepted             | Accepted                   |
| R5-F8   | H4-A7, H4-A8        | Actual packaged CLI cases assert exact exits, native/YAML finding identities, required-processor coverage, unavailable rule state, and coverage reason. Seven altered-result controls fail. Separate actual providers establish the underlying transport causes. | Implemented with parent-reviewed contract 0.2 projection limit         | Accepted             | Accepted in declared scope |
| R5-F10  | H4-A7, H4-A8        | The same valid refresh body returns administrator 200 and reader 403. Reader by-name read remains 200. Native decision logs establish the authorization difference on both targets.                                                                              | Implemented and executed                                               | Accepted             | Accepted                   |

### Acceptance criteria and actual selectors

| Criterion | Executed evidence                                                                                                                                                                                                               | Candidate result                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| H4-A1     | `permission-policy DENY filters existing entities while explicit plugin denial remains unavailable`; actual `permission-service-filtered-absence-and-explicit-plugin-rejection` and `authenticated-native-permission-decisions` | Pass on both fixture and actual pins. Parent accepted.                                                       |
| H4-A2     | `catalog fake uses case-insensitive by-name triplets and raw by-refs database keys`; actual `raw-byrefs-parser-and-database-contract`                                                                                           | Pass. Each actual target covers ten raw strings and a non-string rejection.                                  |
| H4-A3     | `single-entity malformed 404 responses remain unavailable and valid absence recovers`; isolated `malformed404-admission-bypassed`                                                                                               | Corrected case passes. Faulty variant fails an assertion.                                                    |
| H4-A4     | `controlled HTTP retries preserve GET/POST, exact delays, bounded attempts and cancellation`; isolated `retry-zero-backoff`                                                                                                     | Six cases pass. Zero-delay fault fails the intended scheduled-delay assertion.                               |
| H4-A5     | `backstage-behavior.test.ts`, independently unprojected search, tag-chain cases, and actual `pinned-upstream-substitution-and-reference-tables`                                                                                 | Both native adapters and both actual upstream processors match their separate fixed tables.                  |
| H4-A6     | `actual HTTP convergence rejects stale ownership/API edges and same-count wrong graph tuples`; actual baseline/mutation/recovery graph cases                                                                                    | Required graph and three absent mutation tuples pass actual ingestion. Stale and wrong-target controls fail. |
| H4-A7     | Actual CLI cases, seven result mutations, actual provider credential/outage causes, and native reader refresh restriction                                                                                                       | All declared focused cases pass on both actual targets.                                                      |
| H4-A8     | Exact clean source/artifact plus per-target app, lock, installed package, SQLite, Node, base-image, and derived-image identities                                                                                                | Both supported actual targets pass 22/22 focused cases. No installed editor or release-wide claim.           |

The focused no-Docker selector includes these seven files:
`backstage-behavior.test.ts`, `backstage-convergence.test.ts`, `backstage-environment.test.ts`, `catalog-api.test.ts`,
`catalog-provider.test.ts`, `catalog-suggestions.test.ts`, and `release-refresh.test.ts`.
The development run passes 132/132 tests, with zero failures, cancellations, or skips.
The full gate discovers those files independently through the normal source inventory.
Existing LSP and installed-fixture principals that require explicit 403 now select plugin denial explicitly. Their assertions remain unchanged.

### Actual backend identities and evidence

The final CLI archive SHA-256 is `0feeb3eb31506c617c72985ccf97f024ab2138b529eaa6461745b04a05fed076`.
Its clean sidecar binds revision `60e9ac4031908127400cd6a8b9debadb5a286e90` and root lock SHA-256 `dbd025198eb555e06edf78f0c8f420eef786c445a9eaf01b488ea34ec4669b8b`.
Its bytes match the preceding runtime candidate because H4 changes tests and test applications, not production code.
The new sidecar and app identities qualify this revision. Historical H3 evidence does not qualify H4.

Both runs use Node `v24.22.1`, Docker `29.9.2`, `better-sqlite3` `12.4.1`, and SQLite `3.50.4`.
All eight vendored source texts match their same-target official GitHub commit bytes.
`upstream-official/comparison.json` retains those comparisons and the fetched official texts.
An initial audit mistakenly compared a 1.56.3 map with a 1.55.3 source. The same-target comparison resolves that false alarm.
The parent reviewed this correction and removed the triggered whole-package audit requirement.
The permission wrapper uses the already locked `@backstage/plugin-permission-node` `0.11.5`.
Each derived image admits the changed direct dependency with `yarn install --immutable --mode=skip-build`.
The app configuration SHA-256 is `e666156b048f82b9d928153fabee4507caf63467c545b3e590e2ccbdd049bf54`.
The permission-wrapper source SHA-256 is `4a31e8cf35b602dccf0a77185a01f1be5cdac7f7532765d274591dd53e548e08` for both applications.

| Target | Source commit                              | App lock SHA-256                                                   | Base image identity                                                       | Qualified derived image identity                                          |
| ------ | ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1.55.3 | `6c66969256572989ed10ee862b26065a0980c0bd` | `2bec49ad0113e7dc53a80cfaa441d274144e562e7a6a81bfcaa0e84fa9bdc89a` | `sha256:d02d3fe16e133d6000938b32e386c4bca55014b30ffc6690a911f58aa5d11bb0` | `sha256:0f3cc3b9726765fcc8c2a190fbd21c36f5a1210209f35df778b8421d200059f7` |
| 1.56.3 | `7e29caf1d87edb3c51bd07f85d0f7f8c4f0a33c0` | `303646c248f1f0f3e65dae0274e104ea0836cdbae5cba6afcefb25f829a63b38` | `sha256:ae705e12948e3f9d5db0a096785c4f761d2df427b82a5889a6f96319ac528d8a` | `sha256:cb4c1f9241c670f3e887d069f94da74435c4b13e2613a179a54f1ed2fb276c88` |

Final reports remain in ignored evidence:
`.artifacts/harness-remediation/H4/backends/bve-h4-1-55-3-73e8992e26/report.json` and
`.artifacts/harness-remediation/H4/backends/bve-h4-1-56-3-0dc558089d/report.json`.
They retain every case, the complete selected graph, exact installed package versions, CLI result projections, and sanitized permission decisions.
Both runs remove their owned containers and SQLite volumes. Credentials remain in private evidence directories.
The command never changes manual-demo resources or performs a global Docker prune.

The repeatable command is `node scripts/test-h4-backends.mjs --cli .artifacts/cli/chtaylo3-backstage-validation-engine-0.1.0-dev.0.tgz`.
Run it from a clean qualification checkout after `npm run cli:package`.
Use `--target 1.56.3 --keep` for independent inspection. The private connection file identifies the owned container, volume, endpoint, and environment file.
The actual commands and final qualification summaries remain under `.artifacts/harness-remediation/H4`.
The focused published-port runner preserves the existing host-network CI and Docker Desktop/WSL SSH designs.

### Retained failed attempts and fault demonstrations

The first focused development run records 102 passes and 29 failures out of 131 tests.
The failures exposed new-test setup errors: the wrong finding prefix, an unresolved Location target, and a raised retry delay.
The corrected behavior/provider subset passes 87/87. The complete focused set then passes 132/132.
The first compile also treated vendored `.ts` source as local code. The retained source files now use `.ts.txt` and stay outside compilation.
Initial lint findings concerned fixture typing and missing runtime imports. The final full gates pass after those corrections.
No product budget, threshold, or existing assertion changed.

The first image preflight used unsupported Yarn `skip-builds`. The corrected supported option is `skip-build`.
Both logs remain in `development/image-preflight*.log`. Immutable installation passes after that command correction.

The first actual backend attempt failed the preliminary empty-YAML table expectation.
Actual pinned parsing returns zero documents and rejects empty YAML. The reviewed table now records rejection for both profiles.
Both actual processor runs pass the corrected table. The earlier failed report remains at `backends/bve-h4-1-55-3-b21e4231fa/report.json`.

The second actual attempt failed the exact native finding assertion.
The original scenario removed only `type: service\n` and left indentation that produced a YAML syntax error.
Removing the complete indented field line reaches `backstage/kind/invalid_kind`.
The failed wrong-layer report remains at `backends/bve-h4-1-55-3-877181fc70/report.json`.
The final actual result-mutation control also rejects substituting a YAML finding for native rejection.

The third actual attempt passed baseline, permissions, CLI reasons, mutation, and outage, then failed recovery observation.
Docker reassigned the automatically published host port after stop/start. The observer retained the earlier endpoint.
The focused runner now publishes one concrete OS-selected port across restart. It retains the same convergence deadline.
The failed report remains at `backends/bve-h4-1-55-3-f34550f77b/report.json`.
Both final actual targets pass recovery with that lifecycle correction.

`fault-controls/report.json` records five corrected/faulty pairs at the final source revision.
Corrected cases pass. Old raw normalization, old filtered-403 behavior, removed absent-edge guard, bypassed 404 admission, and zero backoff each fail assertions.
The zero-delay fault fails its scheduled-delay assertion, not an observation timeout.
Earlier 8695078 fault evidence remains in its separate subdirectory.
Parent-owned baseline false-success and current convergence observations remain untouched under `H4/parent`.
The parent also repeated the final 1.56.3 22-case run and twelve direct API/graph observations, then removed its owned resources.
Its corrected raw-reference probe uses deep equality and records baseline 4/10 and current 10/10 matches on each pin.
The earlier key-order-sensitive probe remains retained. Those preliminary counts do not describe semantic raw-reference behavior.

### Full qualification and limits

The exact final source/client gate passes `npm run check`: 1,330 source tests and 43 client tests.
There are zero failures, cancellations, skips, or todos. Architecture, type, lint, format, schema, and build gates pass.
The client coverage remains 100% lines/functions and 96% branches. Existing thresholds remain unchanged.
`development/check-qualified.log` and the source/client inventories retain the actual selector and counts.

A preliminary VSIX used the `local` build stamp and passed 1,330 packaged tests. It receives no exact-revision qualification claim.
Its candidate and log remain separate from the exact-stamped final artifact.
The follow-on archive setup mistakenly invoked the CI candidate downloader without its required CI identity.
Its admission assertion failed before any download. The local archive qualification uses an offline installation instead.
The exact-stamped final VSIX passes all 1,330 packaged tests with zero failures, cancellations, skips, or todos.
Build command: `GITHUB_SHA=60e9ac4031908127400cd6a8b9debadb5a286e90 npm run extension:package`.
The following `npm run test:packaged` runs serially after the source/client gate.
The final build stamp records the exact source revision, Linux x64, and Node 24.22.1.

Final VSIX SHA-256: `2d9f20eb8603f65fdb9f13e0a96c3a7c8d2a3852c57e8b03731d087a7591e7ff`.
Its size is 52,086,897 bytes, with 5,079 files.
Packaged Node SHA-256: `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`.

The final CLI archive installs 24 packages into a fresh offline prefix.
The task cache lacks a required registry metadata response, so its first install fails with `ENOTCACHED`.
The existing verified registry cache admits the same archive. Both setup logs remain retained.
All 22 CLI tests pass through the installed archive with the final packaged Node runtime.
There are zero failures, cancellations, skips, or todos.

`qualification/source`, `qualification/client`, and `qualification/packaged` retain their complete inventories and reports.
`qualification/manifest.json` binds the counts, exact stamps, candidate hashes, backend reports, and fault controls.
`qualification/commands.json` retains the actual commands. `candidates/final-60e9ac4` retains both final artifacts and their identity files.
A preliminary inventory copy overlapped the stamped run's writer. It remains explicitly unqualified under `development/incomplete-preliminary-inventory-copy`.
Only the completed final inventories support this record.

Changed documentation passes scoped Prettier admission and all 31 relative file links resolve.
The original user-owned review retains SHA-256 `3814987bbc5b962b5638cecde322054d33db400d52a7ae212adec7e5530cd5d7`.
The parent accepted every H4 criterion and finding through the independent review below.
The agent handoff did not start H5 or H6. The subsequent parent decision admits H5. H7 remains deferred.
Additional finding N1 remains OPEN beyond the original 86 findings. H4 does not change or accept its duplicate CEL map-key behavior.

### Parent acceptance

Parent decision: accepted on 2026-11-11 for all eight H4 criteria and all twelve assigned original findings.
Documentation-only handoff: `265ab93`. Qualified source/test revision: `60e9ac4031908127400cd6a8b9debadb5a286e90`.
The parent inspected all changed boundaries, fixed expectations, five fault pairs, source provenance, and complete inventories.
The accepted scope retains the permission-service policy, selected-path profile, and CLI projection limits described above.
No application contract, production limit, or performance threshold changes through this decision.

| Criterion | Independent parent evidence                                                                                                                                                                                                               | Decision                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| H4-A1     | Repeated all 22 actual 1.56.3 cases. Direct requests show administrator/reader reads, filtered 404/null/empty results, and explicit plugin 403. New native decisions follow those requests.                                               | Accepted within the declared permission-service scope |
| H4-A2     | Ten independent raw-reference cases pass on each corrected fixture pin. Both actual targets and the direct API repeat match exact lookup and non-string rejection.                                                                        | Accepted                                              |
| H4-A3     | Eight cases and eight recoveries cross the final stamped packaged provider API. Malformed 404 bodies remain unavailable, valid absence stays missing, and 401/403 retain their existing cause.                                            | Accepted                                              |
| H4-A4     | Inspected six clock-controlled cases and the executed final fault evidence. The zero-delay fault fails its scheduled-delay assertion rather than a timeout.                                                                               | Accepted                                              |
| H4-A5     | Independently matched all eight source files to official same-target Git blobs. Reviewed separate local/upstream tables, full hand-authored graph tuples, projection, and tag bounds.                                                     | Accepted for the declared tables and profile          |
| H4-A6     | Old helper admits obsolete edges. Current helper rejects the same two stale edges with all required edges present. Direct actual mutation checks confirm all eighteen required and three absent tuples.                                   | Accepted                                              |
| H4-A7     | Independent observers admit twenty-four actual CLI results and reject six result mutations plus the retained wrong-layer native case. Actual refresh succeeds for the administrator and fails for the reader through native restrictions. | Accepted within public contract 0.2                   |
| H4-A8     | Recomputed final VSIX, CLI, runtime, and revision identities. Matched both 22-case backend reports and completed source/client/package inventories to the exact qualified inputs.                                                         | Accepted for executed Linux x64 scope                 |

The independent actual backend repeat is `parent-backend/bve-h4-1-56-3-e6d515d085`.
All twenty-two focused cases pass. Twelve further direct requests prove exact references, permission decisions, and the declared mutation graph.
Those direct checks observe ten new native permission decisions after the observation barrier.
The parent verifies resource ownership labels before removing its container and SQLite volume. No owned resource remains.
`parent/backend-api-candidate.json` and `parent/backend-cleanup.json` retain those observations.

`parent/cli-verdict-candidate.json` retains twenty-four actual result checks across both agent runs and the independent repeat.
It rejects six altered-result controls. The old actual YAML failure also fails the native observer.
The public CLI transport-cause projection remains a documented limit. Separate provider evidence establishes the underlying causes.

`parent/baseline-convergence.json` and `parent/candidate-convergence.json` retain the repaired false-success path.
The helper bytes used in the independent control remain unchanged through the qualified revision.
The parent hand-authored twenty-two baseline and eighteen mutation tuples from the pinned processor and matched them to both seeds.
`parent/expected-graphs.json` retains those expectations separately from the agent's golden file.

The first parent raw-reference probe incorrectly compared JSON object member ordering.
That probe and its raw observations remain retained. The corrected observer uses deep equality.
The old fixture matches four of ten cases per pin. The corrected fixture matches all ten per pin.
`parent/baseline-raw-references-corrected.json` and `parent/candidate-raw-references.json` retain the semantic comparison.

`parent/official-source-blobs.json` independently verifies all eight exact official source blobs.
`parent/upstream-permission-review.json` records both native restriction implementations and the catalog filtering path.
A preliminary cross-version comparison caused an apparent source mismatch. Same-target comparisons resolve it without source changes.
The published license and NOTICE identities remain retained. No whole-package corruption claim follows from that mistaken comparison.

The final stamped provider repeat admits all eight fixed classifications and all eight subsequent recoveries.
`parent/stamped-provider-responses.json` and `parent/artifact-inventory-candidate.json` bind the observations and final identities.
The parent inspected complete 1,330 source, 43 client, 1,330 packaged, and 22 installed-archive CLI results.
All pass with zero failure, cancellation, skip, or todo. These remain distinct inventories and application boundaries.
The package harness uses the packaged runtime and packaged CLI/LSP entry points. Direct package API probes remain separately identified.

H5 is admitted next from the local parent acceptance commit on `feature/test-harness-remediation`.
H6 waits for H5 acceptance. H7 remains deferred, and additional N1 remains open beyond the original 86 findings.
This decision authorizes no push, PR, publication, merge, hosted run, or release-wide client qualification.

## H5: installed editor outcomes and measurement policy

Agent disposition: complete for the admitted desktop scope. Parent decision: accepted for that scope.
Qualified source/test revision: `5ca82fbf4457553ab4c8e0b7b2bb915485e9083a`.
H6 was unassigned at the agent handoff. The parent decision below admits H6. H7 remains deferred.
R4-F10 remains Partial because its strengthened native Trust assertions are UNEXECUTED and parent-unaccepted.
That qualification remains within the existing H7 Trust deferral. It does not expand H7.

The client now completes search commands after picker dismissal and accepted asynchronous work.
Startup failures expose fixed sanitized reasons. Stop exposes a fixed output message.
The bounded, opt-in filesystem observation proves admitted notification receipt without provider or filesystem reads.
The [LSP guide](lsp.md#host-observation-of-admitted-filesystem-events) defines its approval, lifecycle, reset, and payload limits.
Public validation 0.2 fields, capability ownership, credentials, engine limits, and numeric performance caps remain unchanged.

### Exact qualification and scope

The clean source/client gate passes 1,341 source tests and 45 client coverage tests.
The exact-stamped VSIX then passes all 1,341 packaged tests. These gates run serially.
All have zero failures, cancellations, skips, or todos. Coverage thresholds remain unchanged.
Client coverage is 99.79% lines, 95.87% branches, and 98.25% functions.

VSIX SHA-256: `5d06602358da7d507cbae6df26606f6090fd14c49d0efbcfb3c90f3d2c912945`.
The artifact contains 5,079 entries and 52,088,729 bytes. It targets Linux x64.
Its packaged Node 24.22.1 SHA-256 is `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`.
Build command: `GITHUB_SHA=5ca82fbf4457553ab4c8e0b7b2bb915485e9083a npm run extension:package`.
The final package build uses an entirely clean qualification checkout.

The focused inventory selects 30 of 58 installed modules on each VS Code version, 1.106.3 and 1.145.2.
All 60 selected combinations receive passing observations across 62 executions.
The initial run passes 58 and fails two with native X connection errors.
Only those two cases repeat on an owned Xvfb display. Both pass with unchanged source, artifact, assertions, and budgets.
The original failed rows remain failed. The scoped verdict records every attempt and its attribution.
The 28 unselected modules per version receive no installed qualification claim.
`qualification/installed-selection.json` lists every selected and unexecuted ID.

The final fault run rejects all 23 isolated faulty VSIX variants at intended assertions across 33 negative case executions.
It uses VS Code 1.145.2 on Linux x64. No accepted fault result depends on a launch failure or timeout.
The normal cases also exercise valid and invalid inputs on both editor versions.
The parent separately repeats five cases on 1.106.3, all passing, and confirms owned process cleanup.
These focused observations do not establish another platform, whole-inventory release, remote, JetBrains, Trust reliability, or long-workload qualification.

### Finding dispositions

Ready means implemented and verified in the stated scope, awaiting parent review.
The finding register remains the frozen assessment baseline.

| Finding | Agent disposition | Observable result and independent control                                                                                                                                                                                                                               |
| ------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4-F1   | Ready             | `performance-budget` completes a deliberately delayed real request above 20 seconds, below 60 seconds, then rejects its budget. Controlled-time pending and cancelled attempts share one deadline.                                                                      |
| R4-F2   | Ready             | Exactly ten warmup operations precede each resource window. Four retained RSS/handle leaks inside the old discarded quarter now fail. Short native runs claim no slope.                                                                                                 |
| R4-F3   | Ready             | Ten configuration modes show their exact sanitized reason, then recover through installed Restart. Collapsed-reason variants fail all ten assertions.                                                                                                                   |
| R4-F4   | Ready             | Unapproved open precedes an approved current-version publication and same-PID control. Complete wire history rejects persistent and transient admission leaks.                                                                                                          |
| R4-F5   | Ready             | Exact native watcher receipt precedes completed coverage with unchanged dirty version/digest. Dropped-event and transient wrong-publication variants fail.                                                                                                              |
| R4-F6   | Ready             | Native cancellation and stale selection await command completion. Early completion and stale insertion variants fail.                                                                                                                                                   |
| R4-F8   | Ready             | Actual stop/crash exposes expected output, clears diagnostics, and produces no later-edit findings. Message-loss variants fail.                                                                                                                                         |
| R4-F9   | Ready             | Actual trusted policy changes suggestions with the same PID. Correlated explicit reload request/reply is required. No-op and false-reply/later-true variants fail.                                                                                                      |
| R4-F10  | Partial           | Desktop watcher/fix/close/two-window/coexistence controls retain same-server positive observations. Native Trust assertions are strengthened but UNEXECUTED and parent-unaccepted until existing H7 work.                                                               |
| R4-F11  | Ready             | A buffer one byte above the unchanged file cap must publish incomplete. Whole-document Quick Fix requests find no guarded actions. Action-offer and missing-bound variants fail before valid recovery.                                                                  |
| R4-U1   | Ready             | No-editor selection writes the real clipboard. Fresh normal-workbench activation restores eligible completion ranking. Missing history replay fails. Native QuickPick display ordering is not claimed.                                                                  |
| R4-U2   | Ready             | Actual hover includes the required value. Unique definition succeeds and duplicate targets return empty. Missing constraint and arbitrary-definition variants fail.                                                                                                     |
| R4-U3   | Ready             | Unique valid fixtures prove include/exclude, depth bound, failed reload, and recovery. Exclusion/depth bypass variants fail. Whole-document absence requests cover the repair surface.                                                                                  |
| R4-U4   | Ready             | Actual token-file rotation gives authenticated denial/recovery with unchanged text/version and same PID. Old repair fails. Fresh repair changes exactly one scalar. Generation bypass performs an actual forbidden edit and fails. Permanent repair refusal also fails. |
| R4-U5   | Ready             | Installed `owner-exists` dependency Warning and `production-only` policy Error have exact rule/category controls. Wrong severity fails.                                                                                                                                 |

### Acceptance mapping

Every criterion below awaits the parent's decision. Each pass refers only to the admitted desktop scope.

| Criterion | Agent evidence                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H5-A1     | Both-pin configuration cases and ten collapsed-reason negative controls.                                                                                                                 |
| H5-A2     | Approved publication barriers, bounded full wire histories, exact watcher receipt, completed coverage, and same-PID/live positives.                                                      |
| H5-A3     | Installed changed-policy reload with correlated successful reply, manual crash recovery, and stopped-edit/output/diagnostic controls.                                                    |
| H5-A4     | Deterministic byte admission, current-version incomplete, full-document guarded-action absence, old-token rejection, and valid repair recovery.                                          |
| H5-A5     | All five supplemental gaps have installed positive and negative observations. Targeted faulty variants reject each gap.                                                                  |
| H5-A6     | Parent-approved provisional policy precedes window changes. Actual delayed completion exceeds the unchanged budget before observation expiry.                                            |
| H5-A7     | Generated host verdict accepts four actual short-load reports and rejects retained-leak/insufficient-slope controls. Parent independently repeats 19 metric and three deadline controls. |
| H5-A8     | Both pinned editors provide passing observations for all 60 selected combinations on Linux x64, with exact artifact and attempt attribution.                                             |

### Measurement and evidence

The [qualification guide](vscode-qualification.md#h5-provisional-measurement-policy) defines inclusive budgets, nearest-rank p95, sample counts, and included windows.
No numeric cap increases. The extra discarded quarter is removed.
The inner `until`/`readProvider` deadline is 60,000 ms total, including pending checks and cancellations.
The fixture `bounded` wrapper permits 65,000 ms for outer grace. Production request deadlines remain unchanged.
Each of four short loads records 60 edits, 60 completions, two restarts, and 22 resource samples.
The independent host verdict accepts all four. No native process window spans 100 measured operations.
The current observations do not qualify a slope, long endurance, or a responsiveness service-level agreement.

All retained evidence is under `.artifacts/harness-remediation/H5`.
`qualification/manifest.json` binds exact inputs, complete inventories, 64 passing client runtime records, server PIDs, controls, raw traces, and parsed windows.
`qualification/scoped-installed-verdict.json` preserves the 62-execution attribution.
`qualification/fault-controls` retains every final faulty archive, mutation count, child report, and intended assertion.
`qualification/metric-verdict.json` binds the four raw measurements to the generated host verifier.
`qualification/commands.json` names the sequence and selectors. The clean qualification checkout and final candidate remain retained.
Primary standard VS Code artifacts remain development inputs. Use the final candidate and qualified checkout named by the manifest.

Earlier development failures remain retained and receive no qualification claim.
They include hover escaping, test-mode in-memory history, a normal-workbench save prompt, duplicate fixture identities, and pre-watch publication ordering.
An ineffective one-layer admission mutant remained blocked by independent guards. It is not counted as detection.
The preliminary 4ac matrix passes 59/60. Its older editor already publishes incomplete while the unsupported exact-leaf notification barrier waits.
Directory notifications and automatic reload overlap there, so no exclusive causality or missed-capture claim follows.
The final depth control uses an exact approved-file rescan hint after full subtree creation.
A preliminary cache alias appears untracked. The final candidate rebuild follows its correction and has clean inputs.

The private Xvfb wrapper, socket, lock, and descriptor are removed. The shared display is unchanged.
The original review retains SHA-256 `3814987bbc5b962b5638cecde322054d33db400d52a7ae212adec7e5530cd5d7`.
The root lock retains SHA-256 `dbd025198eb555e06edf78f0c8f420eef786c445a9eaf01b488ea34ec4669b8b`.
Additional N1 remains OPEN beyond the original 86 findings. Duplicate CEL map literals still retain the last value in both pinned engines.
H6 must carry N1 and the Partial native Trust disposition. Neither is fixed, waived, or added as a new H7 scope item.

### Parent acceptance

Parent decision: accepted on 2026-11-11 for the executed H5 desktop scope and all eight scoped criteria.
The qualified source/test revision is `5ca82fbf4457553ab4c8e0b7b2bb915485e9083a`.
Fourteen assigned findings are accepted. R4-F10 remains Partial solely for its unexecuted native Workspace Trust follow-up.
Those native assertions receive no acceptance through this decision. H7 retains their execution and reliability qualification.

| Criterion | Independent parent evidence                                                                                                                                                                                                                                     | Decision                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| H5-A1     | Inspected all ten configuration fault/recovery cases and their targeted installed negative controls. Repeated config-missing against the stamped VSIX.                                                                                                          | Accepted                                         |
| H5-A2     | Inspected ordered watcher receipts, unchanged dirty-source digest/version, current-generation publications, and live policy findings. Repeated dirty-watch and independently decoded positive and transient-fault raw publication histories.                    | Accepted within executed desktop scope           |
| H5-A3     | Inspected actual old/new results, same-PID reload, correlated successful explicit reload response, and stop/crash reason faults. Later responses cannot satisfy an earlier failed reload.                                                                       | Accepted                                         |
| H5-A4     | Inspected exact overflow/incomplete evidence, whole-document guarded action queries, stale repair rejection, and applied recovery. Both incomplete-state and unsafe guarded-action faults fail their direct assertions.                                         | Accepted                                         |
| H5-A5     | Repeated actual search history across fresh editor activations and credentials without document changes. Inspected discovery/hover/navigation outcomes and all targeted faults. The credential-generation fault actually applies a stale edit before rejection. | Accepted within executed desktop scope           |
| H5-A6     | Independently replayed inclusive budget boundaries and bounded pending checks. Repeated actual suspended-server latency negative control. Caps and production deadlines remain unchanged.                                                                       | Accepted under the documented provisional policy |
| H5-A7     | Replayed the actual generated host verdict with nineteen fixed metric controls, including four retained leaks admitted by the old window. Insufficient-slope controls remain rejected. Replayed all four actual short workloads without a long-duration claim.  | Accepted                                         |
| H5-A8     | Independently recomputed the final artifact identity and reconstructed all sixty selected passing case/version combinations from their exact reports. Repeated five cases on VS Code 1.106.3.                                                                   | Accepted for Linux x64 only                      |

The final VSIX SHA-256 is `5d06602358da7d507cbae6df26606f6090fd14c49d0efbcfb3c90f3d2c912945`.
It contains 5,079 entries and 52,088,729 bytes. Its stamp identifies the qualified source and Node 24.22.1.
The parent independently matched the packaged runtime and unchanged generated verdict helpers to their recorded hashes.
All 1,341 source, 45 client, and 1,341 packaged tests pass with zero failures, cancellations, skips, or todo.

The initial installed matrix has 58 passes and two failures with actual X connection errors.
Only those two cases rerun on an owned private Xvfb display, with unchanged source, artifact, assertions, and budgets.
Both pass. The accepted matrix therefore has sixty unique passing combinations across sixty-two executions.
The original two failed rows remain failed. This decision does not call the initial matrix a clean run.
`parent/native-attribution-review.json` independently reconstructs that attribution.

All twenty-three deliberately faulty VSIX variants fail their intended assertions across thirty-three child executions.
`parent/fault-attribution-review.json` retains the independent artifact and failure inspection.
The stronger credential-generation fault changes version 2 to 3 and actually edits the unchanged document after denial.
The corrected candidate rejects that repair and applies a fresh repair after recovery.

`parent/raw-publication-review.json` matches the positive windows to complete retained editor logs with an independent JSON decoder.
`parent/transient-publication-review.json` observes each injected wrong publication followed by its later clear.
Both tests reject the transient result directly. No final-state-only assertion substitutes for these histories.

The parent repeats config-missing, editor-search, editor-credentials, race-dirty-watch, and performance-budget on the exact stamped candidate.
All five pass. `parent/native-repeat/installed/results.json` and `parent/native-repeat/run.log` retain the execution.
All thirteen recorded repeat process IDs are absent after cleanup.
A separate read-only inspection of ninety-seven final qualification progress files finds all 208 recorded editor/server process IDs absent.
The private display controller exits, and shared display resources remain untouched.

`parent/accepted-source-host-metric-window.json` and `parent/accepted-source-host-metric-boundaries.json` retain the fixed verdict controls.
`parent/final-readiness-deadline.json` proves pending checks and repeated cancellations share one 60-second observation deadline.
`parent/actual-load-verdict-review.json` retains four actual short workload replays.
Each workload has sixty edits, sixty completions, two measured restarts, and twenty-two resource samples.
These workloads do not span the required hundred operations for slope qualification. No endurance qualification follows.

H6 is admitted next from the local parent acceptance commit.
H7 remains deferred. Additional finding N1 remains Open beyond the original 86 findings.
This decision authorizes no push, PR, publication, merge, hosted workflow dispatch, or final release qualification.

## H6 evidence inventories and documentation

Agent disposition: implemented. Parent acceptance remains pending. H7 remains deferred.
Baseline: `17cf56a27ed860baef1126caa86820bdfbf93420` on `feature/test-harness-remediation`.
The 2026-11-10 approval admits H6 after parent acceptance of H5 on 2026-11-11.
This phase changes harness controls and evidence documentation. It preserves public validation 0.2 and production request budgets.
The committed source and final qualification identities follow below after execution.

### Finding and criterion mapping

These are H6 agent results. Parent acceptance remains pending for each row.
The seven findings retain their frozen register ownership and amendments.
Each criterion maps to the actual control and its evidence boundary.

| Finding | Criteria     | Implementation and observable control                                                                                                                                                                                     |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-F6   | H6-A3, H6-A6 | Rename the misleading provider label to fake captured API contracts. Eight version-sensitive paths exercise both pins. Separate native 1.7.5/1.10.2 from backend 1.55.3/1.56.3 and their models 1.10.1/1.10.2.            |
| R2-F11  | H6-A3, H6-A6 | Correct by-query, fixed projection/cursor, authorization filtering, backend patch, and dated qualification claims in the guides.                                                                                          |
| R4-F14  | H6-A3        | Actual shared selector and independent module inventory establish 58 total and 50 portable modules. Preserve historical cross-OS, Linux, and focused H5 scopes.                                                           |
| R4-F15  | H6-A5        | Screenshots are OPTIONAL DIAGNOSTICS. Capture/write failures are optional. Required workbench actions and Trust assertions retain their failures.                                                                         |
| R5-F11  | H6-A2        | Guard manual default-false approval, `needs: [cli]`, exact requested revision, immutable Actions, `always()` evidence uploads, and exact sanitized Backstage paths.                                                       |
| R5-F12  | H6-A1        | Independent synthetic inventory and identities pass. Named version, driver, matrix, count, and case mutations fail. An isolated loader omission fails the independent fixture but passes the former self-derived fixture. |
| R5-F13  | H6-A4        | Actual constructor retains phase/session-scoped sanitized authority reports. Narrowed trust age binds expiry. Later construction preserves earlier evidence. Document inline proposals and absent bundle validity fields. |

| Criterion | Actual selector or inspection                                                                                                     | Required and observed boundary                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H6-A1     | `backstage-release-evidence.test.ts`                                                                                              | Independent valid evidence, 22 retained report mutations, 14 named negative controls, and isolated loader omission. Synthetic verifier controls only.             |
| H6-A2     | `backstage-release-workflow.test.ts`                                                                                              | Ordinary automated CI avoids Docker. Manual exact-revision caller and unconditional evidence retention remain required.                                           |
| H6-A3     | `qualification-inventory.mjs` and `versioned installed inventory uses the actual portable selector without a qualification claim` | Exact source revision, declared client/platform/mode, counts, and both actual caller input forms. No execution claim.                                             |
| H6-A4     | `actual fixture construction retains sanitized authority inputs and effective expiry`                                             | Actual signed fixture inputs match the retained sanitized report. Narrowed trust age expires at its exact bound. Earlier report bytes survive later construction. |
| H6-A5     | `optional screenshot failures cannot hide independent workbench action failures`                                                  | Capture can fail while a separate required workbench evaluation still throws. No native Trust execution.                                                          |
| H6-A6     | Current disposition table below                                                                                                   | All 86 original findings have exclusive ownership and an explicit disposition. N1 remains open outside the register.                                              |

### Independent evidence and authority construction

`test/fixtures/backstage-evidence-controls.json` freezes independently serialized cases, input digests, sources, packages, base image, and locks.
It names baseline revision `17cf56a27ed860baef1126caa86820bdfbf93420` and labels its synthetic purpose.
The report uses this record, never the expectation loader under test. It does not represent executed release qualification.
A data-URL copy of the loader drops its first case. The independent comparison and report reject that omission.
The former self-derived report accepts that faulty expectation output. This demonstrates the reviewed evidence gap.
Existing production guards already pin editor versions, SQLite driver 12.4.1, and nonempty target matrices.
H6 adds missing regression controls rather than inventing a product defect.

The constructor test calls `createClientFixture` with the real source engine through an explicit harness dependency.
It reads actual generated signed release, trust, activation, launcher, proposal bytes, and retained authority evidence without Docker.
Default trust age is 3,600,000 ms. A 60,000 ms control proves effective expiry uses the shorter bound.
The effective expiry is `min(release.expiresAt, release.issuedAt + trust.maxAgeMs)`. Verification at that exact expiry fails.
Contract 0.2 bundles contain no validity fields. The contract rejects a bundle `expiresAt` field.
Internal evidence records `bundleValidity.present: false` without adding a public contract field.
`constructionVerification.verifiedAt` describes only the constructor's actual verification. Later CLI verification happens independently.
The launcher-based LSP does not authenticate the signed release itself.
CLI authority filenames identify the phase, with a separate processor suffix. Each editor session/version retains its own `authority.json`.
The report excludes keys, signatures, tokens, endpoints, launcher data, and private paths.
A later fixture preserves earlier report bytes. Source construction evidence does not qualify actual backends or installed clients.

### Inventory and historical qualification boundaries

`node scripts/qualification-inventory.mjs` prints exact source revision, tracked-change status, client, platform scope, mode, and counts.
It reads the actual shared installed selector and versioned Backstage inventories. It executes no qualification.
The current installed inventory contains 58 modules. Its ordinary portable selector includes 50.
Independent controls compare recorded filenames with source files, compiled names, and the verifier's bare IDs.
The Backstage inventory declares 47 cases: nine environment, 16 CLI, 12 editor, and ten runner.
Two editor versions expand it to 59 per backend and 118 across two backends.

Historical cross-OS source `6938b8b85c1b5889af3fbe1119684de6577e5b45` uses 44 portable cases, or 88 executions per OS.
The later Linux source `54ce7a932c46b85e70f3fec0a68c15852af7e28b` uses 46 cases, or 92 ordinary executions.
Pre-merge 92-execution reports retain their own candidate identities above.
H5 source `5ca82fbf4457553ab4c8e0b7b2bb915485e9083a` selects 30 cases on editors 1.106.3 and 1.145.2 on Linux x64.
Its 60 passing unique combinations span 62 attempts. Both original X display failures remain failed.
The 28 unselected modules per editor receive no H5 installed qualification claim.
H5's short loads do not qualify a 100-operation slope or endurance.
The current policy retains inclusive 20,000 ms caps, exactly ten resource warmup operations, and all subsequent samples without quarter exclusion.
Inner observation is 60,000 ms total, including pending checks/cancellations. Outer fixture grace is 65,000 ms. Production deadlines remain unchanged.

H4 executes a separate 22-control scope per actual backend.
It qualifies source `60e9ac4031908127400cd6a8b9debadb5a286e90` and CLI SHA-256 `0feeb3eb31506c617c72985ccf97f024ab2138b529eaa6461745b04a05fed076`.
Those older backend and native records do not qualify the final H6 candidate at their application boundaries.
H6 source/client/package gates establish no new cross-platform, installed, actual-backend, native Trust, remote, JetBrains, or endurance qualification.

### Current disposition of the original 86 findings

This table reconciles evidence without changing the frozen register.
Accepted and Clarified states refer to the parent's earlier phase decisions and their recorded limits.
H6 findings remain ready for parent review. H7 findings remain deferred and open.
R4-F10 remains Partial solely for strengthened but UNEXECUTED and parent-unaccepted native Workspace Trust follow-up.

| Finding | Owner | Current disposition   | Evidence or unresolved boundary                                                                                                                |
| ------- | ----- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| R4-F13  | H1    | Accepted              | [H1 parent acceptance](#h1-accepted-implementation) within recorded scope                                                                      |
| R5-F1   | H1    | Accepted              | [H1 parent acceptance](#h1-accepted-implementation) within recorded scope                                                                      |
| R5-F2   | H1    | Accepted              | [H1 parent acceptance](#h1-accepted-implementation) within recorded scope                                                                      |
| R5-F3   | H1    | Accepted              | [H1 parent acceptance](#h1-accepted-implementation) within recorded scope                                                                      |
| R5-F4   | H1    | Accepted              | [H1 parent acceptance](#h1-accepted-implementation) within recorded scope                                                                      |
| R5-F5   | H1    | Accepted              | [H1 parent acceptance](#h1-accepted-implementation) within recorded scope                                                                      |
| R5-F6   | H1    | Accepted              | [H1 parent acceptance](#h1-accepted-implementation) within recorded scope                                                                      |
| R5-F9   | H1    | Accepted              | [H1 parent acceptance](#h1-accepted-implementation) within recorded scope                                                                      |
| R3-F1   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F2   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F3   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F4   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F5   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F6   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F7   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F8   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F9   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F10  | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F11  | H2    | Clarified             | [H2 parent clarification](#h2-accepted-implementation) preserves independent races/coordinates                                                 |
| R3-F12  | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F13  | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F14  | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F15  | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-F16  | H2    | Clarified             | [H2 parent clarification](#h2-accepted-implementation) preserves independent races/coordinates                                                 |
| R3-H1   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-H2   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-H3   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-H4   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-U1   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-U2   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-U3   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-U4   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-U5   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-U6   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-U7   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-U8   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R3-U9   | H2    | Accepted              | [H2 parent acceptance](#h2-accepted-implementation) within recorded scope                                                                      |
| R1-F1   | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F2   | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F3   | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F4   | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F5   | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F6   | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F7   | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F8   | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F9   | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F10  | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F11  | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F12  | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R1-F13  | H3    | Accepted              | [H3 parent acceptance](#h3-accepted-implementation) within recorded scope                                                                      |
| R2-F1   | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R2-F2   | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R2-F3   | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R2-F4   | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R2-F5   | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R2-F7   | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R2-F8   | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R2-F9   | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R2-F10  | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R5-F7   | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R5-F8   | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R5-F10  | H4    | Accepted              | [H4 parent acceptance](#h4-catalog-compatibility-and-convergence) within recorded scope                                                        |
| R4-F1   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-F2   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-F3   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-F4   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-F5   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-F6   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-F8   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-F9   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-F10  | H5    | Partial               | [H5 desktop scope accepted](#h5-installed-editor-outcomes-and-measurement-policy). Native Trust follow-up is UNEXECUTED and parent-unaccepted. |
| R4-F11  | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-U1   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-U2   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-U3   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-U4   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R4-U5   | H5    | Accepted              | [H5 parent acceptance](#h5-installed-editor-outcomes-and-measurement-policy) within recorded scope                                             |
| R2-F6   | H6    | Ready, pending parent | H6 finding/criterion mapping above. No self-acceptance.                                                                                        |
| R2-F11  | H6    | Ready, pending parent | H6 finding/criterion mapping above. No self-acceptance.                                                                                        |
| R4-F14  | H6    | Ready, pending parent | H6 finding/criterion mapping above. No self-acceptance.                                                                                        |
| R4-F15  | H6    | Ready, pending parent | H6 finding/criterion mapping above. No self-acceptance.                                                                                        |
| R5-F11  | H6    | Ready, pending parent | H6 finding/criterion mapping above. No self-acceptance.                                                                                        |
| R5-F12  | H6    | Ready, pending parent | H6 finding/criterion mapping above. No self-acceptance.                                                                                        |
| R5-F13  | H6    | Ready, pending parent | H6 finding/criterion mapping above. No self-acceptance.                                                                                        |
| R4-F7   | H7    | Deferred, Open        | H7 not admitted. Abrupt remote transport loss remains open.                                                                                    |
| R4-F12  | H7    | Deferred, Open        | H7 not admitted. Late restricted/virtual activation controls remain open.                                                                      |

Additional N1 remains OPEN beyond these 86 findings. Both pinned CEL implementations retain the last duplicate map key despite the language-defined error.
N1 is not fixed, waived, or added to supported conformance vectors. It does not expand H7.
All final client, native Trust reliability, JetBrains, remote-loss, and endurance work retains the existing H7 boundary.

### Qualification and review handoff

The first targeted attempt passed 82 of 83 controls. It failed a mistyped focused case ID in the new inventory expectation.
The corrected repeat passed all 83. Both earlier attempts remain retained.
Final committed source/client, exact-stamped package, and packaged suite results follow after execution.
No H6 parent decision, hosted workflow dispatch, push, PR, merge, or publication occurs in this handoff.

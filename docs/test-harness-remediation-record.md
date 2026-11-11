# Test harness remediation implementation record

Status: H1 is accepted. H2 is ready for parent review. H3 through H6 wait for their preceding acceptance gates.
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

| Package | Agent state      | Parent decision | Required next evidence                                   |
| ------- | ---------------- | --------------- | -------------------------------------------------------- |
| H1      | Complete         | Accepted        | Scoped evidence and limitations recorded below           |
| H2      | Ready for review | Pending         | Independent parent inspection and repeated H2 controls   |
| H3      | Not assigned     | Pending         | Accepted H2 and independent core/CLI controls            |
| H4      | Not assigned     | Pending         | Accepted H3 and focused backend evidence                 |
| H5      | Not assigned     | Pending         | Accepted H4 and installed editor evidence                |
| H6      | Not assigned     | Pending         | Accepted H5 and complete scope/inventory reconciliation  |
| H7      | Deferred         | Not admitted    | Separate authorization and final-candidate qualification |

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

## H2 implementation for parent review

Assigned agent: `harness_h2_lsp_behavior`. Handoff date: 2026-11-11.
The user approved H1 through H6 on 2026-11-10 with sequential parent gates. H7 remains deferred.
H2 starts from H1 acceptance commit `be94423ebd96a50f0ac32143f4760968e3240f2b` on `feature/test-harness-remediation`.
The exact tested source and tests are `103c754d0464ee724a6565795482b1085fc01a2a`.
Production code last changed in `043a6a5`. Later implementation commits change tests and documentation only.
This final record update is documentation only. H1 acceptance and the frozen register remain unchanged.
Parent acceptance of H2 remains pending. The agent does not close findings or admit H3.

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

These are agent results for parent review. Every criterion remains pending parent acceptance.

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
The quoted selector or file identifies its focused control. All implementation dispositions remain `Partial` until parent review.
R3-F11 and R3-F16 propose clarification after parent inspection.

| Finding | Criterion    | Selector and observed outcome                                                                                                                                                                                                    | Implementation state | Parent decision                        |
| ------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------- |
| R3-F1   | H2-A1        | `UTF-16 incremental edits preserve same-line emoji offsets and reject stale document versions`: retained coverage identity before description-only edit. Removed guard and separate equal/older variants fail.                   | Partial              | Pending                                |
| R3-F2   | H2-A2        | `rapid editor changes cancel old HTTP and never publish superseded diagnostics` and `lsp-owners.test.ts`: every captured publication satisfies the allowed version/lifetime history.                                             | Partial              | Pending                                |
| R3-F3   | H2-A3        | `child stdio publishes a nonempty finding before an ordered close clear`: nonempty syntax finding precedes the same URI/version clear.                                                                                           | Partial              | Pending                                |
| R3-F4   | H2-A3        | `child cancellation responses retain the declared completion, hover and definition shapes`: real paired wire frames produce exact empty shapes. Entered-provider and completed-local cancellation controls remain distinct.      | Partial              | Pending                                |
| R3-F5   | H2-A5        | `included YAML completion edits the open payload scalar and watch refreshes invalidate candidates`: actual unlink, exact deleted source digest, absent old candidate, and live hover.                                            | Partial              | Pending                                |
| R3-F6   | H2-A4        | `empty YAML values, quotes, JSON and CRLF preserve punctuation/comments and UTF-16 offsets`: complete resulting strings and parsed owner values match independent expectations.                                                  | Partial              | Pending                                |
| R3-F7   | H2-A4        | `JSON field completion produces valid JSON including insertion between existing members`: inserted lifecycle, preserved neighbors, complete expected text, and valid revalidation after value entry.                             | Partial              | Pending                                |
| R3-F8   | H2-A4        | `scalar-fixes.test.ts` and included guarded round trip: independent edit application preserves complete source and validates the intended rule.                                                                                  | Partial              | Pending                                |
| R3-F9   | H2-A6        | Scalar 4,096/4,097 bytes, 64/65 generated repairs, complete 8 MiB/next-byte frames, 8 KiB/next-byte headers, 16/17 edits, 16 KiB/next-byte replacements and credentials. Independent constants are explicit.                     | Partial              | Pending                                |
| R3-F10  | H2-A3        | `stdio completion and hover work on unfinished YAML while authoritative validation reports syntax`: exact `yaml/syntax`, `Invalid YAML syntax.`, plaintext hover, and expected component-type description.                       | Partial              | Pending                                |
| R3-F11  | H2-A7        | `the client version check rejects an edit if typing races its delivery` stays distinct from `stdio stale, forged and reopened fix requests never reach workspace/applyEdit`. The explanatory comment preserves both orderings.   | Partial              | Pending clarification                  |
| R3-F12  | H2-A8        | `an entered local-index gate produces an exact incomplete reply before the ready candidate`: actual preparation promise enters before empty/incomplete response, then release admits the literal team candidate.                 | Partial              | Pending                                |
| R3-F13  | H2-A2        | `lsp-coordinator.test.ts` and `lsp-session-resources.test.ts`: entered/retiring/activated/disposed/failure signals replace the cited fixed turn counts.                                                                          | Partial              | Pending                                |
| R3-F14  | H2-A6        | `token storage uses bounded FIFO eviction`: 129 issued tokens evict the oldest while the next-oldest remains usable at capacity 128.                                                                                             | Partial              | Pending                                |
| R3-F15  | H2-A3        | `each missing required client capability independently denies fix dispatch`: separate apply-edit, document-change, literal-action, and diagnostic-data omissions yield no dispatch.                                              | Partial              | Pending                                |
| R3-F16  | H2-A7        | Fixed independent coordinate vectors remain. Incidental fixture cursors can derive offsets without replacing those expected vectors.                                                                                             | Partial              | Pending clarification                  |
| R3-H1   | H2-A3        | `rejected watcher registration reports its reason and save still refreshes the live child`: initial rejection, changed saved-file outcome, restoration, then accepted registration after trusted reload.                         | Partial              | Pending                                |
| R3-H2   | H2-A3        | The same registration test inspects the exact client log warning. The lifecycle matrix retains the stopped log count after ordered request responses.                                                                            | Partial              | Pending                                |
| R3-H3   | H2-A3        | `child encoding offers select UTF-16 or reject unsupported-only offers`: absent, UTF-16, mixed UTF-8/16, mixed UTF-32/16, UTF-8-only, and unsupported offers retain the declared contract.                                       | Partial              | Pending                                |
| R3-H4   | H2-A3        | `client roots cannot widen the trusted filesystem source selection`: no client root, foreign root, and mixed folders keep approved diagnostics and reject the actual outside file.                                               | Partial              | Pending                                |
| R3-U1   | H2-A1, H2-A3 | `duplicate child didOpen cannot replace the first document lifetime or bytes`: different version/text cannot replace the original observed coverage binding.                                                                     | Partial              | Pending                                |
| R3-U2   | H2-A6        | `lsp-boundaries.test.ts`: 1,000 authoritative documents versus document 1,001, incomplete latch and fresh-server recovery. Exactly 1,000 changes admit validation, while 1,001 require full synchronization.                     | Partial              | Pending                                |
| R3-U3   | H2-A6        | Controlled 50/500 ms selectors, one/two-character remote prefix, 32/33 cache scopes, and 262,144/262,145 cache bytes. Next-oldest scopes survive eviction.                                                                       | Partial              | Pending                                |
| R3-U4   | H2-A6        | `fix registry caps actions at 32 and retains precisely the first 64 eligible candidates`: both action edges and candidates 1, 32, 33, 64, and 65 have independent admission outcomes.                                            | Partial              | Pending                                |
| R3-U5   | H2-A3        | `child stdio rejects lifecycle requests before initialize and after shutdown` and `a rejected pre-initialize shutdown cannot authorize a successful EOF or exit`: exact errors and actual exit 1.                                | Partial              | Pending                                |
| R3-U6   | H2-A4        | `hover and definition resolve an unqualified reference to its unique local entity`: unique target remains positive, competing matching definitions return no target.                                                             | Partial              | Pending                                |
| R3-U7   | H2-A6        | Three actual filesystem discovery selectors admit 10,000 entries, depth 32, and 1,000 files. Each next value rejects with exact `Discovery exceeds limits.` and recovers after removal.                                          | Partial              | Pending                                |
| R3-U8   | H2-A6        | `catalog credential files rotate between authenticated requests without replacing the provider`: authenticated byte boundary, real atomic replacement, actual symlink rejection, recovery, and isolated missing-flag simulation. | Partial              | Pending within executed platform scope |
| R3-U9   | H2-A4        | `schema enum repair applies the selected guarded edit and revalidates only its intended rule`: selected internal value reaches the actual edit, target rule passes, unrelated rule remains failed.                               | Partial              | Pending                                |

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
Parent inspection, independent controls, formal decisions, and next-package admission remain pending.

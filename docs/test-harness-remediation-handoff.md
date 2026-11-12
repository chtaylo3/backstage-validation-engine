# Test harness remediation agent handoff

Status: H1 through H6 are implemented and parent-accepted within their recorded scope. H7 remains deferred.
The later authorized [temporary CEL fix](cel-duplicate-key-workaround.md) records N1 follow-up. Historical handoffs below retain their original scope and disposition.
The user approved proceeding on 2026-11-10 under the [remediation plan](test-harness-remediation-plan.md).
The [finding register](test-harness-remediation-findings.md) defines the amended acceptance work.
The [implementation record](test-harness-remediation-record.md) records execution and parent decisions.

## Parent preparation

1. Retain the user's approval and its package scope in the implementation record.
2. Use merged baseline `38085eed9e2a77ebe50b414a23aaf21c6004c199` from PR #3 on `master`.
3. Work on `feature/test-harness-remediation` and preserve the completed feature branch.
4. Reuse the merged reload and installed-harness corrections documented in the plan.
5. Preserve the original untracked review, existing assessment files, and ignored evidence.
6. Assign H1 first, unless the user explicitly changes the delivery order.
7. Assign only one implementation package at a time. Require parent acceptance before assigning the next package.

Do not reset a checkout with user changes. Use an isolated worktree when ownership is uncertain.
Do not add all untracked files to a commit. Review and stage only the package's intended paths.
Do not push, open additional PRs, publish, or merge unless the user authorizes that action.
The earlier push and PR request applied to the existing feature branch.

## Delegation template

Replace the package and baseline placeholders before delegation.
Assign only the package admitted by the parent. H1 is admitted first.

```text
Implement package <Hn> of docs/test-harness-remediation-plan.md.
The user approved <scope> on <date>. Start from <exact revision> on <remediation branch>.
Read docs/test-harness-remediation-findings.md and the Hn section of the plan.
Implement only Hn's assigned findings and necessary shared support.
Preserve all amended caveats and existing contracts. Do not start H7.
Use independent expected outcomes, positive controls, and targeted negative controls.
Exercise the real application boundary named by each requirement.
Do not close a finding through an assertion about a helper that bypasses that boundary.
Do not loosen limits, thresholds, or assertions to obtain passing results.
Record actual commands, selectors, counts, revision, artifact identity, and limitations.
Update the Hn section of docs/test-harness-remediation-record.md.
Preserve user-owned files and use portable repository-relative documentation.
Return the changed paths, acceptance mapping, test evidence, and unresolved issues.
Do not push, publish, merge, or begin another package.
Wait for parent review after the handoff.
```

## Independent control recipes

The assessment ran four isolated demonstrations. Their intent is reproduced here without depending on ignored local artifacts.
They identify weak tests or verifiers. They do not establish that released artifacts contain forbidden data.

### Stale document versions

The selected test was `UTF-16 incremental edits preserve same-line emoji offsets and reject stale document versions`.
It passed with the stale/equal-version guard removed from an isolated compiled copy.
A later full-document overwrite masked the incorrectly accepted changes.
H2 must observe the disputed source before any overwrite and make that faulty variant fail.
Keep the real source guard intact except in the isolated negative control.

### VSIX content inspection

The inspector accepted an otherwise valid synthetic archive with each of these forbidden paths:

```text
extension/server/nested/catalog.sqlite
extension/server/node_modules/@backstage/test/index.js
extension/server/seed.json
extension/server/yarn.lock
extension/server/apps/backend/index.js
```

H1 must reject those fixtures while admitting the normal candidate and its required production dependencies.
Use a reviewed positive payload/dependency policy. Do not ban all `@backstage` packages.
Include path normalization and nested content controls.

### Independent metric verdict

The metric verifier accepted a valid long report after latency values changed to 1,000,000 ms and final RSS to 10,000 MiB.
The resource-growth verifier rejected the same sample sequence.
H1 must make the release verdict reject the invalid measurements directly.
H5 must define the documented budget policy and repeat the control against that policy.
Do not claim that the entire release workflow accepted this synthetic report.

### Catalog convergence

The convergence helper accepted a mutation seed with obsolete `ownedBy` and `providesApi` edges still present.
The response otherwise contained the authored fields and all required relations.
H4 must declare absent edges in the seed schema and reject a response that retains them.
Retain the existing System-to-Domain relation expectation. Add the other declared directions independently.

## Parent acceptance procedure

1. Inspect the actual path from each new control to the production boundary.
2. Inspect expected values for shared assumptions with the implementation.
3. Repeat representative positive and negative controls, including the package's repaired false-success path.
4. Inspect complete publication histories and ordered barriers where absence or races matter.
5. Match test inventories and artifacts to the exact tested revision.
6. Retain failed attempts and state the reason for any unchanged rerun.
7. Accept or reject each criterion explicitly in the implementation record.
8. Admit the next approved package only after all required current-package criteria pass.

If required evidence cannot run, report the limitation and keep the affected criterion open.
The parent must not substitute old passing qualification for the changed candidate.
The parent must not turn a documented profile difference into an unapproved product change.

## Handoff completion requirements

The agent returns a concise account of changed behavior, why it changed, and how it was tested.
The account links the package record and identifies all unresolved requirements.
Every closed finding must have a criterion, an independent expected result, a negative control where applicable, and executed evidence.
Clarifications require a reviewed disposition rather than invented implementation work.
H7 remains deferred until separately authorized by the user.

## H5 handoff for parent review

Qualified source/test revision: `5ca82fbf4457553ab4c8e0b7b2bb915485e9083a`.
The [H5 record](test-harness-remediation-record.md#h5-installed-editor-outcomes-and-measurement-policy) maps all 15 findings and eight criteria.
Evidence manifest: `.artifacts/harness-remediation/H5/qualification/manifest.json`.
The final VSIX SHA-256 is `5d06602358da7d507cbae6df26606f6090fd14c49d0efbcfb3c90f3d2c912945`.
The primary standard VS Code artifacts remain development inputs. The manifest identifies the retained exact candidate and clean checkout.

The parent accepts the executed H5 desktop scope and admits H6. The H5 record contains the independent decision and limits.
R4-F10 is Partial for strengthened but UNEXECUTED, parent-unaccepted native Trust assertions under the existing H7 deferral.
Additional N1 remains OPEN beyond the original 86 findings. H6 must preserve both dispositions.
H7 remains deferred and is not expanded. No push, PR, publication, or merge occurs through this handoff.

## H6 handoff for parent review

The parent accepts all seven H6 evidence and documentation findings within the recorded scope.
The [H6 record](test-harness-remediation-record.md#h6-evidence-inventories-and-documentation) maps all seven findings and all six criteria.
It reconciles the original 86 findings with parent decisions and explicit unresolved dispositions.
Independent inventory expectations detect an isolated loader omission. Synthetic verifier controls do not count as release execution.
Actual fixture evidence records authority inputs, effective expiry, phase/session attribution, and sanitized output.
Screenshots are OPTIONAL DIAGNOSTICS. Required Trust state and UI assertions remain independent.

The 58-module inventory contains 50 portable cases. H5 executes 30 selected cases per editor on Linux x64.
Its 60 unique passing combinations span 62 attempts. Two original X display failures remain failed.
H4's actual-backend evidence retains its older source and CLI identity. Final H6 source/package gates do not extend that qualification.
R4-F10 remains Partial solely for strengthened but UNEXECUTED and parent-unaccepted native Workspace Trust follow-up.
R4-F7 and R4-F12 remain deferred. N1 remains OPEN beyond the original 86 findings.
No H7 work or native Trust execution is admitted by this handoff.

The qualified H6 source/test revision is `34680c887e13abe8c45453e6753f2c5212040225`.
The clean serial gates pass 1,377 source, 45 client, and 1,377 packaged tests with zero failures, cancellations, or skips.
The exact Linux x64 VSIX SHA-256 is `78c9d84d3eeb04d643cb10b83519c3b439665908e53c9967b79e295f7f3155cb`.
It contains 5,079 entries and 52,088,726 bytes. Node 24.22.1 and existing coverage thresholds remain unchanged.
Evidence manifest: `.artifacts/harness-remediation/H6/qualification/manifest.json`.
Agent faults: `mutations/summary.json`. Independent parent outcomes: `parent/isolated-controls/report.json` and the separate selector/verdict/artifact reviews.
The [H6 record](test-harness-remediation-record.md#final-committed-qualification) supplies commands, counts, failed development attempts, per-finding mappings, and limits.
The parent accepts H6. H1 through H6 are complete within their recorded scope. Stop here before H7.

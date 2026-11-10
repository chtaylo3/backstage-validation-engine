# LSP editor improvements implementation record

This record follows the [five-phase implementation plan](lsp-editor-improvements-plan.md).
The branch is `feature/lsp-capabilities-refresh`. Its merged baseline is `d2e54748dbd34e9f1e881c2abf77689cf197b40f`.
Plan commit `4b34f78` defines the authorized scope and acceptance criteria.

## Phase state

| Phase                                           | State                              | Parent acceptance             |
| ----------------------------------------------- | ---------------------------------- | ----------------------------- |
| 1: documentation                                | Implemented, pending parent review | Pending                       |
| 2: contracts and built-in adapters              | Not implemented                    | Requires accepted phase 1     |
| 3: live catalog refresh                         | Not implemented                    | Requires accepted phase 2     |
| 4: CEL and RE2 contributions                    | Not implemented                    | Requires accepted phase 3     |
| 5: client reliability and release qualification | Deferred by the user               | Requires future authorization |

SQS, Kafka, durable hosted governance, and authoritative GitHub publication remain outside these editor phases.
Arbitrary executable plugin loading also remains outside phases 1 through 4.
Each phase requires parent review before the next implementation starts.

## Phase 1: documentation and completed qualification

Implementation date: 2026-11-09, America/New_York time.
This phase changes documentation only. It preserves historical checkpoints and separates current results from remaining qualification.
The phase implementation commit will be recorded in the parent acceptance entry after local commit and review.

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

Pending. The parent must accept this documentation commit before phase 2 implementation starts.
Phases 2 through 4 remain unimplemented. Phase 5 remains deferred.

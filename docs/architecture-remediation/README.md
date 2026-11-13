# Architecture remediation plan

This directory holds the implementation plans that follow the architecture evaluation of
2026-11-12. Each phase is one independently reviewable change. Phases run in order, because later
phases use paths and guards that earlier phases create.

| Phase | Plan                                                        | Outcome                                                 |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------- |
| 1     | [Engine layering](phase-1-engine-layering.md)               | Ordered, enforced layers inside the engine; no cycles   |
| 2     | [Explicit pipeline stages](phase-2-pipeline-stages.md)      | Stage modules behind one report contract                |
| 3     | [LSP composition root](phase-3-lsp-composition.md)          | Handler modules and a split editor service              |
| 4     | [Shared protocol module](phase-4-shared-protocol.md)        | One definition of the custom client/server methods      |
| 5     | [Clock and runtime injection](phase-5-clock-and-runtime.md) | No ambient time or CEL singleton inside the engine      |
| 6     | [Test and tooling discipline](phase-6-test-and-tooling.md)  | Grouped tests, no hand-kept file lists, checked scripts |
| 7     | [Housekeeping](phase-7-housekeeping.md)                     | Explicit public exports, shared helpers, reference docs |

## Baseline

Recorded on 2026-11-12 at commit `ba95e2d` on Linux (WSL2), Node 24:

- `npm test`: 1385 tests, 1385 passed, 0 skipped, about 123 seconds, 80 test files.
- `node scripts/test-client.mjs`: 45 tests passed; client coverage 99.79% lines, 95.87% branches.
- `npm run check` fails only at `format:check`, because the untracked `out/` directory holds
  unformatted files that do not belong to this work. Every other step passes.

## Rules for every phase

These rules apply to every implementer and take precedence over the phase plan where they conflict.

1. **Version control.** Do not commit, stash, reset, restore, clean, or push. Leave every change in
   the working tree. Use `git mv` for moves so that history follows the file. Do not switch
   branches.
2. **Protected paths.** Do not modify `out/`, `plan/`, `test/fixtures/conformance/`,
   `test/fixtures/cel-qualification.json`, `test/fixtures/backstage/**/openapi.yaml`, or
   `package-lock.json`. Do not add, remove, or upgrade dependencies.
3. **Behavior.** These are structural changes. Findings, coverage rows and their order, rule
   states, exit codes, SARIF output, LSP wire messages, and generated schemas must not change
   unless the phase plan names the change.
4. **Existing tests.** Do not delete, skip, weaken, or rewrite the assertions of an existing test
   to make it pass. Permitted edits are import paths, file moves that a plan requires, and
   signature updates that a plan requires. If an existing test appears wrong, stop and report it.
5. **Public API.** The names exported by the package entry points (`.`, `./contracts`, `./lsp`,
   `./capabilities`), the `bin` paths (`dist/cli/main.js`, `dist/lsp/stdio.js`), and
   `schemas/*.schema.json` stay stable. Additions are allowed only where a plan says so.
6. **Scope.** Do not fix unrelated problems. Record them in the final report instead.
7. **Heavy suites.** Do not run the VS Code Electron suites (`test:extension*`), the SSH/remote
   suites, or the Backstage container suites (`backstage:test:*`, `test:backstage:*`). They need
   downloads or containers. Say in the report which of them your change could affect.

## Verification gate

Run this after the work and paste the tail of the output into the report. It equals
`npm run check` with the unrelated `out/` directory excluded from the format check:

```sh
npm run architecture:check \
  && npm run typecheck \
  && npm run lint \
  && npx prettier --check . '!out/**' \
  && npm run schemas:check \
  && npm test \
  && node scripts/test-client.mjs
```

The gate passes only when every step exits with zero, the test count is at least the count before
the phase plus the new tests, and no test is skipped.

## Final report

End each phase with a report that contains:

1. A summary of what changed, by directory.
2. Each success criterion from the phase plan, marked met or not met, with the evidence.
3. Every deviation from the plan and the reason.
4. The gate output tail, including test counts.
5. Problems found but not fixed.

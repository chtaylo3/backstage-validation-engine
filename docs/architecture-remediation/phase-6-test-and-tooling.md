# Phase 6: Test and tooling discipline

Read [the shared rules](README.md) first.

## Goal

Organize the tests by layer, select test groups by directory instead of by hand-kept file lists,
run the tests that are safe to run concurrently in parallel, and put the main scripts under type
checking.

## Current state

- About 80 `*.test.ts` files sit flat in `test/` (more after Phases 1–5).
- `package.json` defines `test:harness` and `test:lsp` as literal lists of about 27 compiled test
  paths each. The lists duplicate each other and go stale without notice.
- `scripts/test.mjs` reads `.test-dist/test` non-recursively and runs everything with
  `--test-concurrency=1`. A full run takes about 123 seconds.
- Other consumers of the flat layout: `scripts/test-client.mjs`
  (`.test-dist/test/extension-client.test.js`), `.github/workflows/ci.yml` (a PowerShell list near
  line 228), and several scripts that import `.test-dist/test/harness/*.js`.
- 38 scripts hold about 7,350 lines of unchecked `.mjs`. `scripts/test-extension.mjs` (1,053
  lines) is among the most frequently changed files in the repository.

## Target design

### Test layout

| Directory           | Contents                                                                           |
| ------------------- | ---------------------------------------------------------------------------------- |
| `test/engine/`      | `base`, `contracts`, `core`, `runtime`, `parsing`, `compatibility`, `policy`,      |
|                     | `providers`, `capabilities`, `pipeline`, `reporting`, `host`, and `protocol` tests |
| `test/lsp/`         | Language server and editor service tests                                           |
| `test/cli/`         | CLI and CLI candidate tests                                                        |
| `test/extension/`   | VS Code client tests and extension tooling tests                                   |
| `test/tooling/`     | Import policy, public API, harness evidence, fixture refresh, and script tests     |
| `test/harness/`     | Unchanged location                                                                 |
| `test/fixtures/`    | Unchanged location                                                                 |
| `test/integration/` | Unchanged location                                                                 |

Every `*.test.ts` file lives in exactly one of the five group directories. Use `git mv`. Fix
relative imports and every path that a test resolves from its own location. Paths resolved from the
working directory (`path.resolve('test/fixtures/…')`) keep working and stay as they are.

### Test selection

Move the selection logic out of `scripts/test.mjs` into `scripts/test-selection.mjs` as pure
functions, and make `scripts/test.mjs` accept:

- `--group <name>` (repeatable): run only the named group directories.
- No `--group`: run every group.
- An unknown group, or a group with no test files, is an error.

Discovery is recursive under `.test-dist/test/<group>/`.

Replace the literal lists in `package.json`:

- `test:lsp` runs the groups that contain every file in today's `test:lsp` list.
- `test:harness` runs the groups that contain every file in today's `test:harness` list.

The new commands may run more files than before. They must not run fewer. Record the before and
after file sets in the report.

Update the other consumers: `scripts/test-client.mjs`, the CI workflow list, and reference
documents (`docs/testing-harness.md`, `docs/github-actions.md`, `CONTRIBUTING.md`, `README.md`).
Dated records stay untouched.

The reports that `scripts/test.mjs` writes (`junit.xml`, `summary.jsonl`, `inventory.json`) keep
their locations and their shape. `inventory.json` lists the new file paths.

### Concurrency

- `scripts/test.mjs` runs parallel-safe groups with `--test-concurrency` set to the smaller of 4
  and the available parallelism, and the remaining groups with `--test-concurrency=1`, as two
  `node --test` invocations whose reports are merged into the same output files.
- `test/engine/` is the candidate parallel group. Prove it: run the engine group in parallel five
  times in a row. Any file that fails in any run goes into an explicit serial list in
  `scripts/test-selection.mjs` with a one-line reason, and the proof restarts.
- `BVE_TEST_CONCURRENCY=1` forces serial execution everywhere. Document it.
- The skipped-test rule for CI and the coverage and packaged modes keep working. If merged
  coverage across two invocations is not reliable, keep `--coverage` runs serial in one invocation
  and say so.

### Checked scripts

- Add `tsconfig.scripts.json`: `allowJs`, `checkJs`, `noEmit`, `strict`, including an explicit
  list of scripts. Add it to `npm run typecheck`.
- Bring at least these under checking: `scripts/test.mjs`, `scripts/test-selection.mjs`,
  `scripts/architecture-boundaries.mjs`, `scripts/clean.mjs`, `scripts/schemas.mjs`,
  `scripts/test-client.mjs`, `scripts/ci-test-reporter.mjs`, `scripts/candidate-runs.mjs`, and
  `scripts/qualification-inventory.mjs`.
- Then bring the large suites under checking with JSDoc annotations only:
  `scripts/test-extension.mjs`, `scripts/backstage-test-env.mjs`,
  `scripts/test-extension-remote.mjs`, and `scripts/extension-test-ui.mjs`. These cannot be executed
  in this environment, so their runtime behavior must not change. Permitted edits are JSDoc
  comments, `@type` casts in comments, and null guards that cannot change a passing run. If a
  script needs more than that, leave it out of the include list and name it in the report.
- Scripts that are not yet checked are listed in one comment block in `tsconfig.scripts.json`, so
  the remaining work is visible.

## Work order

1. Record the baseline: the file sets of `npm test`, `test:lsp`, and `test:harness`, the test
   count, and the wall time.
2. Extract the selection logic with tests, still on the flat layout.
3. Move the test files and fix paths. Run `npm test` and compare the test count.
4. Replace the `package.json` lists and update the other consumers.
5. Add concurrency and run the proof.
6. Add script type checking.
7. Run the verification gate three times in a row.

## Success criteria

1. No `*.test.ts` file remains directly under `test/`. Each is in exactly one group directory.
2. `package.json`, `scripts/`, and `.github/workflows/` contain no literal list of two or more
   compiled test file paths. Single-file references that are intentional
   (`scripts/test-client.mjs`) remain and point at the new path.
3. `npm test` runs at least as many tests as before this phase, with zero skipped.
4. The new `test:lsp` and `test:harness` file sets are supersets of the old ones.
5. `npm test` wall time is reported before and after. The target is at least 25% lower. If the
   parallel proof forces most engine files into the serial list, report the measured result and
   the reasons instead of forcing the target.
6. Three consecutive `npm test` runs pass.
7. `npm run typecheck` checks `tsconfig.scripts.json` and passes. The four large scripts show only
   comment and guard changes in `git diff`.
8. `inventory.json`, `junit.xml`, and `summary.jsonl` are still written to the same locations with
   the same top-level shape.
9. The verification gate passes.

## Test cases

### New: `test/tooling/test-selection.test.ts`

Uses temporary directories.

1. Recursive discovery finds nested `*.test.js` files and ignores other files.
2. Results are sorted and stable across runs.
3. `--group lsp` returns only that directory's files; two groups return the union.
4. An unknown group throws with the list of valid groups.
5. An empty group and an empty tree each throw.
6. The serial list removes the named files from the parallel set and adds them to the serial set;
   an entry that names a missing file throws, so the list cannot go stale.
7. `BVE_TEST_CONCURRENCY=1` yields one serial set.
8. Paths with Windows separators normalize to the same groups.

### New: `test/tooling/test-layout.test.ts`

1. No `*.test.ts` exists directly under `test/`.
2. Every `*.test.ts` is under exactly one of the five group directories.
3. No script in `package.json` matches the pattern of two or more `.test.js` paths.
4. Every group directory that `package.json` scripts name exists.

### New: `test/tooling/test-reports.test.ts`

Runs `scripts/test.mjs` against a small temporary fixture tree in a child process.

1. A parallel group and a serial group produce one merged `summary.jsonl` total and one
   `inventory.json` that lists both sets.
2. A failing test in either invocation makes the exit code non-zero.
3. With `CI=1`, a skipped test makes the exit code non-zero.

If `scripts/test.mjs` cannot be pointed at a fixture tree without a small parameter, add one.

### Existing suites that must stay green

All. Pay attention to tests that locate files relative to themselves: `cel-runtime.test.ts`
(worker fixtures), the editor tests that load `./harness/*.js`,
`harness-evidence-boundaries.test.ts`, `architecture-boundaries.test.ts`, and any test that reads
`inventory.json`.

## Risks

- **Other platforms.** Concurrency is proven here only on Linux. CI also runs Windows and macOS.
  State this in the report and keep the serial override.
- **Hidden path coupling.** Scripts and workflows refer to compiled test paths. Search for
  `.test-dist/test` and `.test.js` across the repository, including `.github/` and `docs/`.
- **Timing-sensitive tests.** Tests with 100 ms deadlines can fail under CPU contention. They
  belong in the serial list.

## Out of scope

Rewriting tests to import only public entry points, splitting the large scripts, and changing what
any test asserts.

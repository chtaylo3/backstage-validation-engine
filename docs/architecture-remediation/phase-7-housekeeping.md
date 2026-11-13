# Phase 7: Housekeeping

Read [the shared rules](README.md) first.

## Goal

Make the public export surface explicit, remove duplicated helpers where the copies are truly the
same, and separate reference documentation from historical records.

## Current state

- `src/index.ts` uses `export *` for `contracts`, `parsing`, `compatibility`, and `providers`.
  `src/contracts/index.ts` and `src/capabilities/index.ts` use `export * from './schemas.js'`. Any
  new export in those files becomes public API without a decision.
- Small helpers are repeated:
  - `bounded(promise, ms)` in `src/capabilities/session.ts` and `src/lsp/session-resources.ts`.
  - TypeBox builders (`text`, `digest`, `count`, `strings`) in `src/contracts/schemas.ts`,
    `src/capabilities/schemas.ts`, `src/capabilities/editor-artifacts.ts`, `src/lsp/config.ts`,
    and `src/host/catalog-config.ts`.
  - A `record` type guard in `src/compatibility/native-errors.ts` and
    `src/compatibility/custom-schemas.ts`.
- `docs/` holds 33 files that mix reference documents with plans, records, and handoffs.
  `SESSION_HANDOFF.md` and `local_setup.md` sit in the repository root.

## Target design

### Explicit exports

- Replace every `export *` in `src/` with explicit named exports. Group the names in
  `src/index.ts` by layer with one comment per group.
- The public API snapshot must be identical before and after. This phase changes how names are
  exported, not which names.
- Add a lint rule that bans `export *` (`ExportAllDeclaration`) in `src/**/*.ts`.

### Helper consolidation

Consolidate only when the copies behave identically for every input. Compare them first and write
the comparison in the report.

| Helper              | Target                           | Condition                                      |
| ------------------- | -------------------------------- | ---------------------------------------------- |
| `bounded`           | `src/base/async.ts`              | Same timeout, rejection, and timer cleanup     |
| `record` type guard | `src/base/json.ts` as `isRecord` | Same treatment of arrays and `null`            |
| TypeBox builders    | `src/contracts/schema-kit.ts`    | Generated schemas and inferred types unchanged |

- If two copies differ, keep both and rename them so the names state the difference.
- The TypeBox builders have different defaults (for example a 4,096-character maximum in some
  files and none in others). Consolidate through parameters, never by changing a default. The
  generated files in `schemas/` must stay byte-identical, and the capability and configuration
  schemas must accept and reject the same inputs.
- `readJson` in `src/cli/main.ts` and `src/providers/transport.ts` read from different sources.
  Leave them and add a one-line comment to each that names the other.

### Documentation

- Create `docs/history/` and move completed plans and records there with `git mv`:
  `lsp-separation-implementation-plan.md`, `lsp-separation-implementation-record.md`,
  `lsp-editor-improvements-plan.md`, `lsp-editor-improvements-implementation-record.md`,
  `wsl-development-transition-plan.md`, and the root `SESSION_HANDOFF.md`.
- Move the root `local_setup.md` to `docs/local-setup.md`.
- **Do not move** the `docs/test-harness-remediation-*.md` files or
  `docs/implementation-status.md`. The harness remediation is active work on the current branch,
  and scripts or tests may read those paths. Do not move `docs/architecture-remediation/`.
- Before each move, search `src`, `test`, `scripts`, `.github`, and all Markdown files for the old
  path and update every reference. If a test or script reads a document's content or anchors,
  update the path only.
- Add `docs/README.md`: an index with two sections, reference documents and history, one line per
  document.
- Bring `docs/architecture.md` up to date with the final structure: the layer table, the stage
  modules, the protocol module, the clock and runtime rules, and the test groups. Add a short
  "Scalability limits" section that states the current design limits (one process, whole-snapshot
  validation, two CEL workers and 64 outstanding jobs) and that incremental validation is not
  implemented.

## Work order

1. Confirm the public API snapshot passes, then convert the barrels one at a time, running the
   snapshot test after each.
2. Add the `export *` lint rule.
3. Compare and consolidate helpers one family at a time. Run `npm run schemas:check` after the
   TypeBox step.
4. Add the Markdown link test, then move documents and fix references until it passes.
5. Update `docs/architecture.md` and add `docs/README.md`.
6. Run the verification gate.

## Success criteria

1. `grep -rn "export \*" src` returns nothing, and the lint rule enforces it.
2. The public API snapshot is byte-identical to its state at the start of this phase.
3. `schemas/` is byte-identical (`npm run schemas:check`, and `git status` shows no change there).
4. Each helper family in the table is consolidated, or kept separate with distinct names and the
   reason recorded in the report.
5. `docs/history/` holds the six moved files. The repository root no longer holds
   `SESSION_HANDOFF.md` or `local_setup.md`.
6. The Markdown link test passes: no relative link in `README.md`, `CONTRIBUTING.md`, or `docs/`
   points to a missing file.
7. `docs/README.md` lists every Markdown file in `docs/` and `docs/history/` exactly once.
8. `docs/architecture.md` describes the structure that exists, and the layer-order test from
   Phase 1 still passes.
9. The verification gate passes with zero skipped tests.

## Test cases

### Existing: public API snapshot

Must pass unchanged. It is the main control for the barrel conversion.

### New: `test/tooling/markdown-links.test.ts`

1. Every relative link target in `README.md`, `CONTRIBUTING.md`, `docs/*.md`, and
   `docs/history/*.md` resolves to an existing file. External links and pure anchors are ignored.
2. A link with an anchor resolves its file part.
3. `docs/README.md` names every Markdown file under `docs/` (excluding itself) exactly once.
4. The test itself is checked against a temporary fixture with one broken link, which it reports.

### New: helper tests (in the engine group)

1. `bounded`: resolves with the work's value before the limit; rejects at the limit; a rejection
   from the work propagates; the timer is cleared in every case (no open handle keeps the process
   alive); a zero or negative limit behaves as the current copies do.
2. `isRecord`: plain object, object with a null prototype, array, `null`, primitive, and class
   instance, each matching the current copies.
3. Schema kit: for each builder, the produced schema equals the literal schema the old local
   builder produced. Take the expected literals from the code before the change.

### New: schema equivalence check

A test that serializes the TypeBox schemas for the LSP configuration, the host catalog
configuration, the capability schemas, and the editor artifact schema, and compares each with a
golden file generated **before** the consolidation.

### Extended: lint

Add one fixture or inline lint test only if the repository already tests lint rules. Otherwise
confirm by hand that an `export *` in `src/` fails `npm run lint`, and record that in the report.

### Existing suites that must stay green

All. Pay attention to `contracts.test.ts`, `capabilities.test.ts`, `lsp-config-watches.test.ts`,
`native-schema-artifacts.test.ts`, and any test or script that reads files in `docs/`.

## Risks

- **Type-only exports.** With `verbatimModuleSyntax`, type names need `export type`. The snapshot
  test distinguishes values from types and catches a wrong form.
- **Schema drift.** A changed default in a shared builder changes validation. The golden schema
  check and `schemas:check` are the controls.
- **Documents read by tooling.** Search before every move.

## Out of scope

Rewriting document content beyond `docs/architecture.md` and the new index, and moving documents
for active work.

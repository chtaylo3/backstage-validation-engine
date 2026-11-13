# Phase 1: Engine layering

Read [the shared rules](README.md) first.

## Goal

Give the engine an ordered set of layers, make every directory under `src/` one layer, and make the
import policy reject any upward import and any file-level import cycle.

## Current state

`scripts/architecture-boundaries.mjs` treats `contracts`, `capabilities`, `core`, `parsing`,
`policy`, `providers`, `compatibility`, and `runtime` as one `domain` category. Imports among them
are never checked. The directory graph is cyclic:

- `contracts` ↔ `core`, `contracts` → `policy` → `contracts`
- `core` ↔ `compatibility`, `policy` ↔ `compatibility`
- `core` → `providers` → `compatibility` → `core`

`src/core` mixes leaf utilities with top-level orchestration, which causes most of these cycles.
Three file-level cycles exist, including type-only imports:

1. `src/contracts/schemas.ts` ↔ `src/core/json.ts` (`json.ts` imports the `JsonValue` type).
2. `src/compatibility/sources.ts` → `src/core/processing.ts` → `src/core/cel-rules.ts` →
   `src/core/catalog-bindings.ts` → `src/core/reference-data.ts` → `src/compatibility/sources.ts`.
3. `src/lsp/config.ts` ↔ `src/lsp/discovery.ts`.

## Target design

### Layers

Lowest first. A file may import its own layer and any lower layer.

| Order | Layer           | Contents after this phase                                                          |
| ----- | --------------- | ---------------------------------------------------------------------------------- |
| 1     | `base`          | Errors, canonical JSON and digests, source URIs. No internal imports.              |
| 2     | `contracts`     | Schemas, `parseContract`, and the semantic invariants that `parseContract` applies |
| 3     | `core`          | Snapshots, results, request bindings, processor coverage helpers                   |
| 4     | `runtime`       | Request budget, failure evidence, managed CEL runtime                              |
| 5     | `parsing`       | Source parser                                                                      |
| 6     | `compatibility` | Native Backstage adapters, substitutions, custom schemas, source validation        |
| 7     | `policy`        | Bundles, default profile, signed releases                                          |
| 8     | `providers`     | Catalog provider and transport                                                     |
| 9     | `capabilities`  | Capability contracts and sessions                                                  |
| 10    | `pipeline`      | Reference preparation, rule execution, pipeline composition, verified result       |
| 11    | `reporting`     | SARIF                                                                              |
| 12    | `host`          | Host catalog configuration, built-in validation, rule contributions                |
| 13    | `cli`, `lsp`    | Adapters. Peers: neither may import the other.                                     |
| —     | `src/index.ts`  | Public barrel. May import layers 1–11 only, as today.                              |
| —     | client          | `extensions/vscode/src`. May not import `src/` or the package, as today.           |

A simulation of this mapping against the current import graph leaves exactly three upward imports,
each resolved by a move listed below. Treat any additional upward import you find as a signal to
stop and re-check the mapping.

### File moves

| From                               | To                                    |
| ---------------------------------- | ------------------------------------- |
| `src/core/errors.ts`               | `src/base/errors.ts`                  |
| `src/core/json.ts`                 | `src/base/json.ts`                    |
| `src/core/source-uris.ts`          | `src/base/source-uris.ts`             |
| `src/core/outcomes.ts`             | `src/contracts/outcomes.ts`           |
| `src/policy/rule-graph.ts`         | `src/contracts/rule-graph.ts`         |
| `src/policy/reference-contexts.ts` | `src/contracts/reference-contexts.ts` |
| `src/policy/admission.ts`          | `src/contracts/admission.ts`          |
| `src/core/cel-rules.ts`            | `src/pipeline/cel-rules.ts`           |
| `src/core/catalog-bindings.ts`     | `src/pipeline/catalog-bindings.ts`    |
| `src/core/reference-data.ts`       | `src/pipeline/reference-data.ts`      |
| `src/core/policy-sources.ts`       | `src/pipeline/policy-sources.ts`      |
| `src/core/proposed-catalog.ts`     | `src/pipeline/proposed-catalog.ts`    |
| `src/core/scalar-fixes.ts`         | `src/pipeline/scalar-fixes.ts`        |
| `src/policy/verified-result.ts`    | `src/pipeline/verified-result.ts`     |

After the moves, `src/core` holds `snapshots.ts`, `results.ts`, `bindings.ts`, and `processing.ts`.
`src/policy` holds `bundles.ts`, `profile.ts`, and `releases.ts`.

### Splits that remove the three upward imports

1. **`JsonValue`.** Declare the `JsonValue` type structurally in `src/base/json.ts`.
   `src/contracts/schemas.ts` keeps its exported `JsonValue = Static<typeof JsonValueSchema>` and
   adds a compile-time check that the two types are mutually assignable. The generated schema must
   not change.
2. **`processing.ts`.** Keep `SUPPORTED_DEPLOYMENT_PROCESSORS`, `PROCESSING_UNAVAILABLE`,
   `processingCoverage`, and `processingFinding` in `src/core/processing.ts`. Move
   `blockedProcessorRules` to `src/pipeline/blocked-rules.ts`, because it depends on rule-execution
   types.
3. **`BUILTIN_KINDS`.** Move the constant to `src/contracts/kinds.ts`.
   `src/compatibility/types.ts` re-exports it, so the public name and its other importers do not
   change.

### Remaining file-level cycles

- Move `RuleSubject` and `RuleExecutionReport` to `src/pipeline/types.ts`. `cel-rules.ts` re-exports
  them so the public type names stay available from the same barrel.
- Remove the `lsp/config.ts` ↔ `lsp/discovery.ts` cycle with the smallest change that keeps both
  modules' exports, for example by moving the shared type or function into a third module.

### Import policy script

Rework `scripts/architecture-boundaries.mjs`. Keep its exported `checkArchitecture(root)` signature
and its existing detection of aliases, barrels, type imports, `import()` and `createRequire`.

1. Replace the `domain` set with an exported, ordered `LAYERS` list that matches the table above. A
   file's layer is its top-level directory under `src/`.
2. Fail on any import, direct or transitive, from a lower layer to a higher one. Type-only imports
   count.
3. Fail when a file sits in a top-level `src/` directory that `LAYERS` does not name.
4. Keep the existing rules: `cli` and `lsp` do not import each other, nothing imports the client,
   the client does not import `src/` or the package, `src/index.ts` does not import `cli`, `lsp`,
   or `host`, and the VS Code packages are forbidden outside `lsp` and the client.
5. Replace the `ownership` cycle rule with a global rule: no file-level import cycle anywhere in
   `src/`, type-only imports included. Report one readable chain per cycle.
6. Add package containment. These packages may be imported only from the listed layers:

   | Package                                                     | Allowed layers   |
   | ----------------------------------------------------------- | ---------------- |
   | `@backstage/catalog-model`, `backstage-catalog-model-older` | `compatibility`  |
   | `@marcbachmann/cel-js`                                      | `runtime`        |
   | `yaml`                                                      | `parsing`, `lsp` |

   If the current code already violates a row, do not move code to satisfy it. Widen the row to the
   real current set and say so in the report.

### References to moved files

Update every reference to a moved path: `src/` imports, `test/` and `extensions/vscode/test/`
imports, `scripts/*.mjs` (several import `dist/core/...` or `dist/policy/...`), `examples/`,
`README.md`, `CONTRIBUTING.md`, and the reference documents in `docs/`. Do not edit dated records
(`docs/*-record.md`, `docs/*-handoff.md`, `docs/*-findings.md`, `SESSION_HANDOFF.md`); they
describe the past.

Rewrite the "Runtime boundaries" part of `docs/architecture.md` to include the layer table.

## Work order

1. Add the public API snapshot test described below and generate its baseline **before** any other
   change. Confirm it passes on the untouched tree.
2. Perform the moves with `git mv` and fix imports. Run `npm run typecheck` until clean.
3. Apply the three splits and remove the remaining cycles.
4. Rework the import policy script and its tests.
5. Update scripts, examples, and documents.
6. Run the verification gate.

## Success criteria

1. `npm run architecture:check` passes with the layered rules and with no per-file exception for
   upward imports or cycles.
2. `src/` has no file-level import cycle, type-only imports included.
3. `src/core` and `src/policy` contain exactly the files named above. `src/base` and `src/pipeline`
   exist. No file remains at an old path, and no compatibility shim re-exports from an old path.
4. The public API snapshot is unchanged for `.`, `./contracts`, `./lsp`, and `./capabilities`,
   covering both value and type exports.
5. `npm run schemas:check` passes without regenerating `schemas/`.
6. `grep -rnE "src/(core|policy)/(errors|json|source-uris|outcomes|rule-graph|reference-contexts|admission|cel-rules|catalog-bindings|reference-data|policy-sources|proposed-catalog|scalar-fixes|verified-result)"`
   over `src test scripts examples extensions README.md CONTRIBUTING.md docs/architecture.md`
   returns nothing. The same holds for the `dist/` form of those paths in `scripts` and `examples`.
7. `docs/architecture.md` lists the layers in the same order as `LAYERS`.
8. The verification gate passes with at least 1385 tests plus the new ones and zero skipped.

## Test cases

### New: `test/public-api.test.ts`

Uses the TypeScript compiler API to list every exported symbol, value and type, of
`src/index.ts`, `src/contracts/index.ts`, `src/lsp/index.ts`, and `src/capabilities/index.ts`.
Compares the sorted names, each tagged as value or type, with a committed baseline
`test/fixtures/public-api.json`.

- Fails with a readable diff when a name is added, removed, or changes between value and type.
- A second case asserts that the runtime `Object.keys` of each compiled entry point equals the
  value names in the baseline, which catches a broken re-export chain.

### Extended: `test/architecture-boundaries.test.ts`

Keep the existing cases passing with their intent intact. Add fixture-based cases, each built in a
temporary directory like the existing ones:

1. A value import from `base` to `contracts` is rejected.
2. A type-only import from `parsing` to `compatibility` is rejected.
3. A dynamic `import()` from `core` to `pipeline` is rejected.
4. An upward import that passes through a barrel in an intermediate layer is rejected and the
   message names the chain.
5. A downward import (`pipeline` → `core`) and a same-layer import are accepted.
6. `cli` → `lsp` and `lsp` → `cli` are rejected.
7. A file in an unlisted directory (`src/misc/x.ts`) is rejected.
8. A two-file cycle inside one layer is rejected, once with value imports and once with type-only
   imports.
9. A three-file cycle across two layers reports a chain that names all three files.
10. Importing `yaml` from `policy` is rejected; importing it from `parsing` is accepted.
11. Importing `@backstage/catalog-model` from `providers` is rejected.
12. `checkArchitecture` on the real repository root returns an empty list.
13. The order of layer names in the `docs/architecture.md` layer table equals `LAYERS`.

### Existing suites that must stay green

All of them. Pay attention to `test/default-boundaries.test.ts`, `test/lsp-boundaries.test.ts`,
`test/harness-evidence-boundaries.test.ts`, `test/contracts.test.ts`, and the example scripts that
tests execute.

## Risks

- **Import order side effects.** `contracts/schemas.ts` freezes schema objects at module load.
  Moving files must not introduce a load-order dependency; the cycle check guards this.
- **Scripts that import `dist/` paths.** They are not type-checked. Search them explicitly.
- **Test fixtures in the boundary test** use directory names such as `shared`. Adjust the fixtures
  to the new rules without removing what each case proves.

## Out of scope

Splitting large functions, changing the stage logic, or changing any exported name.

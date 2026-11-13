# Phase 3: LSP composition root and editor service

Read [the shared rules](README.md) first. This plan uses the paths and guards from Phases 1 and 2.

## Goal

Split the language server's composition root into handler modules over an explicit server context,
split the editor service by feature, and split the validation run into steps, without changing a
single wire message.

## Current state

- `attachLspServer` in `src/lsp/server.ts` is one 597-line closure. It registers about 22 protocol
  handlers and shares about ten mutable variables among them (`initialized`, `stopped`,
  `clientInitialized`, `requestedShutdown`, `fixesEnabled`, `atomicTextEdits`, `dynamicWatching`,
  `watchGeneration`, `coverageObservation`, `filesystemObservation`, `disposal`). It is the most
  frequently changed source file.
- `EditorService` in `src/lsp/editor.ts` is a 940-line class that mixes document indexing,
  completion, hover, definition, rule contribution lifetime, rule rendering, and repairs.
- `runValidation` in `src/lsp/validation-run.ts` is 268 lines.
- `createFilesystemSource` in `src/lsp/filesystem.ts` is 207 lines.

The existing owners (`WorkspaceState`, `ValidationCoordinator`, `SessionResources`,
`RequestContexts`, `DiagnosticPublisher`, `ClientEdits`) are sound and stay as they are.

## Target design

### Server context (`src/lsp/server-context.ts`)

One object, built by `attachLspServer`, that every handler module receives:

- The connection, the six existing owners, and the `FixRegistry`.
- `Lifecycle`: owns `initialized`, `clientInitialized`, `stopped`, `requestedShutdown`, the
  `admitted` guard, and `close`.
- `ClientFeatures`: `fixesEnabled`, `atomicTextEdits`, `dynamicWatching`; written once during
  `initialize`.
- `Observations`: the coverage and filesystem observations with their staleness checks.

No handler module declares state that another handler module writes.

### Handler modules (`src/lsp/handlers/`)

| Module         | Handlers                                                                              |
| -------------- | ------------------------------------------------------------------------------------- |
| `lifecycle.ts` | `initialize`, `initialized`, `shutdown`, `exit`, the unsupported-method fallback      |
| `documents.ts` | open, change, close, save, watched files, file delete and rename, dynamic watch setup |
| `language.ts`  | completion, hover, definition, code action, execute command                           |
| `custom.ts`    | `bve/filesystemObservation`, `bve/validationCoverage`, `bve/recordSelection`,         |
|                | `bve/searchReferences`, `bve/reloadConfiguration`                                     |

Each module exports one `register…(context)` function. `attachLspServer` keeps its exported
signature and return value, builds the context, wires `SessionResources` and
`ValidationCoordinator`, and calls the four registration functions.

Pure decision logic moves into exported functions that tests can call without a connection:

- The watched-files admission and truncation logic.
- The `validationCoverage` staleness decision.
- The server capabilities computed from client capabilities.

### Editor service (`src/lsp/editor/`)

`EditorService` remains the class that the rest of the code and the tests import from
`src/lsp/editor.ts`, with the same public members. It becomes a facade that owns the shared state
and delegates to:

| Module           | Current members                                                   |
| ---------------- | ----------------------------------------------------------------- |
| `index-store.ts` | `update`, `refine`, `invalidate`, the indexed files and lifetimes |
| `rules.ts`       | `installRuleContributions`, `expireRules`, `ruleExpiresAt`,       |
|                  | `rulePreparationExpired`, `renderRuleCandidate`, `ruleRepairs`    |
| `completion.ts`  | `complete`, `acceptsReference`, selection history                 |
| `navigation.ts`  | `hover`, `definition`                                             |
| `repairs.ts`     | `repairs`                                                         |

### Validation run and filesystem

Split `runValidation` into capture, execute, and publish steps as named functions in
`src/lsp/validation-run.ts` or beside it. Split `createFilesystemSource` similarly. Keep their
exported signatures.

## Behavior that must be preserved exactly

1. The `initialize` result for every combination of client capabilities.
2. JSON-RPC error codes: `-32600` when shut down or re-initialized, `-32002` before
   initialization, `-32601` for unsupported methods.
3. Which handlers use the `admitted` guard and which silently ignore calls before initialization
   or after shutdown. They differ today; keep each one as it is.
4. The watched-files limits: more than 1000 changes refreshes without traversal; at most 32 URIs
   and 64 KiB are observed; `truncated` reporting.
5. The order of effects in `close`, in session reload callbacks, and in coordinator invalidation.
6. Diagnostics clearing on close, delete, and rename, including the document lifetime checks.
7. Completion merging: declared items first, de-duplicated by label, at most 100.

## Work order

1. **Characterize first.** Add the handler inventory test and the capabilities golden test below
   and generate their baselines from the untouched code.
2. Introduce the server context with `Lifecycle`, `ClientFeatures`, and `Observations`, still
   inside `server.ts`. Run the LSP tests.
3. Move handlers out one module at a time. Run the LSP tests after each.
4. Split `EditorService`, one delegate at a time.
5. Split `runValidation` and `createFilesystemSource`.
6. Remove the `src/lsp` entries from the function size allowlist.
7. Add the unit tests.
8. Run the verification gate.

## Success criteria

1. `src/lsp/server.ts` is at most 200 lines and `attachLspServer` is at most 120 lines.
2. `src/lsp/editor.ts` is at most 350 lines. No file under `src/lsp/editor/` or
   `src/lsp/handlers/` exceeds 400 lines.
3. The function size allowlist has no entry under `src/lsp/` for `server.ts`, `editor.ts`,
   `validation-run.ts`, `filesystem.ts`, or the new directories. If another `src/lsp` function
   remains above 150 lines, its entry stays and the report explains why.
4. No `let` binding in `src/lsp/server.ts` or `src/lsp/handlers/` is written by more than one
   module. Shared state lives in the context classes.
5. The handler inventory and the capabilities golden file are byte-identical to their baselines.
6. No existing test file changes except for import paths.
7. `npm run architecture:check` passes, including the cycle rule for the new modules.
8. The public API snapshot is unchanged.
9. The verification gate passes with zero skipped tests.

## Test cases

### New: `test/lsp-handler-inventory.test.ts`

Attaches the server to a recording fake connection that captures every registration call.

1. The set of registered request and notification methods equals a committed list
   (`test/fixtures/lsp-handlers.json`), generated before the refactor.
2. Each method is registered exactly once.
3. The star request handler is present.

### New: `test/lsp-capabilities.test.ts`

Calls the `initialize` handler through the fake connection and compares the result with a golden
file for each combination:

1. Fixes supported or not (each of the four client flags missing in turn).
2. Filesystem configured or not (the `save` sync option).
3. Transactional, text-only transactional, and absent failure handling.
4. Position encodings: absent, UTF-16 offered, and UTF-16 not offered (rejects).
5. A second `initialize` call rejects with `-32600`.

### New: `test/lsp-lifecycle.test.ts`

A table over every registered method and three states (before `initialize`, running, after
`shutdown`), asserting the current behavior: the error code, the empty result, or the silent
ignore. Generate the expected table from the untouched code and commit it.

### New: `test/lsp-handlers.test.ts`

Direct tests of the extracted pure functions:

1. Watched files: 1001 changes; 33 admissible URIs; URIs whose total size passes 64 KiB; a
   non-canonical URI; an invalid change type; a URI outside the approved set; a directory URI that
   is a prefix of an approved file.
2. Coverage staleness: wrong version, wrong digest, unselected document, older validation
   generation, older dependency generation, capacity exceeded, unavailable sources, observation
   disabled, and malformed parameters. Each returns `null`. A matching request returns the
   observation.
3. `Lifecycle`: `close` is idempotent and returns the same promise; a failing owner cleanup
   rejects with the cleanup error; `shutdown` then `exit` reports code 0; `exit` alone reports 1.
4. Execute command: wrong command, wrong argument count, non-string argument, busy edit slot.

### New: `test/editor-modules.test.ts`

1. Rule contribution lifetime: installed rules expire by generation and by time; expired rules
   are not rendered.
2. Selection history ordering affects completion ranking and is bounded.
3. The facade exposes the same public member names as before (compare with a committed list).

### Existing suites that must stay green

All. The most relevant are the 18 `lsp-*.test.ts` files, `lsp.test.ts`,
`editor-intelligence.test.ts`, `editor-workspace.test.ts`, `completion.test.ts`,
`capability-editor.test.ts`, and `extension-client.test.ts`.

## Risks

- **Closure ordering.** Several closures reference owners that are declared later (`sessions`,
  `coordinator`). Keep construction order and make late references explicit in the context.
- **Registration order.** Keep the order of handler registration unless the inventory test proves
  it has no effect.
- **Suites that cannot run here.** The VS Code Electron and remote suites exercise this code. List
  them in the report as needing a run before release.

## Out of scope

Changing `CompletionService`, `CatalogRefresh`, `SessionResources`, or any protocol message. The
custom method names stay as string literals until Phase 4.

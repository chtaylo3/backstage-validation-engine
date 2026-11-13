# Defect 5: Document notifications throw on missing parameters

Read [the cleanup rules](README.md) first.

## Defect

In `src/lsp/handlers/documents.ts` the handlers for `textDocument/didOpen`,
`textDocument/didChange`, and `textDocument/didClose` destructure their parameter in the function
signature (`({ textDocument: item }) => …`). When a client sends the notification without
parameters, or with `null`, the destructuring throws a `TypeError` before any guard runs. The
JSON-RPC layer logs a handler failure.

The other handlers in the same module read their parameters defensively (`params?.textDocument`,
`Array.isArray(params?.changes)`, `params?.files ?? []`) and ignore a malformed notification. The
three document handlers are inconsistent with them, and a malformed message from a client reaches
an exception path instead of being dropped.

## Fix

Give the three handlers a plain `params` argument and read it defensively, as the other handlers
do:

- `didOpen`: pass `params?.textDocument` to `workspace.open`, which already rejects a missing or
  malformed item.
- `didChange`: pass `params?.textDocument` and `params?.contentChanges` to `workspace.change`,
  which already rejects a missing item and treats a non-array change list as unavailable content.
- `didClose`: read `params?.textDocument` and keep the existing `!item` guard.

A malformed notification is ignored: no exception, no scheduled validation, no state change. Do
not add a log message or an error response. A notification has no response, and the handlers
around these three already drop malformed input silently.

Do not change what a well-formed notification does.

## What changes for callers

A `didOpen`, `didChange`, or `didClose` notification without usable parameters is now ignored
without a logged handler failure. Nothing else changes.

## Success criteria

1. Each of the three handlers returns without throwing for `undefined`, `null`, `{}`, and
   `{ textDocument: null }`, before initialization, while running, and after shutdown.
2. After each such call the workspace has the same documents, versions, and generation as before,
   and no validation is scheduled.
3. Well-formed notifications behave as before: `test/fixtures/lsp-lifecycle.json` and
   `test/fixtures/lsp-handlers.json` are byte-identical, and the existing LSP tests pass
   unchanged.
4. No handler in `src/lsp/handlers/` destructures its parameter in the function signature.
5. The new tests below fail before the fix where marked, and pass after it.
6. The full gate passes.

## Test cases

Add to `test/lsp/lsp-handlers.test.ts`, using the fake connection and `createServerContext`.

1. **Missing parameters do not throw** (fails before the fix): a table over the three handlers and
   the values `undefined`, `null`, `{}`, `{ textDocument: null }`, and `{ textDocument: 7 }`, in a
   running server. No call throws.
2. **No state change**: for every row of case 1, the workspace's documents and generation and the
   coordinator's generation are unchanged.
3. **Malformed change list**: `didChange` for an open document with a valid identifier and with
   `contentChanges` missing, `null`, or not an array does not throw. Record what the current code
   does for the same input after destructuring succeeds, and assert that it is unchanged.
4. **Before initialization and after shutdown**: the rows of case 1 do not throw in either state.
5. **Well-formed notifications still work**: open, change, and close one document; the workspace
   and the scheduled validation match the current behavior.
6. **Guard against regression**: a test that parses `src/lsp/handlers/*.ts` with the TypeScript API
   and fails when a function passed to a `connection.on…` registration has a destructuring
   pattern as a parameter.

## Out of scope

Logging malformed notifications, validating the contents of a well-formed document item beyond
what `WorkspaceState` already does, and the request handlers.

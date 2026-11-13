# Defect 4: `initialize` rejects a missing UTF-16 encoding incorrectly

Read [the cleanup rules](README.md) first.

## Defect

The `initialize` handler in `src/lsp/handlers/lifecycle.ts` has two faults when a client lists
position encodings and UTF-16 is not among them.

1. **State is written before the rejection.** The handler calls
   `features.accept(params.capabilities)` first and checks the encodings second. A rejected client
   leaves its feature flags (fixes, atomic edits, dynamic watching) recorded on the server context,
   although the server never became initialized.
2. **The rejection is a plain `Error`.** The JSON-RPC layer reports it as an internal error
   (`-32603`). The request is invalid, not a server fault. The protocol makes UTF-16 mandatory for
   clients, so a client that omits it sent invalid parameters.

## Fix

In the `initialize` handler:

1. Check the position encodings before anything is written.
2. Reject with
   `new ResponseError(ErrorCodes.InvalidParams, 'UTF-16 positions are required.', { retry: false })`.
   The code is `-32602`. The message text stays the same. `data` follows the protocol's
   `InitializeError` shape.
3. Call `features.accept` and `lifecycle.initialize()` only after the check passes.

The existing guard for a second `initialize` or an `initialize` after shutdown (`-32600`) stays
first and unchanged. A valid `initialize` after a rejected one still succeeds.

Update the reference documents that describe the rejection, for example `docs/lsp.md`, if they
name the error.

## What changes for callers

- A client that offers encodings without UTF-16 receives `-32602` with `data: { retry: false }`.
  Before, it received `-32603`.
- A rejected `initialize` leaves the server context untouched.
- Clients that offer UTF-16, or no encoding list, see no change. The VS Code client always offers
  UTF-16.

## Existing assertions that encode the defect

Update these and list them in the report:

- `test/lsp/lsp-protocol.test.ts`, "child encoding offers select UTF-16 or reject unsupported-only
  offers": it asserts the code `-32603`.
- `test/lsp/lsp-capabilities.test.ts`, "initialize rejects a second call with -32600 and a client
  without UTF-16 positions": it asserts `{ type: 'Error', message }`.
- `test/fixtures/lsp-capabilities.json`: the cases "position encodings without UTF-16" and
  "initialize after a rejected position encoding". Regenerate with `BVE_UPDATE_LSP_GOLDEN=1` and
  format with Prettier. Only these two cases may differ; show the diff.

`test/fixtures/lsp-lifecycle.json` and `test/fixtures/lsp-handlers.json` must not change.

## Success criteria

1. A client whose encoding list lacks UTF-16 is rejected with the code `-32602`, the message
   `UTF-16 positions are required.`, and `data` equal to `{ retry: false }`, both through the fake
   connection and through a real child process over stdio.
2. After that rejection, the server context's feature flags are all still `false` and the
   lifecycle is not initialized.
3. A following valid `initialize` on the same connection succeeds and returns the same result as
   on a fresh connection.
4. An absent list, an empty list, and any list that contains `utf-16` are accepted as before.
5. The diff of `test/fixtures/lsp-capabilities.json` touches only the two named cases, and the
   other LSP golden files are byte-identical.
6. The new tests below fail before the fix where marked, and pass after it.
7. The full gate passes.

## Test cases

Add to `test/lsp/lsp-capabilities.test.ts` or `test/lsp/lsp-handlers.test.ts`, using the fake
connection and `createServerContext`.

1. **Typed rejection** (fails before the fix): encodings `['utf-8']` reject with a `ResponseError`
   whose code is `-32602`, whose message is unchanged, and whose `data` is `{ retry: false }`.
2. **No state written** (fails before): a client that would enable fixes, atomic edits, and
   dynamic watching, but offers `['utf-8', 'utf-32']`, is rejected. Afterwards all three flags on
   the context are `false`, and `lifecycle.initialized` is `false`.
3. **Retry succeeds**: after case 2, a valid `initialize` succeeds, and the flags then reflect the
   second request's capabilities.
4. **Rejected, then a different client**: a rejected request that offered fixes is followed by a
   valid request that does not offer them. Fixes are disabled, and the result has no code-action
   provider.
5. **Accepted lists**: absent, `[]`, `['utf-16']`, `['utf-8', 'utf-16']`, and `['utf-32',
'utf-16']` are all accepted with `positionEncoding: 'utf-16'`.
6. **Guard order**: after a successful `initialize`, a second request with `['utf-8']` rejects with
   `-32600`, not `-32602`.
7. **Over stdio**: the updated child-process test receives `-32602` and the `data` value.

## Out of scope

Other `initialize` validation, the unguarded parameters of `didOpen` and `didChange`, and the
silent handling of `bve/recordSelection` before initialization.

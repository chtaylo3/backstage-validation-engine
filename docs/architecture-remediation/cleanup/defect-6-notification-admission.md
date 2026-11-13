# Defect 6: `bve/recordSelection` is dropped without a stated rule

Read [the cleanup rules](README.md) first.

## Defect

The five client-to-server custom methods do not behave the same way before `initialize` or after
`shutdown`. The four requests reject with `-32002` or `-32600`. `bve/recordSelection` is silently
ignored. The same notification is also silently ignored when its parameter is not a string of at
most 512 characters, or when the session is unavailable.

The difference is not a coding mistake. `bve/recordSelection` is a notification, and JSON-RPC
gives a notification no response, so the server cannot reject it. The protocol also forbids the
server from sending messages before it has answered `initialize`, so it cannot warn the client
either. The defect is that this rule is stated nowhere: not in the protocol module, not in the
documents, and not in a test. A reader sees an inconsistency, and a future change could "fix" it
in a way that breaks the protocol.

## Fix

Make the rule explicit and enforced. Do not change the handler's behavior.

1. **State the rule in the protocol module.** In `src/protocol/methods.ts`, document on
   `BVE_METHOD_SHAPES` (or beside it) the admission rule for each kind:
   - a request outside the initialized state is rejected with `-32002` (not initialized) or
     `-32600` (shut down);
   - a notification outside the initialized state, or with parameters that fail its guard, is
     dropped without effect and without a response.
2. **State it in the reference document.** Add the same rule to the custom-protocol part of
   `docs/lsp.md` and to the "Shared protocol" section of `docs/architecture.md`.
3. **Derive the handler's guard from one place.** `src/lsp/handlers/custom.ts` keeps dropping the
   notification. Express the drop through one small helper used by every custom notification
   handler (there is one today), so a second notification cannot be registered with a different
   rule.
4. **Enforce it with tests.** See below.

The client needs no change. `extensions/vscode/src/extension.ts` sends `bve/recordSelection` only
while the language client is running, and replays the stored history after every start and
configuration reload, so a dropped notification loses nothing.

## What changes for callers

Nothing at run time. The behavior is documented and tested.

## Success criteria

1. The admission rule for requests and notifications is written in `src/protocol/methods.ts`,
   `docs/lsp.md`, and `docs/architecture.md`, in the same words.
2. A test fails if any custom client-to-server request does not reject outside the initialized
   state, or if any custom client-to-server notification throws, responds, or changes state
   outside it. The test reads the method list from `BVE_METHOD_SHAPES`, so a new method is covered
   without editing the test.
3. `bve/recordSelection` behaves exactly as before in every state: `test/fixtures/lsp-lifecycle.json`
   and `test/fixtures/lsp-handlers.json` are byte-identical.
4. `test/fixtures/public-api.json` is unchanged. A new helper stays internal to `src/lsp/`.
5. The full gate passes.

## Test cases

Add to `test/lsp/protocol-parity.test.ts` or `test/lsp/lsp-handlers.test.ts`, using the fake
connection.

1. **Requests reject outside the initialized state**: for every method in `BVE_METHOD_SHAPES` with
   the direction client-to-server and the kind request, the handler rejects with `-32002` before
   `initialize` and with `-32600` after `shutdown`.
2. **Notifications are dropped outside the initialized state**: for every client-to-server
   notification, a call with valid parameters before `initialize` and after `shutdown` does not
   throw, sends nothing on the connection, and leaves the selection history of the completion
   service and the editor unchanged.
3. **Invalid parameters are dropped while running**: a non-string, a 513-character string, `null`,
   and `undefined` are each dropped without effect.
4. **Unavailable session**: a valid notification while the session is unavailable is dropped
   without effect.
5. **Valid notification while running**: the value is recorded once in both the completion service
   and the editor.
6. **Coverage of the method list**: the test asserts that it exercised every client-to-server
   method in `BVE_METHOD_SHAPES`, so an untested new method fails the test.

Cases 2 to 5 describe current behavior and pass before the change. They are the point of this
plan: the rule becomes a tested contract.

## Out of scope

Changing `bve/recordSelection` into a request, adding a server-to-client warning, and any change
to the client.

# Phase 4: Session lifetime

Read [the plan overview](README.md) first. This plan extends the sign-in of
[Phase 3](phase-3-extension-sign-in.md).

## Goal

A session survives the expiry of an access token and a restart of VS Code, ends cleanly when
Backstage ends it, and can be ended by the developer. Two windows share one session.

## Current state

- After Phase 3, a session lives in the memory of one window. When the access token expires, the
  server stops sending it and catalog reads are unavailable.
- Backstage issues a refresh token when `auth.experimentalRefreshToken` is enabled and the client
  asked for `offline_access`. It rotates the refresh token on every use.
- The server sends `bve/catalogCredentialRejected` when Backstage answers HTTP 401.
- VS Code `SecretStorage` keeps secrets on the developer's machine, also when the extension runs
  on a remote host. It raises a change event in every window.

## Target design

### Refresh tokens on or off

With `signIn.refreshTokens` absent or `true`, the extension requests the scope `offline_access`
and uses the refresh token as this plan describes. With `false`, it requests only `openid`,
stores no record, and ignores a refresh token that Backstage sends anyway. The session then ends
when the access token expires or the window closes, with the one notification of
[loss of session](#loss-of-session).

### Storage

Store one record in `SecretStorage` for each pair of authorization server and client identifier:
the refresh token, the principal, and the session identifier. The key is a digest of the pair.
Store nothing else. The access token is never stored.

Phase 3 checks `SecretStorage` before a sign-in. When it fails later, during a session, the
extension keeps the session in memory, shows one error that secure storage stopped working, and
ends the session when the window closes or the access token can no longer be refreshed.

### Refresh

- Refresh when 80% of the access token's lifetime has passed, and when the server reports a
  rejected credential.
- One refresh runs at a time in a window.
- After a refresh, store the new refresh token first. Then deliver the new access token to the
  server with the same session identifier.
- A refresh keeps the principal. If `userinfo` returns another principal, end the session.

### Two windows

Every window reads the stored record at start and on the change event of `SecretStorage`. Before a
window refreshes, it reads the record again. When a refresh is refused, the window reads the
record once more: if another window stored a newer refresh token meanwhile, the window uses that
one, once. Otherwise the session has ended.

### Loss of session

The session ends when a refresh is refused, when no refresh token exists and the access token has
expired, or when Backstage rejects a token that was just refreshed. The extension then:

1. sends the removal message to the server,
2. deletes the stored record,
3. shows the status bar item as `Backstage: Sign in`, and
4. shows one notification with a `Sign In` action. It shows no further notification until the
   developer has signed in again.

A network failure during a refresh does not end the session. The extension tries again with a
delay that doubles from 5 seconds to 5 minutes, while the access token stays in use until it
expires.

### Sign-out

`Sign Out` sends the removal message to the server, sends the refresh token to the revocation
endpoint, and deletes the stored record, in that order. A failed revocation is reported in the
output channel, and the other two steps still happen. Other windows see the change event and send
their own removal message.

### Configuration change

When a reload of the trusted configuration changes `signIn` or the catalog base URL, the extension
sends the removal message and uses the record of the new pair, if one exists. A token of one
authorization server is never sent to another.

### Stored static token

A configuration with `tokenStorage` set to `"editor"` uses a static token that the developer
enters once. It is the alternative to `tokenEnv` and `tokenFile` for the editor. The token rests
in `SecretStorage` on the desktop, also in the WSL and Coder topologies, and never in a file or
an environment variable.

- **Commands.** `Backstage Validation: Set Catalog Token` asks for the token in a password input
  and stores it. `Backstage Validation: Clear Catalog Token` deletes it and sends the removal
  message. Both are hidden without a `tokenStorage` configuration.
- **Key.** One stored token for each pair of connection identifier and catalog base URL. A token
  of one catalog is never sent to another.
- **Delivery.** At each start of the server, and when the stored token changes in any window,
  the extension sends the token on the credential pipe.
- **Checks.** The extension runs the secure storage check of
  [Phase 3](phase-3-extension-sign-in.md#checks-before-sign-in) before it stores a token. When
  the check fails, it shows the error and stores nothing.
- **Missing token.** Without a stored token, catalog reads are unavailable, and the extension
  shows one notification with a `Set Catalog Token` action for each window start.
- **Rejected token.** When the server reports a rejected credential, the extension shows one
  error that the catalog token was refused. It keeps the stored token, because a static token
  cannot be refreshed, and the developer replaces it.

The extension does not validate or decode the token. It refuses an empty value and a value with a
line break.

## Work order

1. Add `session.ts` to `extensions/vscode/src/sign-in/`: the record, the refresh timer, and the
   state machine.
2. Connect the rejection notification and the `SecretStorage` change event.
3. Implement `Sign Out` and the configuration change.
4. Add refresh, rotation, and revocation to the fake authorization server.
5. Add the installed-editor cases `sign-in-refresh.case.ts` and `sign-in-two-windows.case.ts`.
6. Add the stored static token: the two commands, the storage key, and the delivery.
7. Update `extensions/vscode/README.md`.

## Success criteria

1. With an injected clock, completion and validation continue across three access token lifetimes
   without a prompt, and the fake Backstage sees three different tokens for one principal.
2. After a restart of VS Code, catalog reads work without a sign-in.
3. Two windows stay signed in across five refreshes, in any order of the two windows.
4. A refused refresh leads to one notification, and 20 further catalog requests lead to none.
5. After `Sign Out`, the fake authorization server has received the revocation, `SecretStorage`
   has no record, and the next catalog read in both windows makes no HTTP request.
6. The refresh token appears only in `SecretStorage` and in requests to the token and revocation
   endpoints.
7. With a `tokenStorage` configuration and a stored token, catalog reads work after a restart of
   VS Code and in a second window, and the token is in no file and in no environment variable of
   the server process.

## Test cases

1. Refresh: at 80% of the lifetime; after a rejection notification; two triggers at once cause
   one request.
2. Rotation: the stored record holds the new refresh token before the server receives the new
   access token.
3. Network failure: three failed refreshes, then success; the session continues.
4. Refused refresh with an unchanged record: the session ends.
5. Refused refresh with a record that another window replaced: one retry with the new token.
6. Changed principal after a refresh: the session ends, and the server reloads its resources.
7. No refresh token in the token response: the session ends when the access token expires, with
   one notification.
8. Rejection directly after a refresh: the session ends, with no second refresh.
9. Sign-out: with a working revocation endpoint; with a failing one; in a second window.
10. Configuration reload: another authorization server; another catalog base URL; no `signIn`.
11. `SecretStorage` failure on read and on write.
12. Canary: the refresh token appears in no output, trace, state, or file.
13. Stored static token: set, restart, second window, replace, and clear; a missing token; a
    rejected token; a value with a line break; a failed storage check; a reload to a
    configuration with another catalog base URL sends no token.
14. Refresh tokens off: the authorization request has no `offline_access` scope; `SecretStorage`
    stays empty; a refresh token in the token response is not stored and not used; the session
    ends at expiry with one notification.

## Exit criteria

The [exit criteria for every phase](README.md#exit-criteria-for-every-phase) apply.

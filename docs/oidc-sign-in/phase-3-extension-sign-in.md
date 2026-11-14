# Phase 3: Sign-in in the extension

Read [the plan overview](README.md) first. This plan uses the credential channel of
[Phase 2](phase-2-launcher-credentials.md) and the redirect mechanism that
[Phase 1](phase-1-feasibility.md) recorded.

## Goal

A developer runs one command, signs in to Backstage in the browser, and gets catalog completion
and catalog rule results. This phase holds the session for the life of the window. Phase 4 adds
refresh, storage, and sign-out.

## Current state

- `extensions/vscode/src/extension.ts` is the whole client. It reads the trusted configuration in
  `selectors`, starts the server with `command` and `args`, and passes `process.env` to it.
- The extension contributes five commands and one setting, `backstageValidation.configPath`, at
  the application scope. It does not support untrusted workspaces.
- `activate` returns an API with `filesystemObservation`, `coverage`, and `status`.
- The client tests in `test/extension/` run against a fake `vscode` module. The installed-editor
  cases are in `extensions/vscode/test/cases/`.

## Target design

### Modules

Add `extensions/vscode/src/sign-in/`:

- `oauth.ts`: the protocol steps as functions that import neither `vscode` nor a file system
  module. Discovery, the authorization URL, the code exchange, and `userinfo`.
- `redirect.ts`: the URI handler for `vscode://<publisher>.<name>/sign-in`. It takes the
  identifier from the running extension, so that a customer distribution uses its own.
- `channel.ts`: the writer for the credential pipe.

### Topologies

The same code runs in the three [topologies](README.md#deployment-topologies). The extension
does not test which one it is in, with one exception: sign-in needs the `vscode` URI scheme, and
the `Sign In` command reports a fixed message when `vscode.env.uriScheme` has another value.

- **Callback.** VS Code on the desktop receives the callback and passes it to the extension host.
  The extension opens no listening port in any topology.
- **Approval of the server.** The trusted configuration file can be on a remote host. Before the
  first sign-in to an authorization server, the extension shows a modal question that names the
  host. It stores the approved server in `SecretStorage`, which is on the desktop, and it does not
  ask again for that server.
- **Network.** The extension host makes the discovery, token, and `userinfo` requests. It uses
  the proxy and certificate settings that the feasibility record names.

### Checks before sign-in

The extension cannot register the `vscode://` scheme. The installation of VS Code on the desktop
does that. No VS Code API reports whether the scheme is registered or which keyring protects
`SecretStorage`, and in the WSL and Coder topologies the extension cannot inspect the desktop.
The extension therefore checks what it can, and it reports the rest at the moment of failure.
Each failure shows one error message with its cause and its correction, and ends the sign-in.
Validation of local sources continues, and the static token stays available as the alternative.

| Check          | When                     | How                                                     | On failure                                                                               |
| -------------- | ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| URI scheme     | Before the browser opens | `vscode.env.uriScheme` equals `vscode`                  | Error: this editor is not supported for sign-in                                          |
| Secure storage | Before the browser opens | Store, read, and delete a test value in `SecretStorage` | Error: secure storage does not work; set up a keyring, or turn refresh tokens off        |
| Callback       | After the browser opens  | No callback within two minutes                          | Error: the browser did not return to VS Code, with the causes that the setup guide lists |

- The storage check is skipped when `signIn.refreshTokens` is `false`, because the extension then
  stores no token. The approval of the server is then asked at every sign-in.
- The storage check proves that storage works. It cannot prove that the keyring encrypts
  securely: a Linux desktop without a keyring can use a weak store that VS Code offers, and the
  API does not show this. The setup guide states it, and recommends `refreshTokens: false` for
  such a desktop.
- The callback check cannot tell a missing scheme registration from a refused redirect URI or a
  closed browser. Its message lists the three causes in that order.
- After the callback error, the attempt stays valid until its five-minute limit, so a late
  callback still completes the sign-in.

### Flow

1. **Discovery.** Fetch `<authorizationServer>/.well-known/openid-configuration` with a 10-second
   limit and a 64 KiB limit, without following a redirect. Require the issuer to equal
   `signIn.authorizationServer`, every endpoint to have its origin, and `S256` in
   `code_challenge_methods_supported`.
2. **Request.** Create a verifier from 32 random bytes and a `state` from 32 random bytes. Build
   the authorization URL with `response_type=code`, the client identifier, the redirect URI, the
   scope `openid`, the challenge, and the state. Phase 4 adds the scope `offline_access`.
3. **Browser.** Open the URL with `vscode.env.openExternal`, only inside the `Sign In` command.
4. **Callback.** Accept one callback for the one pending attempt. Compare `state` in constant
   time. An attempt ends after five minutes, after one callback, or when the developer cancels.
   A callback without a pending attempt has no effect and shows nothing. This is also what a
   window does when the desktop gives it the callback of another window's attempt.
5. **Exchange.** Send the code, the verifier, the redirect URI, and the client identifier to the
   token endpoint. Send no client secret.
6. **Identity.** Read `sub` from the `userinfo` endpoint. It is the principal. Create a random
   session identifier.
7. **Delivery.** Write the credential message to the pipe.

The extension treats the token as an opaque value. It does not decode it, and it does not check a
signature. Backstage alone verifies the token, on every catalog request.

### Starting the server

With a `signIn` configuration, the extension starts the server through the function form of the
server options. It spawns the packaged runtime with the arguments
`<server> --config <path> --credential-fd 3`, four pipes, and no shell. Without `signIn`, the
extension keeps the present launch unchanged.

### What the developer sees

- **Commands.** `Backstage Validation: Sign In` and `Backstage Validation: Sign Out`.
- **Status bar.** One item shows `Backstage: Sign in` or the name of the principal. Selecting it
  runs the matching command. The item is hidden without a `signIn` configuration.
- **Notification.** Once for each window start, when a `signIn` configuration has no session:
  `Sign in to <host> to check catalog references.` with a `Sign In` action. The notification is
  not modal.
- **Failure.** A fixed message for each cause: the server could not be reached, the server is not
  the configured one, the sign-in was cancelled, the sign-in expired, the sign-in was refused.
  No message contains a URL with a query, a code, a state, or a token.

### Limits

- The exported API of `activate` gains no member, and `status` returns no credential.
- The extension registers no VS Code authentication provider.
- The extension reads `signIn` only from the trusted configuration file. No setting names an
  authorization server or a client.
- In an untrusted workspace, the commands do nothing.

## Work order

1. Add `oauth.ts` with unit tests against a fake authorization server in `test/harness/`.
2. Add `redirect.ts` and `channel.ts`.
3. Add the commands, the status bar item, and the notification to `extension.ts` and
   `package.json`.
4. Change the server launch for a `signIn` configuration.
5. Extend the fake `vscode` module of the client tests as needed.
6. Add the installed-editor case `sign-in.case.ts`, and say in the report which existing cases
   the changed launch affects.
7. Update `extensions/vscode/README.md` and [the editor features document](../editor-features.md).

## Success criteria

1. With the fake authorization server and the fake Backstage, `Sign In` leads to a catalog read
   that carries the issued token, with no restart of the server.
2. The authorization URL contains `code_challenge_method=S256`, a challenge that matches the
   verifier, and no secret.
3. The browser opens only inside the `Sign In` command. Starting the window, opening a file, and
   a rejected token do not open it.
4. A discovery document with another issuer, or with an endpoint on another origin, ends the
   sign-in before the browser opens.
5. The token is sent only to the token endpoint's origin and to the catalog base URL.
6. A window without a `signIn` configuration shows no new user interface and starts the server
   exactly as before.
7. The extension opens no listening port during a sign-in.
8. The first sign-in to an authorization server asks for approval once, and a changed
   authorization server in the configuration file asks again before the browser opens.
9. A failed check before sign-in shows one error with its cause, ends the sign-in, and leaves
   local validation and its findings unchanged.

## Test cases

1. Flow: a complete sign-in; a cancelled sign-in; a sign-in that passes the five-minute limit.
2. Callback: a wrong `state`; a missing `state`; a second callback with the right `state`; a
   callback with no pending attempt; an `error` parameter from the server.
3. Discovery: another issuer; an endpoint on another origin; a document over 64 KiB; a redirect
   response; no `S256` support; an HTTP server that is not a loopback address.
4. Exchange: the server refuses the code; the response has no access token; the response exceeds
   the size limit.
5. Identity: `userinfo` fails, and no credential is delivered.
6. Launch: the server process has the fourth pipe with `signIn` and does not have it without.
   `status().pid`, `Stop`, `Restart`, and a server crash behave as in the existing cases.
7. Trust: in an untrusted workspace, `Sign In` does nothing.
8. Approval: a refused approval opens no browser; an approved server is not asked again; another
   server is asked.
9. Checks before sign-in: a URI scheme other than `vscode`; `SecretStorage` that fails on store,
   on read, and on delete; the same failure with `refreshTokens` set to `false`; no callback
   within two minutes; a callback after the error and before the five-minute limit. Each failure
   opens no further browser window and leaves validation running.
10. Other window: a callback with the `state` of another window's attempt has no effect, and that
    attempt ends at its five-minute limit with the fixed message.
11. Canary: with canary values for the code, the verifier, the state, and the token, the output
    channel and the LSP trace at the verbose level contain none of them.

## Exit criteria

The [exit criteria for every phase](README.md#exit-criteria-for-every-phase) apply.

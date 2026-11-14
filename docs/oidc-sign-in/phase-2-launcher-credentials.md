# Phase 2: Launcher-supplied credentials

Read [the plan overview](README.md) first. This plan uses the answers of
[Phase 1](phase-1-feasibility.md). It starts after
[Phase 1 of the distribution plan](../distributions/phase-1-composition-roots.md), and it is
written against the entry functions of that phase.

## Goal

The language server accepts the catalog credential from the process that started it, on a private
pipe, and holds it in memory only. A test launcher supplies the credential in this phase. The
extension does not change.

## Current state

- `CatalogSettingsSchema` in `src/host/catalog-config.ts` requires `principalId` and
  `credentialRevision`, and `parseCatalogSettings` requires exactly one of `tokenEnv` and
  `tokenFile`.
- `createHostCatalog` reads the token once when it builds the provider, so a missing token fails
  server startup. It builds one fixed access context from the configuration.
- `runStdioServer` in `src/lsp/run-stdio.ts` accepts exactly `--config <path>` in its `argv`. It
  reloads the session resources when the configuration file or the token file changes.
  `src/lsp/stdio.ts` only calls it.
- The catalog provider reports HTTP 401 and HTTP 403 as the same failure, `permission_denied`.
- `BVE_METHODS` in `src/protocol/methods.ts` has one server-to-client method,
  `bve/configurationReloaded`.
- `runCli` in `src/cli/run.ts` uses `createHostCatalog` with the same settings.

## Target design

### Configuration

Add the optional property `signIn` to the catalog settings:

- `authorizationServer`: an absolute URL without a query, a fragment, or embedded credentials. The
  scheme is HTTPS, or HTTP to a loopback address.
- `clientId`: an absolute HTTPS URL, at most 4,096 characters.
- `refreshTokens`: an optional boolean. The default is `true`.

Add the optional property `tokenStorage` to the catalog settings. Its one allowed value is
`"editor"`: the editor keeps a static token in its secret storage and supplies it on the
credential channel. [Phase 4](phase-4-session-lifetime.md#stored-static-token) adds the editor's
part.

A configuration selects exactly one of `tokenEnv`, `tokenFile`, `tokenStorage`, and `signIn`.
With `signIn`, `principalId` and `credentialRevision` must be absent, because the session supplies
them. Without `signIn`, both stay required. The server does not use the `signIn` values. It
validates them so that one file serves the server and the extension.

### Credential channel

The launcher starts the server with `--config <path> --credential-fd 3` and gives the process a
pipe on file descriptor 3. The server only reads from the pipe.

- A message is one line of JSON, at most 16,384 bytes, ended by a line feed.
- `{"type":"credential","token":…,"principalId":…,"sessionId":…,"expiresAt":…}` replaces the
  current credential. The token obeys the provider's existing bounds. `expiresAt` is a wall-clock
  time in milliseconds.
- With `tokenStorage`, the message is `{"type":"credential","token":…}` without the other three
  properties. The principal and the credential revision come from the configuration, and the
  credential has no expiry.
- `{"type":"none"}` removes the current credential.
- An invalid line, a line over the limit, or the end of the pipe removes the current credential
  and closes the channel. The server keeps running. It writes one fixed line to standard error
  that contains no part of the input.

A configuration with `signIn` or `tokenStorage` and no `--credential-fd` fails startup with the
existing fixed message. `--credential-fd` with a configuration that has neither also fails
startup. The CLI rejects `tokenStorage` as it rejects `signIn`. The CLI
rejects a catalog configuration with `signIn` as invalid arguments, because it has no sign-in.

### Credential state

Add a credential holder that the host catalog reads on every request:

- **No credential, or a credential past `expiresAt`.** The lookup returns the existing
  `permission_denied` failure without an HTTP request. Server startup does not need a credential.
- **A credential with the same `principalId` and `sessionId` as the current one.** The token is
  replaced in place. The session resources stay.
- **A credential with another `principalId` or `sessionId`, or the first one.** The server reloads
  the session resources through the existing reload path. The access context takes `principalId`
  from the message and uses `sessionId` as `credentialRevision`.
- **Removal.** The server reloads the session resources, so that no cached catalog data of the
  earlier principal remains.

### Rejection signal

When Backstage answers a catalog request with HTTP 401, the provider reports it to the host
separately from HTTP 403. The finding and the failure code stay `permission_denied` in both cases.
The server then sends the new server-to-client notification `bve/catalogCredentialRejected` with
the `sessionId` of the rejected credential. It sends the notification at most once for each
credential message. The notification carries no token.

## Work order

1. Extend the settings schema and `parseCatalogSettings`. Update the schema equivalence fixture if
   the test requires it.
2. Add the credential holder and the pipe reader in a new module under `src/host/`.
3. Make `createHostCatalog` take a credential source, and keep the two existing sources behind
   the same interface.
4. Extend the argument check in `runStdioServer`, and connect the holder to the reload path.
5. Distinguish HTTP 401 in the provider's internal failure detail, and add the notification to
   `src/protocol/` and to the method shapes.
6. Add a test launcher to `test/harness/` that starts the server with the fourth pipe.
7. Update [the language server document](../lsp.md), [the catalog provider document](../catalog-provider.md),
   and [the CLI document](../policy-cli.md).

## Success criteria

1. A server with a `signIn` configuration starts without a credential, validates local sources,
   and reports catalog rules as it does for a denied catalog.
2. After a credential message, the next catalog read succeeds without a restart.
3. A replaced token for the same session causes no reload of the session resources.
4. A credential for another principal never reads a cache entry of the earlier principal.
5. The token appears in no LSP message, no line on standard error, and no file.
6. Every existing test passes without a changed assertion, and a `tokenEnv` or `tokenFile`
   configuration produces byte-identical wire messages.

## Test cases

1. Settings: each pair of two credential sources is refused; `signIn` with `principalId` is
   refused; a non-HTTPS `clientId` is refused; a loopback HTTP `authorizationServer` is accepted.
2. Startup: `signIn` without `--credential-fd` fails; `--credential-fd` without `signIn` fails;
   the CLI refuses a `signIn` catalog configuration with exit code 2.
3. Channel: a valid credential; a line of 16,385 bytes; invalid JSON; an unknown `type`; a token
   with a line break; the end of the pipe. Each invalid case leaves no credential.
4. Expiry: with an injected clock, a request after `expiresAt` makes no HTTP request.
5. Replacement: same session, new token; new session; new principal; removal. The fake Backstage
   records which token each request carried.
6. Rejection: HTTP 401 sends one notification for the credential and none for a repeated 401.
   HTTP 403 sends none.
7. Canary: a run with a canary token, with every LSP message and all standard error captured,
   contains no canary text.
8. Protocol parity: `test/lsp/protocol-parity.test.ts` covers the new method.

## Exit criteria

The [exit criteria for every phase](README.md#exit-criteria-for-every-phase) apply.

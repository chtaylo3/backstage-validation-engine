# Phase 1: Feasibility record

Read [the plan overview](README.md) and [Phase 1](phase-1-feasibility.md) first.

This record answers the questions of Phase 1 with the evidence that supports each answer. It
records what was observed, on which Backstage release, runner, desktop, and topology. A question
that nobody has answered yet is marked **pending**, with the person or workflow that answers it.

The first answers were recorded on 2026-11-14, on Linux (WSL 2, kernel 6.6.87.2, Docker 29.9.2,
Node 24.22.1), at commit `1345c23` with the plan documents of `6e67a7c` and the uncommitted Phase 1
changes. No token, authorization code, PKCE verifier, or refresh token that Backstage issued appears
in this record or in its evidence files.

## Answers

| ID  | Layer | Answer                                                                                                                                                                | Where it was answered                                                | Evidence                                                        |
| --- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| B1  | 2     | **Yes.** Backstage accepts the `vscode://` redirect URI and the browser follows it after consent.                                                                     | Compose applications 1.55.3 and 1.56.3, local Docker                 | [B1](#b1-the-vscode-redirect-uri)                               |
| B2  | 2     | **Yes, with limits.** Issue, rotation, refusal of a rotated-out token, and revocation work on SQLite.                                                                 | 1.55.3 and 1.56.3                                                    | [B2](#b2-refresh-tokens-on-sqlite)                              |
| B3  | 2     | **Yes.** An HTTPS document server on the Compose network works, with an exact client ID pattern and a trusted test authority.                                         | 1.55.3 and 1.56.3                                                    | [B3](#b3-the-client-metadata-document)                          |
| B4  | 2     | **Yes.** The catalog accepts the token as the user, and `userinfo` returns the user entity reference.                                                                 | 1.55.3 and 1.56.3                                                    | [B4](#b4-user-token-and-userinfo)                               |
| B5  | 2     | **No before this phase; yes after it.** The policy acted only on service principals. It now denies one user, and the other user is unaffected.                        | 1.55.3 and 1.56.3                                                    | [B5](#b5-per-user-permission-decisions)                         |
| B6  | 2     | **No.** `expires_in` is always 3600, also when the token lives 900 seconds.                                                                                           | 1.55.3 and 1.56.3                                                    | [B6](#b6-the-reported-expiry)                                   |
| V1  | 3     | **Yes on Linux.** **Pending** on Windows and macOS.                                                                                                                   | Linux, VS Code 1.106.3 and 1.145.2, local Xvfb                       | [V1](#v1-a-link-through---open-url)                             |
| V2  | 3     | **Yes, after the developer allows the link.** Without that consent, VS Code holds the link in a dialog and delivers nothing.                                          | Linux SSH fixture, VS Code 1.106.3 and 1.145.2                       | [V2](#v2-a-link-to-the-extension-on-the-ssh-host)               |
| V3  | 3     | **Yes, with a change.** The fourth pipe works, but the language client then leaves `serverProcess` unset, so the extension must keep the child process itself.        | Linux, VS Code 1.106.3 and 1.145.2. **Pending** on Windows and macOS | [V3](#v3-a-fourth-pipe-to-the-server)                           |
| V4  | 3     | **Yes, where secret storage works.** The SSH window read the value that a local window stored, and saw one change event. Without a keyring, the store did not finish. | Linux SSH fixture, VS Code 1.106.3 and 1.145.2                       | [V4](#v4-secret-storage-from-a-local-window-in-a-remote-window) |
| V5  | 3     | **Pending:** needs the hosted macOS runner.                                                                                                                           | —                                                                    | [V5](#v5-the-macos-open-command)                                |
| D1  | 4     | **Pending:** the owner runs it.                                                                                                                                       | —                                                                    | [Pending questions](#pending-questions)                         |
| D2  | 4     | **Pending:** the owner runs it.                                                                                                                                       | —                                                                    | [Pending questions](#pending-questions)                         |
| D3  | 4     | **Pending:** the owner runs it.                                                                                                                                       | —                                                                    | [Pending questions](#pending-questions)                         |
| D4  | 4     | **Pending:** the owner runs it.                                                                                                                                       | —                                                                    | [Pending questions](#pending-questions)                         |
| D5  | 4     | **Pending:** the owner runs it.                                                                                                                                       | —                                                                    | [Pending questions](#pending-questions)                         |

## What an operator configures

These values were accepted by both pinned releases.

```yaml
auth:
  clientIdMetadataDocuments:
    enabled: true
    allowedClientIdPatterns:
      - https://example.com/backstage-validation/vscode-client.json
    allowedRedirectUriPatterns:
      - vscode://chtaylo3.backstage-validation-engine/sign-in
  experimentalRefreshToken:
    enabled: true
```

- **The redirect URI** is `vscode://chtaylo3.backstage-validation-engine/sign-in`, and the exact
  `allowedRedirectUriPatterns` entry is the same string. A configured list replaces Backstage's
  loopback defaults: with this list, a loopback redirect URI is refused (test case 4).
- **The client ID** is the HTTPS URL of the client document, as an exact `allowedClientIdPatterns`
  entry. Backstage then skips its check that the document's host has a public address. Backstage
  1.55.3 and 1.56.3 accept an `http:` client ID only for `localhost` with `NODE_ENV=development`.
- **The Backstage backend must trust the certificate of the document's host.** In the tests, the
  backend received `NODE_EXTRA_CA_CERTS` with the test authority.
- **Refresh tokens** need the user entity in the catalog. A refresh for a user without an entity
  fails with `User entity no longer exists in the catalog`. Backstage logs on startup that SQLite
  cannot fully protect concurrent rotation.

### The client metadata document

This is the complete document that the tests served. A customer distribution replaces the
`client_id` URL, the name, and the redirect URI with its own.

```json
{
  "client_id": "https://client-document:8443/vscode-client.json",
  "client_name": "Backstage Validation Engine for VS Code",
  "redirect_uris": ["vscode://chtaylo3.backstage-validation-engine/sign-in"],
  "response_types": ["code"],
  "grant_types": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_method": "none",
  "scope": "openid offline_access"
}
```

- `client_id` must equal the URL that serves the document, exactly.
- The redirect URI must be listed exactly, without a query. A request with
  `?windowId=1` added is refused with `not registered in client metadata`.
- The document must not contain `client_secret`, and `token_endpoint_auth_method` must not name a
  secret method.

### A proxy or a private certificate authority

- **Backstage side (observed):** the backend fetches the client document. Its host certificate must
  be trusted by the backend, through `NODE_EXTRA_CA_CERTS` or a public authority.
- **Desktop and remote side: pending D3.** The browser reaches Backstage from the desktop. The
  extension host and the packaged runtime reach it from the desktop, WSL, or the Coder workspace.
  D3 measures, for each topology, whether both reach an HTTPS Backstage under the URL that the
  browser uses, and which of `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`, and the VS Code setting
  `http.proxy` each side needs. Success criterion 4 is open until D3 is recorded.

## Decisions that follow

1. **The plan does not need the companion extension.** B1 holds on both releases, and V2 holds on
   the SSH fixture after consent. D1 must still confirm a real browser on the owner's desktops.
2. **VS Code asks before it gives a link to an extension.** In a normal window, VS Code shows
   **Allow 'Backstage Validation Engine' extension to open this URI?** with **Open**, **Cancel**,
   and **Do not ask me again for this extension**. Until the developer selects **Open**, the
   extension receives nothing. Extension-development windows do not show the dialog, so the
   layer 3 tests must pre-accept it with the user setting `extensions.confirmedUriHandlerExtensionIds`,
   which the checkbox writes. Phase 3 must say in its sign-in prompt and its setup guide that VS
   Code asks once, and its timeout message must name this dialog as a likely cause.
3. **The redirect URI carries no window identity.** `vscode.env.asExternalUri` turns the redirect
   URI into `vscode://chtaylo3.backstage-validation-engine/sign-in?windowId=1`. Backstage refuses
   that URI unless the client document lists it exactly, and a document cannot list every window.
   Phase 3 therefore sends the fixed redirect URI and does not use `asExternalUri` for it. Which
   window receives the callback is D2.
4. **The extension keeps the server process itself.** With the function form of the server options
   in `vscode-languageclient` 11.0.0, `client.serverProcess` is `undefined`, and the client's
   two-second kill after a stop applies only to a process it knows. Phase 2 and Phase 3 keep the
   child process for `status().pid`, for stop, and for crash handling, as the probe did.
5. **Phase 4 treats a rejected token as the signal.** B6 shows that `expires_in` is a constant.
   The plan does not parse the token, so Phase 4 cannot use the token's own expiry either.
6. **Sign-out cannot end the access token at Backstage.** Revocation deletes the refresh session.
   The access token of that session stays valid until it expires (test case 7). Success criterion 8
   of the plan holds because the extension and the server drop the token, not because Backstage
   refuses it.
7. **A refresh token is not bound to the client.** A public client sends no credentials, so
   Backstage does not compare the client of a refresh with the client that received the token. A
   refresh with another `client_id` succeeded. The threat table of the plan relies on rotation and
   revocation only, which hold.
8. **Reuse of a rotated-out refresh token is refused, and the current token stays valid.**
   Backstage does not revoke the rotation chain when an old token is reused.
9. **A secret storage call can stay pending.** Without a keyring, `SecretStorage.store` did not
   finish within 45 seconds (V4). Phase 3 sets a time limit on its first secret storage call and
   reports the keyring as the likely cause. D4 shows what a developer sees on a real Linux desktop.
10. **Success criterion 3 can be tested.** `test-permissions.mjs` now denies `catalog.entity.read`
    for `user:bve-demo/bve-denied-user`, and the harness signs in two users whose tokens are valid
    at the same time.

## Evidence by question

The flow script performs the whole flow without a manual step. Its reports are
[`evidence/flow-1.55.3.json`](evidence/flow-1.55.3.json) and
[`evidence/flow-1.56.3.json`](evidence/flow-1.56.3.json), and the backend log facts are
[`evidence/host-1.55.3.json`](evidence/host-1.55.3.json) and
[`evidence/host-1.56.3.json`](evidence/host-1.56.3.json). Both releases gave the same answers. The
commands were:

```sh
npm run backstage:test:up -- --target=1.56.3 --run=oidc-1563-b
node test/integration/backstage/oidc/run.mjs --run=oidc-1563-b
npm run backstage:test:up -- --target=1.55.3 --run=oidc-1553-b
node test/integration/backstage/oidc/run.mjs --run=oidc-1553-b
```

`run.mjs` starts the client document service and restarts Backstage with a sign-in overlay: the
guest user is `user:bve-demo/alice`, and `auth.backstageTokenExpiration` is 15 minutes. It runs
`flow.mjs` in the test container, with a real Chromium driven through `editor/cdp.mjs`, and then
restores the application as `backstage:test:up` started it.

### B1: the vscode redirect URI

- Discovery returned the issuer `<public URL>/api/auth`, every endpoint on the same origin,
  `client_id_metadata_document_supported: true`, the auth method `none`, and the scope
  `offline_access`.
- The browser went to the guest sign-in page, then to the consent page at
  `/oauth2/authorize/<session>`. The consent page showed the client name and the redirect URI.
- After **Authorize**, the browser navigated to
  `vscode://chtaylo3.backstage-validation-engine/sign-in?code=<43 characters>&state=<22 characters>`.
  The `state` matched. The script read the code from the browser's navigation events
  (`Page.frameScheduledNavigation`, then `Page.frameRequestedNavigation` and
  `Page.frameStartedNavigating`), not from the approval response.

### B2: refresh tokens on SQLite

- The code exchange returned `access_token`, `id_token` (the same value), `refresh_token`
  (80 characters), `expires_in`, `scope: "openid offline_access"`, and `token_type: "Bearer"`.
- A refresh returned a new access token and a new refresh token. The new access token read the
  catalog.
- A refresh with the rotated-out token: HTTP 400, `invalid_grant`, `Invalid refresh token`. The
  current token still refreshed afterwards (test case 6).
- A refresh with another, unallowed `client_id`: HTTP 200 (decision 7).
- Revocation with an unallowed client ID: HTTP 401, `invalid_client`. Revocation with the client
  ID: HTTP 200 with an empty body. A refresh with the revoked token: HTTP 400, `Invalid refresh
token`.
- The access token of the revoked session still read the catalog (HTTP 200) and `userinfo`
  (HTTP 200) (test case 7).
- The backend logged the SQLite rotation warning on both releases.

### B3: the client metadata document

- The document server runs in the test image as the Compose service `client-document`, on HTTPS
  port 8443, with a certificate from a one-day test authority. The authority's private key is
  deleted after signing. Backstage trusts the authority through `NODE_EXTRA_CA_CERTS`.
- Backstage fetched `/vscode-client.json` twice per sign-in: once for `/v1/authorize` and once
  when the consent page read the session. It fetched it once more for each refused redirect URI,
  and not at all for a client ID that the configuration does not allow.

### B4: user token and userinfo

- The access token's claims were `iss`, `sub`, `aud`, `exp`, `iat`, and `uip`, with
  `sub: user:bve-demo/alice` and `aud: backstage`.
- `GET /api/auth/v1/userinfo`: HTTP 200,
  `{"claims":{"sub":"user:bve-demo/alice","ent":["user:bve-demo/alice","group:bve-demo/team-demo"]}}`.
- `GET /api/catalog/entities/by-name/component/bve-demo/demo-service` with the token: HTTP 200,
  `component:bve-demo/demo-service`. The component list returned two entities. Without a token:
  HTTP 401 (test case 1).

### B5: per-user permission decisions

- Before this phase, the test policy changed decisions only for the service subject
  `bve-filtered`, and the application had one user identity. Success criterion 3 could not be
  tested.
- The policy now also denies `catalog.entity.read` for `user:bve-demo/bve-denied-user`. Service
  decisions are unchanged.
- The harness signed in as `alice`, restarted Backstage with the guest user
  `user:bve-demo/bve-denied-user`, and signed in again. Both tokens were valid at the same time.
  `alice` read the entity (HTTP 200, two components). The denied user got HTTP 404 for the entity
  and an empty list. The backend logged `ALLOW` for `alice` and `DENY` for the denied user.

### B6: the reported expiry

With `auth.backstageTokenExpiration` at 15 minutes, the token lived 900 seconds (`exp - iat`) and
`expires_in` was 3600, for the code exchange and for every refresh. The auth backend source of both
releases returns `expiresIn: 3600` as a constant.

### Test cases 2 to 5

| Test case | Request                                                                            | Result on 1.55.3 and 1.56.3                                                                                                       |
| --------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 2         | Code exchange with a wrong verifier                                                | HTTP 400, `invalid_grant`, `Invalid code verifier`. The code was not burned: the correct verifier then succeeded                  |
| 3         | Second exchange of one code                                                        | HTTP 400, `invalid_grant`, `Authorization code already used`                                                                      |
| 4         | Redirect URI with `?windowId=1`, which the document does not list                  | HTTP 400 JSON, `Invalid redirect_uri '…sign-in?windowId=1', not registered in client metadata`. No `Location` header, no callback |
| 4         | Redirect URI of another extension, `vscode://other.publisher/sign-in`              | HTTP 400 JSON, `Invalid redirect_uri 'vscode://other.publisher/sign-in'`. No callback                                             |
| 4         | Loopback redirect URI, `http://127.0.0.1:43123/callback`                           | HTTP 400 JSON, `Invalid redirect_uri`. The configured pattern list replaced the loopback defaults                                 |
| 5         | Client ID `https://client-document:8443/unlisted-client.json`, not in the patterns | HTTP 400 JSON, `Invalid client_id`. Backstage did not fetch the document                                                          |

### V1: a link through --open-url

The editor evidence of V1 to V4 is [`evidence/editor-probe-linux.json`](evidence/editor-probe-linux.json):
the case states, the probe observations, and the fourth-pipe digests of each local run, and the
remote observations of the SSH runs (`run1-without-consent`, `run2-consent-by-setting`, and
`final`). The local runs used:

```sh
BVE_VSCODE_VERSIONS=1.145.2 xvfb-run -a node scripts/test-extension.mjs --case=startup,restart,shutdown,server-crash,probe-pipe,probe-uri,probe-secret,open-url
BVE_VSCODE_VERSIONS=1.106.3 xvfb-run -a node scripts/test-extension.mjs --case=startup,restart,shutdown,server-crash,probe-pipe,probe-uri,probe-secret,open-url
xvfb-run -a node scripts/test-extension-remote.mjs --mode=ssh-remote --ssh-network=published
```

in a copy of the checkout with `spike/oidc-phase-1/probe.patch` applied, which is what
`node spike/oidc-phase-1/run-probe.mjs --local` and `--remote=<network>` do. On this machine the
editor needed a writable runtime directory with a short path and its own D-Bus session, because
the inherited `XDG_RUNTIME_DIR` was not writable. The hosted runners need neither.

The kept harness function `openUrl` in `scripts/extension-test-cli.mjs` gives a link to the
running test editor with `--open-url` and the editor's `--user-data-dir`. The probe build of the
extension registers a URI handler (see [the probe](#the-probe)).

- **Linux, VS Code 1.145.2 and 1.106.3 (local, Xvfb):** a link to
  `vscode://chtaylo3.backstage-validation-engine/sign-in?probe=<nonce>` reached the product's
  handler exactly once, after 267 ms and 548 ms, with the query unchanged. The kept case
  `open-url` (test case 8) passed on both editors: the driver's link arrived once, and a link
  for the product did not reach the driver.
- These windows are extension-development windows. VS Code showed no consent dialog in them
  (decision 2).
- **Windows and macOS: pending** the hosted probe workflow.

### V2: a link to the extension on the SSH host

Through the SSH fixture (`scripts/test-extension-remote.mjs --mode=ssh-remote
--ssh-network=published`, with the probe), with the product running in the remote extension host:

- **Without consent (run 1):** the link reached the remote window, and VS Code showed **Allow
  'Backstage Validation Engine' extension to open this URI?** with
  `vscode://chtaylo3.backstage-va...`, **Cancel**, **Open**, and **Do not ask me again for this
  extension**. Nothing reached the handler in 30 seconds, on 1.106.3 and on 1.145.2.
- **With consent given through `extensions.confirmedUriHandlerExtensionIds` (run 2):** the link
  reached the handler in the remote extension host (`remoteName: ssh-remote`) exactly once, after
  679 ms (1.106.3) and 524 ms (1.145.2), with the query unchanged.
- In the remote window, `asExternalUri` of the redirect URI returned `…/sign-in?windowId=1`
  (decision 3).

### V3: a fourth pipe to the server

The probe starts the packaged runtime with `stdio: ['pipe', 'pipe', 'pipe', 'pipe']`, writes a
synthetic value of 52 bytes to the fourth pipe, and a preload in the server reads file descriptor 3
with `net.Socket` and records its length and SHA-256.

- **Linux, VS Code 1.145.2 and 1.106.3:** the server received the value unchanged at start and
  after a restart (digests matched).
- With the function form of the server options, `client.serverProcess` stayed `undefined`, and
  the existing cases failed at setup with `Running packaged server must expose its PID`.
- With the extension keeping the child process (and its own kill two seconds after a stop), the
  existing cases `startup`, `restart`, `shutdown`, and `server-crash` passed on both editors.
- **Windows (`node.exe`) and macOS: pending** the hosted probe workflow.

### V4: secret storage from a local window in a remote window

Through the SSH fixture, while the remote window ran, the host opened a local window in the same
editor with `--new-window`. The product in the local window stored a synthetic value. The remote
case recorded what the product in the SSH host saw.

- **With `--password-store=basic` (final run):** before the local write, the remote window read no
  value. After it, the remote window saw exactly one change event for the key, and read a value
  whose SHA-256 equals the value that the local window stored. The same on 1.106.3 and 1.145.2.
- **Without a keyring and without `--password-store=basic` (runs 3 to 5):** the local window
  activated and found the value to store, but `SecretStorage.store` neither resolved nor rejected
  within 45 seconds. The remote window saw nothing. Nothing on screen was captured for the local
  window, so the cause is not observed. A missing keyring is the likely cause: the runner has no
  keyring service, and the basic store fixed it. D4 measures this on a real Linux desktop.
- **Consequence for Phase 3 and Phase 4:** a `SecretStorage` call can stay pending. The checks
  before sign-in need a time limit on the first secret storage call, and its error names the
  keyring. Phase 4 can keep one session for all windows of a profile, because the change event
  reaches a remote window.

### V5: the macOS open command

**Pending.** The hosted probe workflow runs `open vscode://…` on `macos-15` while the test editor
runs, and records whether the editor's handler receives the link. macOS has evidence of layers 1
to 3 only after that run; it has no layer 4 evidence, because nobody runs the desktop checks on
macOS.

## Pending questions

| Question                      | Who answers it      | How                                                                                                                                                               |
| ----------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1, V3 on Windows and macOS   | The hosted workflow | A push to a branch named `spike/oidc-phase-1*` runs `oidc-phase-1-probe.yml`; job **Editor probe**, artifacts `oidc-probe-windows-2025` and `oidc-probe-macos-15` |
| V5                            | The hosted workflow | The same run, job **Editor probe / macos-15**, folder `darwin-open-command`                                                                                       |
| V2, V4 on the hosted runner   | The hosted workflow | The same run, job **SSH fixture probe**, artifact `oidc-probe-ssh`                                                                                                |
| B1 to B6 on the hosted runner | The hosted workflow | The same run, job **Backstage sign-in flow**, artifacts `oidc-flow-1.55.3` and `oidc-flow-1.56.3`                                                                 |
| D1 to D5                      | The owner, by hand  | [The desktop procedure](phase-1-desktop-procedure.md), returned as `phase-1-desktop-observations.md`                                                              |

## The probe

The probe is throwaway and is never merged. It lives in `spike/oidc-phase-1/`:
`probe.patch` changes the extension, three probe cases, and the two editor harness scripts in a
temporary copy of the checkout, and `run-probe.mjs` builds and runs it. The workflow
`.github/workflows/oidc-phase-1-probe.yml` runs it on the hosted runners on dispatch only. Remove
all three with the spike branch.

## Kept harness changes

- The test applications install `@backstage/plugin-auth` (0.1.12 for 1.55.3, 0.1.13 for 1.56.3),
  and `app-config.test.yaml` enables client ID metadata documents and refresh tokens. The four
  static tokens are unchanged. The development release suite passed on both releases afterwards:
  118 of 118 cases.
- `test/integration/backstage/oidc/`: the client document server, the flow script, and the host
  runner, with `--serve` and `--restore` for runs by hand.
- `test/integration/backstage/editor/cdp.mjs`: a small Chromium driver.
- `scripts/extension-test-cli.mjs`: `openUrl` and the request server that cases use to ask the host
  for a link, with the installed-editor case `open-url` and a unit test.

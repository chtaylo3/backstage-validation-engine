# Phase 1: Feasibility record

Read [the plan overview](README.md) and [Phase 1](phase-1-feasibility.md) first.

This record answers the questions of Phase 1 with the evidence that supports each answer. It
records what was observed, and where: on which Backstage release, runner, desktop, and topology.
An answer is no stronger than its evidence. A question that nobody has answered yet is marked
**pending**, with the person or workflow that answers it.

The evidence comes from three places:

- **The implementer's machine:** Linux on WSL 2 (kernel 6.6.87.2), Docker 29.9.2, Node 24.22.1,
  on 2026-11-14. The editor runs used Xvfb, a private `XDG_RUNTIME_DIR` with a short path, and a
  private D-Bus session (`dbus-run-session`), because the inherited runtime directory was not
  writable. They also removed the inherited `ELECTRON_*` and `VSCODE_*` variables. Results from
  this machine are marked **local**.
- **Hosted probe run 1** (run 43641731276, commit `c5307f8`) on the GitHub-hosted
  `ubuntu-24.04`, `windows-2025`, and `macos-15` runners. Its summary is
  [`evidence/hosted-run-43641731276.json`](evidence/hosted-run-43641731276.json).
- **Hosted probe run 2** (run 43645632753, commit `0c9c239`, with the kept changes of `581bcd6`)
  on the same runners. Its summary is
  [`evidence/hosted-run-43645632753.json`](evidence/hosted-run-43645632753.json). The CI run of the
  same commit (43645632772) was green, including the installed-editor jobs on all three runners.

Results from the hosted runs are marked **hosted run 1** or **hosted run 2**. Each hosted result
comes from one run, so it is no evidence against flakiness.

No token, authorization code, PKCE verifier, or refresh token that Backstage issued appears in this
record or in its evidence files.

## Answers

| ID  | Layer | Answer                                                                                                                                                                             | Where it was observed                                                                                        | Details                                                         |
| --- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| B1  | 2     | **Yes.** Backstage accepts the `vscode://` redirect URI, and the browser follows it after consent.                                                                                 | Compose applications 1.55.3 and 1.56.3: local, hosted runs 1 and 2                                           | [B1](#b1-the-vscode-redirect-uri)                               |
| B2  | 2     | **Yes, with limits.** Issue, rotation, refusal of a rotated-out token, and revocation work on SQLite. The limits are in [decisions 6 to 8](#decisions-that-follow).                | 1.55.3 and 1.56.3: local, hosted runs 1 and 2                                                                | [B2](#b2-refresh-tokens-on-sqlite)                              |
| B3  | 2     | **Yes.** An HTTPS document server on the Compose network works, with an exact client ID pattern and a trusted test authority.                                                      | 1.55.3 and 1.56.3: local, hosted runs 1 and 2                                                                | [B3](#b3-the-client-metadata-document)                          |
| B4  | 2     | **Yes.** The catalog accepts the token as the user, and `userinfo` returns the user entity reference.                                                                              | 1.55.3 and 1.56.3: local, hosted runs 1 and 2                                                                | [B4](#b4-user-token-and-userinfo)                               |
| B5  | 2     | **No before this phase; yes after it.** The policy acted only on service principals. It now denies one user, and the other user is unaffected.                                     | 1.55.3 and 1.56.3: local, hosted runs 1 and 2                                                                | [B5](#b5-per-user-permission-decisions)                         |
| B6  | 2     | **No, for the one lifetime tested.** With a 900-second token, `expires_in` was 3600.                                                                                               | 1.55.3 and 1.56.3: local, hosted runs 1 and 2                                                                | [B6](#b6-the-reported-expiry)                                   |
| V1  | 3     | **Yes, with `--no-sandbox` on Linux.** In hosted run 2 the link reached the handler once on all three runners and both editors. Without `--no-sandbox`, nothing arrived on Ubuntu. | Hosted run 2: `ubuntu-24.04`, `windows-2025`, `macos-15`; local Linux                                        | [V1](#v1-a-link-through---open-url)                             |
| V2  | 3     | **Yes, with test settings.** The link reached the handler in the SSH host once, with the URI consent pre-accepted by a user setting. Without that consent, nothing arrived.        | Hosted run 2 (SSH fixture on `ubuntu-24.04`); local SSH fixture                                              | [V2](#v2-a-link-to-the-extension-on-the-ssh-host)               |
| V3  | 3     | **Yes, with a change.** The fourth pipe works, but the language client then leaves `serverProcess` unset, so the extension must keep the child process itself.                     | Local Linux; hosted `ubuntu-24.04`, `windows-2025` (`node.exe`), and `macos-15`; VS Code 1.106.3 and 1.145.2 | [V3](#v3-a-fourth-pipe-to-the-server)                           |
| V4  | 3     | **Yes, with test settings.** The SSH window read the value that a local window stored, and saw one change event, with `--password-store=basic` and the consent setting in force.   | Hosted run 2 (SSH fixture on `ubuntu-24.04`); local SSH fixture                                              | [V4](#v4-secret-storage-from-a-local-window-in-a-remote-window) |
| V5  | 3     | **No.** `open vscode://…` found no application for the scheme. The downloaded test editor is not registered with macOS.                                                            | Hosted runs 1 and 2: `macos-15`, VS Code 1.106.3 and 1.145.2                                                 | [V5](#v5-the-macos-open-command)                                |
| D1  | 4     | **Pending:** the owner runs it.                                                                                                                                                    | —                                                                                                            | [Pending questions](#pending-questions)                         |
| D2  | 4     | **Pending:** the owner runs it.                                                                                                                                                    | —                                                                                                            | [Pending questions](#pending-questions)                         |
| D3  | 4     | **Pending:** the owner runs it.                                                                                                                                                    | —                                                                                                            | [Pending questions](#pending-questions)                         |
| D4  | 4     | **Pending:** the owner runs it.                                                                                                                                                    | —                                                                                                            | [Pending questions](#pending-questions)                         |
| D5  | 4     | **Pending:** the owner runs it.                                                                                                                                                    | —                                                                                                            | [Pending questions](#pending-questions)                         |

### Evidence for macOS, by layer

- **Layer 1:** no new evidence from this phase. The existing `ci.yml` jobs run the unit and client
  tests on `macos-15`.
- **Layer 2:** none. The Backstage flow runs on Linux only.
- **Layer 3 (hosted `macos-15`):** V1 delivered the link once on both editors in both hosted runs
  (all four CLI variants in run 2), and the kept case `open-url` passed. V3 passed. V5 failed to
  reach the test editor in both runs. V2 and V4 do not run on macOS: the SSH fixture runs on
  Ubuntu.
- **Layer 4:** none. Nobody runs the desktop checks on macOS.

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
  entry. Backstage then skips its check that the document's host has a public address. The auth
  backend of 1.55.3 and 1.56.3 accepts an `http:` client ID only for `localhost` with
  `NODE_ENV=development` (from its source, `CimdClient.cjs.js`, `validateCimdUrl`; not tested).
- **The Backstage backend must trust the certificate of the document's host.** In the tests, the
  backend received `NODE_EXTRA_CA_CERTS` with the test authority.
- **Refresh tokens** need the user entity in the catalog (from the source, `OfflineAccessService`;
  the tests sign in as a catalog user, so the refusal itself was not observed). Backstage logs on
  startup that SQLite cannot fully protect concurrent rotation (observed).

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
- The redirect URI must be listed exactly, without a query. A request with `?windowId=1` added is
  refused with `not registered in client metadata` (test case 4).
- The document must not contain `client_secret`, and `token_endpoint_auth_method` must not name a
  secret method (from the source; not tested).

### A proxy or a private certificate authority

- **Backstage side (observed):** the backend fetches the client document. Its host certificate must
  be trusted by the backend, through `NODE_EXTRA_CA_CERTS` or a public authority.
- **Desktop and remote side: pending D3.** The browser reaches Backstage from the desktop. The
  extension host and the packaged runtime reach it from the desktop, WSL, or the Coder workspace.
  D3 measures, for each topology, whether both reach an HTTPS Backstage under the URL that the
  browser uses, and which of `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`, and the VS Code setting
  `http.proxy` each side needs. Success criterion 4 is open until D3 is recorded.

## Decisions that follow

1. **Nothing observed requires the companion extension.** B1 holds on both releases. V1 holds on
   all three hosted runners in one run, and V2 and V4 hold on the hosted SSH fixture with test
   settings (see [what layer 3 shows](#what-layer-3-shows-and-does-not-show)). The choice is
   still the owner's, after D1 shows that a real browser hands the redirect to VS Code on the
   owner's desktops.
2. **VS Code asks before it gives a link to an extension.** On the local SSH fixture, in a normal
   (not extension-development) window, VS Code showed **Allow 'Backstage Validation Engine'
   extension to open this URI?** with **Open**, **Cancel**, and **Do not ask me again for this
   extension**, on 1.106.3 and 1.145.2. Until the developer selects **Open**, the extension
   receives nothing. Extension-development windows did not show the dialog. A layer 3 test in a
   normal window must pre-accept it with the user setting `extensions.confirmedUriHandlerExtensionIds`,
   which the checkbox writes. Phase 3 must say in its sign-in prompt and its setup guide that VS
   Code asks once, and its timeout message must name this dialog as a likely cause.
3. **The redirect URI carries no window identity.** `vscode.env.asExternalUri` turned the redirect
   URI into `vscode://chtaylo3.backstage-validation-engine/sign-in?windowId=1`: in the local SSH
   window, and in the local windows of all three hosted runners. Backstage refuses that URI unless
   the client document lists it exactly, and a document cannot list every window. Phase 3 therefore
   sends the fixed redirect URI and does not use `asExternalUri` for it. Which window receives the
   callback is D2.
4. **The extension keeps the server process itself.** With the function form of the server options
   in `vscode-languageclient` 11.0.0, `client.serverProcess` stayed `undefined` on the local
   machine and on all three hosted runners, and the client's two-second kill after a stop applies
   only to a process it knows. Phase 2 and Phase 3 keep the child process for `status().pid`, for
   stop, and for crash handling, as the probe did.
5. **Phase 4 treats a rejected token as the signal.** With a 900-second token, `expires_in` was
   3600, and the source returns 3600 as a constant (see B6). The plan does not parse the token, so
   Phase 4 cannot use the token's own expiry either.
6. **Sign-out does not end the access token at Backstage.** Revocation deletes the refresh session.
   The access token of that session still read the catalog and `userinfo` immediately after the
   revocation (test case 7). Whether it stays valid until it expires was not tested. Success
   criterion 8 of the plan must therefore hold because the extension and the server drop the token,
   not because Backstage refuses it.
7. **A refresh token is not bound to the client, and reuse does not end the chain.** A public client
   sends no credentials, so Backstage does not compare the client of a refresh with the client that
   received the token: a refresh with another `client_id` succeeded. A refresh with a rotated-out
   token was refused, and the current token still worked (decision 8). Together: a thief who
   refreshes a stolen token first gets a valid chain, and the victim's next refresh is refused.
   **Nothing tested whether the victim can then end the thief's chain.** The source of revocation
   (`OfflineAccessService.cjs.js`, lines 197 to 205, in auth backend 0.30.1 and 0.30.2) deletes the
   session that the token's identifier names without checking the token's hash, which suggests that
   an old token can revoke the chain; this is not verified. The plan overview's threat-table row for
   a stolen refresh token ("Backstage rotates the token on every use. Sign-out revokes it") is
   therefore **not shown to hold**. See [changes for later phases](#changes-for-later-phases-and-for-the-owner).
8. **Reuse of a rotated-out refresh token is refused, and the current token stays valid.**
   Backstage does not revoke the rotation chain when an old token is reused.
9. **Success criterion 3 can be tested.** `test-permissions.mjs` now denies `catalog.entity.read`
   for `user:bve-demo/bve-denied-user`, and the harness signs in two users whose tokens are valid
   at the same time.

## Changes for later phases and for the owner

These follow from the answers. The plan overview's decisions are unchanged; the owner decides.

- **Threat table (owner):** the row for a stolen refresh token is not shown to hold (decision 7).
  Phase 4 should test whether a victim's revocation, with the victim's rotated-out token, ends the
  thief's chain, and the owner should decide whether that is enough or whether the companion
  extension's argument (the refresh token never leaves the desktop) gains weight.
- **Phase 2 and Phase 3:** the extension keeps the server child process (decision 4).
- **Phase 3:** the consent dialog (decision 2), the fixed redirect URI without `asExternalUri`
  (decision 3).
- **Phase 4:** a rejected token is the expiry signal (decision 5); sign-out does not end the access
  token at Backstage (decision 6); reuse does not end the chain (decisions 7 and 8).
- **Phase 3 and Phase 5 (layer 3 tests):** start the process that hands the link to the editor with
  `--no-sandbox` on Linux, as `openUrl` now does, and keep the link as the last argument (see the
  Windows hypothesis in V1). In a normal window, pre-accept the URI consent with
  `extensions.confirmedUriHandlerExtensionIds`. The kept case `open-url` stays out of the default
  installed-editor selection until Phase 3 decides that it joins it.
- **Phase 5:** the test guest must be a catalog user for refresh.

## Evidence by question

The flow script performs the whole flow without a manual step, and fails when an expected refusal
does not happen, when `state` does not match, or when a step is missing. Its local reports are
[`evidence/flow-1.55.3.json`](evidence/flow-1.55.3.json) and
[`evidence/flow-1.56.3.json`](evidence/flow-1.56.3.json), with the backend log facts in
[`evidence/host-1.55.3.json`](evidence/host-1.55.3.json) and
[`evidence/host-1.56.3.json`](evidence/host-1.56.3.json). These local reports were made before the
script asserted its expectations; its current expectations hold for them and for the reports of
hosted run 1. The hosted job **Backstage sign-in flow** reproduced every answer of B1 to B6 on both
releases in both hosted runs. In hosted run 2 the script asserted its expectations, and none was
unmet on either release. Both releases gave the same answers. The local commands were:

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
- The access token of the revoked session read the catalog (HTTP 200) and `userinfo` (HTTP 200)
  immediately after the revocation (test case 7).
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
`expires_in` was 3600, for the code exchange and for every refresh, locally and hosted. Only this
one lifetime was tested. The source returns the value as a constant: `expiresIn: 3600` in
`dist/service/OidcService.cjs.js` of `@backstage/plugin-auth-backend` 0.30.1 and 0.30.2, line 455
(code exchange) and line 473 (refresh).

### Test cases 2 to 5

| Test case | Request                                                                            | Refused by                                          | Result on 1.55.3 and 1.56.3                                                                                                       |
| --------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 2         | Code exchange with a wrong verifier                                                | The token endpoint                                  | HTTP 400, `invalid_grant`, `Invalid code verifier`. The code was not burned: the correct verifier then succeeded                  |
| 3         | Second exchange of one code                                                        | The token endpoint                                  | HTTP 400, `invalid_grant`, `Authorization code already used`                                                                      |
| 4         | Redirect URI with `?windowId=1`, which the document does not list                  | The client document (the pattern ignores the query) | HTTP 400 JSON, `Invalid redirect_uri '…sign-in?windowId=1', not registered in client metadata`. No `Location` header, no callback |
| 4         | Redirect URI of another extension, `vscode://other.publisher/sign-in`              | The configured redirect patterns                    | HTTP 400 JSON, `Invalid redirect_uri 'vscode://other.publisher/sign-in'`. No `Location` header, no callback                       |
| 4         | Loopback redirect URI, `http://127.0.0.1:43123/callback`                           | The configured redirect patterns                    | HTTP 400 JSON, `Invalid redirect_uri 'http://127.0.0.1:43123/callback'`. The configured list replaced the loopback defaults       |
| 5         | Client ID `https://client-document:8443/unlisted-client.json`, not in the patterns | The configured client ID patterns                   | HTTP 400 JSON, `Invalid client_id`. Backstage did not fetch the document                                                          |

The attribution for test case 4 follows from the messages: the pattern check fails with
`Invalid redirect_uri '<uri>'`, and the document check fails with `…, not registered in client
metadata`.

### V1: a link through --open-url

The kept harness function `openUrl` in `scripts/extension-test-cli.mjs` gives a link to the
running test editor with `--open-url` and the editor's `--user-data-dir`, through the editor's
native CLI. The CLI starts a second editor process, which hands the link to the running one. The
probe build of the extension registers a URI handler (see [the probe](#the-probe)). The local and
hosted windows of V1 are extension-development windows; VS Code showed no consent dialog in them.

**Hosted run 2.** Each case tried four ways to call the CLI, each with its own link, and recorded
the deliveries to the product's handler, the CLI's exit code and output, and the number of log
sessions in the test profile before and after the call. A new log session means that the CLI's
editor process started with the test profile. Deliveries, with the time to the first delivery:

| Runner         | Editor  | Harness default (`--no-sandbox`) | Sandboxed, `--verbose` | `--no-sandbox --verbose` | `--no-sandbox --verbose --open-url -- <link>` |
| -------------- | ------- | -------------------------------- | ---------------------- | ------------------------ | --------------------------------------------- |
| `ubuntu-24.04` | 1.106.3 | 1 (502 ms)                       | **0**                  | 1 (552 ms)               | 1 (523 ms)                                    |
| `ubuntu-24.04` | 1.145.2 | 1 (312 ms)                       | **0**                  | 1 (299 ms)               | 1 (325 ms)                                    |
| `windows-2025` | 1.106.3 | 1 (654 ms)                       | 1 (748 ms)             | 1 (764 ms)               | 1 (770 ms)                                    |
| `windows-2025` | 1.145.2 | 1 (490 ms)                       | 1 (434 ms)             | 1 (429 ms)               | 1 (414 ms)                                    |
| `macos-15`     | 1.106.3 | 1 (692 ms)                       | 1 (815 ms)             | 1 (1282 ms)              | 1 (753 ms)                                    |
| `macos-15`     | 1.145.2 | 1 (1034 ms)                      | 1 (807 ms)             | 1 (869 ms)               | 1 (595 ms)                                    |

- Every delivering call added one log session. The sandboxed call on Ubuntu exited with code 0
  and empty output, and added no log session: its editor process never started with the test
  profile.
- The kept case `open-url` passed on all three runners and both editors: the driver's link
  arrived once, and a link for the product did not reach the driver.
- In every case, `vscode.env.asExternalUri` of the redirect URI returned `…/sign-in?windowId=1`
  (decision 3).

**Hosted run 1, with the earlier `openUrl`** (arguments `--open-url <link> --user-data-dir <profile>
--extensions-dir <extensions>`, without `--no-sandbox`): nothing was delivered on `ubuntu-24.04`
and `windows-2025`, on both editors, although the CLI call reported success. On `macos-15` the link
was delivered once (1506 ms on 1.106.3, 804 ms on 1.145.2). On all three runners every case left
exactly one log session, so the CLI's editor process never started with the test profile, also on
macOS, where the link still reached the running editor.

**The cause on Ubuntu is confirmed:** the Chromium sandbox of the CLI's editor process. Ubuntu
24.04 restricts the unprivileged user namespaces that the sandbox of a downloaded editor needs;
every other editor process of the harness already ran with `--no-sandbox`. In run 2, only the
sandboxed call failed, and every call with `--no-sandbox` delivered.

**The cause on Windows is not identified.** In run 2 all four calls delivered on Windows, the
sandboxed one included, so the sandbox was not the Windows cause. Between the two runs, `openUrl`
called the CLI in the same way (`runCli`, with the same environment, the same piped output, and
the same wait for the CLI's exit); only its arguments changed. **Hypothesis:** in run 1 the link
came before `--user-data-dir` and `--extensions-dir`, and on Windows the editor process did not
apply the options that followed the link, so it did not address the test editor. Run 2 puts the
link last in every variant. Support: the argument order is the only change common to all four
delivering variants on Windows; in run 1 no CLI call left a log session in the test profile on
Windows or macOS; and the local Linux runs, where the earlier order delivered and added log
sessions, show that the order did not matter on Linux. Not shown: no log of the CLI's editor
process in run 1 exists, and no run put the link before the options with everything else unchanged.

**Local (the implementer's machine, VS Code 1.145.2 and 1.106.3):** with the earlier `openUrl`, a
link reached the product's handler exactly once, after 267 ms and 548 ms, with the query unchanged,
and the kept case `open-url` passed on both editors. With the current `openUrl`, all four variants
delivered once on 1.145.2 (280 ms to 325 ms), each with one new log session.

The kept case `open-url` stays out of the default installed-editor selection and runs only when
named (`--case=open-url`). It passed on all three hosted runners in one run. One run is no evidence
against flakiness, and Phase 3 decides when the case joins the default selection.

The local runs used these commands, in a copy of the checkout with `spike/oidc-phase-1/probe.patch`
applied (as `node spike/oidc-phase-1/run-probe.mjs --local` does):

```sh
BVE_VSCODE_VERSIONS=1.145.2 xvfb-run -a node scripts/test-extension.mjs --case=startup,restart,shutdown,server-crash,probe-pipe,probe-uri,probe-secret,open-url
BVE_VSCODE_VERSIONS=1.106.3 xvfb-run -a node scripts/test-extension.mjs --case=startup,restart,shutdown,server-crash,probe-pipe,probe-uri,probe-secret,open-url
xvfb-run -a node scripts/test-extension-remote.mjs --mode=ssh-remote --ssh-network=published
```

The local editor evidence is [`evidence/editor-probe-linux.json`](evidence/editor-probe-linux.json).
It is **curated**: a script assembled it from the run directories of earlier probe versions, not
the committed probe. Its `curation` field names the environment, the keys that the script added
(the case lists and the dialog text), and, for each run, the fields that differ from what the
committed probe writes.

### V2: a link to the extension on the SSH host

Through the SSH fixture, with the product running in the remote extension host:

- **Local, without consent (run 1):** the link reached the remote window, and VS Code showed
  **Allow 'Backstage Validation Engine' extension to open this URI?** with
  `vscode://chtaylo3.backstage-va...`, **Cancel**, **Open**, and **Do not ask me again for this
  extension**. Nothing reached the handler in 30 seconds, on 1.106.3 and on 1.145.2.
- **Local, with consent given through `extensions.confirmedUriHandlerExtensionIds`:** in each run
  that the curated evidence keeps (run 2, run 5, and the final run), the link reached the handler in
  the remote extension host (`remoteName: ssh-remote`) exactly once, in 478 ms to 787 ms, with the
  query unchanged.
- **Hosted run 2 (`ubuntu-24.04`, `--ssh-network=host`), with the consent setting and
  `--password-store=basic` in force, and `--no-sandbox` on the CLI calls:** the link reached the
  handler in the remote extension host (`remoteName: ssh-remote`) exactly once, after 750 ms
  (1.106.3) and 524 ms (1.145.2), with the query unchanged. The CLI call added one log session in
  the desktop profile. The probe runner now fails the job unless V2 and V4 hold; it reported no
  failure, and the four cases of the SSH fixture passed.
- **Hosted run 1**, with the earlier `openUrl` and without `--no-sandbox`: 0 deliveries on both
  editors. The desktop logs of each editor show two log sessions, one per stage, each with one
  window, and no session from the CLI call: the cause of V1 on Ubuntu. That job passed only because
  the probe runner did not then check the remote observations.
- **What these settings mean:** the consent setting stands in for a developer who selects **Open**
  and **Do not ask me again**. A developer's desktop shows the dialog on the first callback
  (decision 2).

### V3: a fourth pipe to the server

The probe starts the packaged runtime with `stdio: ['pipe', 'pipe', 'pipe', 'pipe']`, writes a
synthetic value of 52 bytes to the fourth pipe, and a preload in the server reads file descriptor 3
with `net.Socket` and records its length and SHA-256.

- **Local Linux and hosted `ubuntu-24.04`, `windows-2025` (runtime `node.exe`), and `macos-15`,
  VS Code 1.106.3 and 1.145.2:** the server received the value unchanged at start and after a
  restart (digests matched).
- With the function form of the server options, `client.serverProcess` stayed `undefined`
  everywhere. In the first local run, without the probe's own reference, the existing cases failed
  at setup with `Running packaged server must expose its PID`.
- With the extension keeping the child process (and its own kill two seconds after a stop), the
  existing cases `startup`, `restart`, `shutdown`, and `server-crash` passed on both editors,
  locally and on all three hosted runners.

### V4: secret storage from a local window in a remote window

Through the SSH fixture, while the remote window ran, the host opened a local window in the same
editor with `--new-window`. The product in the local window stored a synthetic value. The remote
case recorded what the product in the SSH host saw.

- **Local, with `--password-store=basic` (final run):** before the local write, the remote window
  read no value. After it, the remote window saw exactly one change event for the key, and read a
  value whose SHA-256 equals the value that the local window stored. The same on 1.106.3 and
  1.145.2.
- **Hosted run 2 (`ubuntu-24.04`), with `--password-store=basic` and the consent setting in force,
  and `--no-sandbox` on the CLI calls:** the local window activated, found the value, and stored it.
  Before the local write, the remote window read no value. After it, the remote window saw exactly
  one change event and read a value whose SHA-256 equals the stored value. The same on 1.106.3 and
  1.145.2.
- **Hosted run 1:** not answered. The product wrote no activation note in a local window, and the
  desktop logs show no second window: the `--new-window` call failed in the same way as V1.
- **What these settings mean:** `--password-store=basic` replaces the operating system's keyring
  with VS Code's basic store, because the runner has no keyring. A developer's desktop normally uses
  its keyring, which V4 does not exercise; D4 looks at it.
- **An unexplained local observation, not an answer:** in local run 5, without
  `--password-store=basic`, the local window activated and found the value to store, but
  `SecretStorage.store` neither resolved nor rejected within 45 seconds; the curated evidence keeps
  that run's observations (`run5-without-password-store`). Nothing on screen was captured, so the
  cause is not known. D4 looks at secret storage without a keyring on a real Linux desktop.
- The local half (the product stores, reads back, and sees its own change event in a local
  extension-development window) passed locally and on all three hosted runners.

### V5: the macOS open command

On hosted `macos-15`, in both hosted runs, the probe ran
`open vscode://chtaylo3.backstage-validation-engine/sign-in?…` while the test editor ran. `open`
exited with code 1 and `No application knows how to open URL vscode://…`
(`kLSApplicationNotFoundErr`, `NSOSStatusErrorDomain` code -10814) on both editors, and nothing was
delivered.
macOS has no application registered for the scheme on the runner, and the downloaded test editor
does not register one. The `open` command therefore does not replace layer 4 on macOS.

## What layer 3 shows and does not show

Layer 3 now shows, on the hosted runners in one run each:

- A `vscode://` link that the test gives to the running test editor through its CLI with
  `--open-url` reaches the URI handler of the addressed extension exactly once, unchanged, on
  Ubuntu, Windows, and macOS, with both pinned editors (V1). A link for another extension does not
  reach that handler (`open-url`).
- On Linux this needs `--no-sandbox` on the CLI call.
- The same holds when the extension runs in the remote host of the SSH fixture on Ubuntu, once the
  URI consent is accepted (V2), and a value that a local window stores in `SecretStorage` reaches
  the remote window with a change event, with the basic secret store (V4).
- The fourth pipe works on all three runners, with the change of decision 4 (V3).

Layer 3 does not show:

- that an operating system or a browser hands a `vscode://` link to VS Code: the test gives the
  link to the CLI itself, and on macOS the `open` command did not reach the test editor (V5). That
  is layer 4 (D1);
- what a developer sees in a normal local window, where VS Code asks for consent: the local windows
  of V1 are extension-development windows, and the remote window of V2 had the consent pre-accepted;
- the WSL and Coder topologies, or a remote host other than the SSH fixture;
- secret storage with a real keyring (V4 used the basic store);
- that the results repeat: each comes from one hosted run;
- the cause of the Windows failure in hosted run 1 (V1).

## Success criteria

1. Every question has a recorded answer: **met for B1 to B6 and V1 to V5; pending for D1 to D5**,
   which the owner runs. V2 and V4 are answered with test settings, and V2 and V4 ran on Ubuntu
   only, where the SSH fixture runs.
2. The redirect URI and the exact `allowedRedirectUriPatterns` value: **met.**
3. The complete client metadata document: **met.**
4. Proxy and private certificate authority: **pending D3.**
5. The harness script completes the whole flow on both releases without a manual step: **met**,
   locally and hosted.
6. The procedure by hand followed by the owner without help: **pending the owner.**
7. macOS layers: **met** (see [evidence for macOS](#evidence-for-macos-by-layer)).
8. The existing release tests pass with the changed applications: **met on the implementer's
   machine only.** The development release suite passed 118 of 118 cases on both releases; its
   summary is [`evidence/backstage-development-suite.json`](evidence/backstage-development-suite.json).
   It is a development-mode run with uncommitted inputs and a scratch copy of the VSIX without two
   third-party lock files, so it cannot qualify a release, and no hosted run of the suite exists.
   The isolated permission regression `permissions.mjs` passed locally. The H4 focused controls
   were not run: they refuse an uncommitted tree.
9. No issued token in the record, the logs, or the evidence: **met.**

## Pending questions

| Question | Who answers it     | How                                                                                                  |
| -------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| D1 to D5 | The owner, by hand | [The desktop procedure](phase-1-desktop-procedure.md), returned as `phase-1-desktop-observations.md` |

## The probe

The probe is throwaway and is never merged. It lives in `spike/oidc-phase-1/`: `probe.patch`
changes the extension, adds three probe cases, and changes three editor harness scripts in a
temporary copy of the checkout, and `run-probe.mjs` builds and runs it and checks the remote
observations. The workflow `.github/workflows/oidc-phase-1-probe.yml` runs it on the hosted runners
on every push to a branch named `spike/oidc-phase-1*`, and on dispatch once the file is on the
default branch. Remove all three with the spike branch.

## Kept harness changes

- The test applications install `@backstage/plugin-auth` (0.1.12 for 1.55.3, 0.1.13 for 1.56.3),
  and `app-config.test.yaml` enables client ID metadata documents and refresh tokens. The four
  static tokens are unchanged.
- `test/integration/backstage/oidc/`: the client document server, the flow script with its
  expectations, and the host runner, with `--serve` and `--restore` for runs by hand.
- `test/integration/backstage/editor/cdp.mjs`: a small Chromium driver.
- `scripts/extension-test-cli.mjs`: `openUrl`, which passes `--no-sandbox`, puts the link last, and
  records the CLI's evidence, and the request server that cases use to ask the host for a link.
  The installed-editor case `open-url` runs only when named, and a unit test covers the arguments
  and the request server.

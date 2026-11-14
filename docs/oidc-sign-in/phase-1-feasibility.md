# Phase 1: Feasibility checks

Read [the plan overview](README.md) first.

## Goal

Answer the questions that the design depends on, against the real Backstage 1.55.3 and 1.56.3
applications and desktop VS Code in the three
[topologies](README.md#deployment-topologies). The phase changes the test applications and the
test harness. It changes no product code.

## Current state

- The release test applications in `test/integration/backstage/apps/` use the New Frontend System
  (`@backstage/frontend-defaults`), the guest sign-in provider, and SQLite. They do not install
  `@backstage/plugin-auth`.
- `test/integration/backstage/app-config.test.yaml` declares four static external access tokens
  and no `auth.clientIdMetadataDocuments` settings.
- `test/integration/backstage/editor/cdp.mjs` drives a browser through the Chrome DevTools
  Protocol for the editor suite.
- The extension has `extensionKind: ["workspace"]`. In the WSL and Coder topologies it runs on
  the remote host, and the browser runs on the desktop.
- The extension starts the server through the `command` form of the language client's server
  options. That form cannot add a pipe to the child process.
- The hosted workflows run the installed-editor suites on `ubuntu-24.04`, `windows-2025`, and
  `macos-15`, the SSH fixture on Ubuntu, and the Backstage release tests on Ubuntu.
- The owner can run Windows with WSL, Linux desktops, and the open-source Coder server in Docker.
  The owner has no macOS desktop.
- An operating system opens a `vscode://` link by starting VS Code with the option `--open-url`.

## Questions

Each question names the [evidence layer](README.md#evidence-layers) that answers it.

### Backstage

Layer 2 answers these questions, on the hosted Ubuntu runner or a local Docker.

| ID  | Question                                                                                                                       | If the answer is no                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| B1  | Does Backstage accept the redirect URI `vscode://chtaylo3.backstage-validation-engine/sign-in` for a metadata-document client? | Stop and report. The owner chooses the companion extension             |
| B2  | Do refresh tokens work on the SQLite test applications: issue, rotation, reuse of an old token, and revocation?                | Qualify without refresh tokens, and record the limit                   |
| B3  | Can a test serve the client metadata document so that Backstage accepts it in the Compose network?                             | Stop and report                                                        |
| B4  | Does the catalog accept the issued token as a user, and does `/api/auth/v1/userinfo` return the user entity reference?         | Stop and report                                                        |
| B5  | Does the test permission policy deny one user without affecting another user?                                                  | Extend `test-permissions.mjs` until success criterion 3 can be tested  |
| B6  | Does the token response give a usable expiry when `auth.backstageTokenExpiration` is not one hour?                             | Phase 4 treats a rejected token as the signal, not the reported expiry |

A test on 2026-11-14 answered B1 with yes for the backend packages of both releases, without the
frontend and without Docker. This phase repeats B1 on the Compose applications with the consent
page.

### VS Code, on the hosted runners

Layer 3 answers these questions, on the three hosted runners and through the SSH fixture.

| ID  | Question                                                                                                                       | If the answer is no                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| V1  | Does a `vscode://` link that the test gives to the installed VS Code with `--open-url` reach the URI handler of the extension? | Find another way to deliver a link in a test, or stop and report |
| V2  | Does the same link reach the URI handler when the extension runs in the remote host of the SSH fixture?                        | Stop and report. The owner chooses the companion extension       |
| V3  | Can the extension start the server with a fourth pipe, and keep `serverProcess`, stop, and crash handling?                     | Stop and report. Decision 5 needs another channel                |
| V4  | Does `SecretStorage` return in the SSH fixture a value that was stored from a local window, and raise its change event there?  | Phase 4 keeps the session for each window separately             |
| V5  | On the macOS runner, does the command `open` with a `vscode://` link start the delivery to the test instance?                  | macOS has no evidence of layer 4. Record it                      |

### Desktops, by hand

Layer 4 answers these questions. The owner runs them on Windows in the local, WSL, and Coder
topologies, and on a Linux desktop in the local and Coder topologies. Nobody runs them on macOS.

| ID  | Question                                                                                                           | If the answer is no                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| D1  | Does a real browser hand the `vscode://` redirect to VS Code, and does the callback reach the extension?           | Stop and report. The owner chooses the companion extension           |
| D2  | With two windows of different topologies open, which window receives the callback, and can the other one tell?     | Record the behavior. Phase 3 uses it for the callback rule           |
| D3  | Do the extension host and the packaged runtime both reach an HTTPS Backstage, under the URL that the browser uses? | Record what the operator must configure for a proxy and a private CA |
| D4  | On Linux, what happens with VS Code from a system package, with VS Code from an archive, and without a keyring?    | Record each result. Phase 3 uses them for the error messages         |
| D5  | Does a forwarded loopback listener receive the redirect?                                                           | Record it. The answer informs the choice if B1, V2, or D1 fails      |

D5 is not needed for the plan. It measures the alternative, so that a failure of B1, V2, or D1
can be decided with evidence.

If a question says "stop and report", stop and give the owner the evidence. Do not design a
replacement in this phase.

## Work order

1. Add `@backstage/plugin-auth` to both test applications. Enable
   `auth.clientIdMetadataDocuments` and `auth.experimentalRefreshToken` in the test configuration.
   Keep the four static tokens.
2. Add a harness module that serves a client metadata document. Use an exact
   `allowedClientIdPatterns` entry.
3. Add a harness script that performs the flow without VS Code: discovery, the authorization
   request with PKCE S256, guest sign-in and consent through `cdp.mjs`, the code exchange,
   `userinfo`, a catalog read, a refresh, and a revocation. Answer B2 to B6 with it.
4. Answer B1 with the same script and the `vscode://` redirect URI. The script reads the code from
   the redirect location. It does not need VS Code.
5. Make a throwaway extension build that registers the URI handler, starts the server with a
   fourth pipe, and writes one `SecretStorage` value. Do not merge it.
6. Add a harness function that gives a link to the installed VS Code of a test with `--open-url`.
   Keep it, because phases 3 to 5 use it.
7. Answer V1 to V5 with the throwaway build in the hosted workflow. Run the existing `startup`,
   `restart`, `shutdown`, and `server-crash` cases with the fourth pipe on the three runners.
8. Write the procedure for the questions by hand, including the setup of a Coder workspace with
   the open-source Coder server in Docker. The owner runs it and returns the observations for D1
   to D5.
9. Write `docs/oidc-sign-in/feasibility-record.md`: each question, its layer, the answer for each
   Backstage release, runner, desktop, and topology, the evidence, and the decisions that follow.
   Add the record to the table in the plan overview.

## Success criteria

1. Every question has a recorded answer with the command and the observation that support it:
   the Backstage questions for 1.55.3 and 1.56.3, the VS Code questions for the three runners and
   the SSH fixture, and the desktop questions for each desktop and topology that the owner ran.
2. The record confirms the redirect URI and the exact `allowedRedirectUriPatterns` value that an
   operator needs, or it reports that the plan needs the companion extension.
3. The record gives the complete content of the client metadata document.
4. The record states what an operator must configure when Backstage is behind a proxy or uses a
   private certificate authority, for the desktop and for the remote side.
5. The harness script completes the whole flow on both releases without a manual step.
6. The procedure by hand has been followed by the owner without help from its author.
7. The record states for macOS which layers have evidence.
8. The existing release tests pass with the changed applications. The four static tokens behave
   as before.
9. No token that a Backstage application issued appears in the record, the logs, or the evidence.

## Test cases

1. The flow script against 1.55.3 and against 1.56.3: a catalog read with the issued token
   returns the expected entity as the guest user.
2. A code exchange with a wrong verifier is refused.
3. A second exchange of one code is refused.
4. An authorization request with a redirect URI that the document does not list is refused.
5. An authorization request from a client URL that the configuration does not allow is refused.
6. A refresh with a rotated-out refresh token is refused, and the record states what happens to
   the current token.
7. A catalog read with a revoked session's access token: the record states whether the access
   token stays valid until it expires.
8. The harness function for `--open-url`: a link for the extension reaches its handler once; a
   link for another extension identifier does not reach it.

## Exit criteria

The [exit criteria for every phase](README.md#exit-criteria-for-every-phase) apply. In addition:

1. The owner has read the feasibility record and has confirmed or changed the
   [proposed decisions](README.md#proposed-decisions).
2. Phases 2 to 5 are updated where an answer changes them.

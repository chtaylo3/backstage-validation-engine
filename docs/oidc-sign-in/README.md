# OIDC sign-in plan

This directory holds the implementation plans that replace the shared catalog token with
credentials that belong to one developer or one CI job. In the VS Code extension, the developer
signs in to Backstage in the browser, and the extension receives a short-lived Backstage user token
through the OAuth 2.0 authorization code flow with PKCE. In CI, the command-line tool sends a
short-lived token that the CI system issued to the job. The plans are for
the engineers and agents who implement and review the work. Each phase is one independently
reviewable change. Phases 1 to 5 run in order. Phase 6 needs only Phase 2. See the
[order with the other plans](#order-with-the-other-plans).

| Phase | Plan                                                             | Outcome                                                                    |
| ----- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1     | [Feasibility checks](phase-1-feasibility.md)                     | The open questions are answered against real Backstage and real VS Code    |
| 2     | [Launcher-supplied credentials](phase-2-launcher-credentials.md) | The language server accepts a credential from its launcher, in memory only |
| 3     | [Sign-in in the extension](phase-3-extension-sign-in.md)         | A developer signs in from VS Code and catalog features work                |
| 4     | [Session lifetime](phase-4-session-lifetime.md)                  | Refresh, expiry, rejection, sign-out, and two windows behave as specified  |
| 5     | [Qualification and migration](phase-5-qualification.md)          | Evidence on both pinned Backstage releases, and documents without a token  |
| 6     | [CLI credentials](phase-6-cli-credentials.md)                    | The CLI reads the catalog in CI with the CI system's own token             |

## Order with the other plans

The owner decided this order on 2026-11-14:

1. [Phase 1 of the distribution plan](../distributions/phase-1-composition-roots.md), the
   composition roots. Phase 1 of this plan changes no product code and can run at the same time.
2. Phases 2 to 5 of this plan. Phase 6 can run at any time after Phase 2.
3. Phases 2 to 7 of the [distribution plan](../distributions/README.md), after the phases of the
   [cross-entity rules plan](../cross-entity-rules/README.md) that they need.

The order has these reasons and consequences:

- Phase 1 of the distribution plan moves the body of `src/lsp/stdio.ts` to `runStdioServer` in
  `src/lsp/run-stdio.ts`, and the body of `src/cli/main.ts` to `runCli` in `src/cli/run.ts`. It
  changes no behavior. Phase 2 and Phase 6 of this plan are written against those functions.
- The distribution builder of the distribution plan comes after sign-in, so it can generate the
  client document of a distribution.
  [Phase 5 of the distribution plan](../distributions/phase-5-distribution-builder.md#sign-in-client-document)
  specifies that.
- The distribution plan gives the extension a settings prefix and a command prefix from a
  build-time constant. The sign-in commands of this plan use the present prefix, and the
  distribution plan changes them with the other commands.

## Current state

- The language server reads one bearer token from an environment variable (`tokenEnv`) or a file
  (`tokenFile`). `createHostCatalog` in `src/host/catalog-config.ts` owns both sources.
- The token is a Backstage static external access token (`backend.auth.externalAccess`, type
  `static`). It does not expire. Every developer holds the same value.
- The [local setup](../local-setup.md) writes the token to a shell environment file and to
  `~/.vscode-server/server-env-setup`. The extension passes its whole environment to the server
  process, so every child process of the extension host inherits the token.
- Backstage sees one service subject, such as `external:bve-reader`, for every developer. It
  cannot tell developers apart, and it cannot remove one developer's access.
- A static token gives a service principal. Backstage does not consult the permission policy for
  a service principal, so every developer reads the same view of the catalog.
- `principalId` and `credentialRevision` in the trusted configuration are statements by the
  person who wrote the file. Nothing verifies them.

## What Backstage provides

These facts were read from the Backstage source at `v1.55.4` and `v1.56.5` on 2026-11-13. The
relevant code is the same in both releases.

1. **An OAuth 2.0 authorization server for native clients.** `auth.clientIdMetadataDocuments`
   (stable since 1.53.0) enables `GET /api/auth/v1/authorize`, `POST /api/auth/v1/token`, and
   `POST /api/auth/v1/revoke`. Discovery is at `/api/auth/.well-known/openid-configuration`, and
   the issuer is the base URL of the auth plugin. The Backstage CLI's `auth login` command uses
   this flow.
2. **Public clients with PKCE.** The client identifier is an HTTPS URL of a client metadata
   document. The client has no secret. PKCE is mandatory. The only grants are
   `authorization_code` and `refresh_token`. There is no device code grant.
3. **A real user token.** The access token is a normal Backstage user identity token. Its subject
   is the user entity reference, and the permission policy applies to it. The default lifetime is
   one hour (`auth.backstageTokenExpiration`, 10 minutes to 24 hours).
4. **Refresh tokens are experimental.** `auth.experimentalRefreshToken` issues an opaque refresh
   token that rotates on every use. The defaults are 30 days per token and one year per rotation
   chain. A refresh fails when the user entity no longer exists in the catalog.
5. **Redirect rules.** The redirect URI must be in the client document and must match
   `allowedRedirectUriPatterns`. The default patterns allow loopback addresses with any port. A
   test on 2026-11-14 with a running backend of each pinned release showed that Backstage accepts
   a `vscode://` redirect URI and completes the flow with it. The test also showed three rules:
   - A configured `allowedRedirectUriPatterns` replaces the loopback defaults.
   - A redirect URI that is not a loopback address must equal an entry of the client document
     exactly, including its query. The extension therefore sends the redirect URI without a query.
   - Backstage answers a refused redirect URI with an error page. It sends no callback.
6. **A consent page.** `/v1/authorize` sends the browser to `/oauth2/authorize/<session>` in the
   Backstage app. The frontend plugin `@backstage/plugin-auth` provides that page. It needs the
   New Frontend System.
7. **No token exchange.** Backstage has no built-in way to exchange an identity provider's token
   for a Backstage user token. An identity provider's token that Backstage verifies through
   `externalAccess` type `jwks` gives a service principal, not a user.

## Deployment topologies

The extension has `extensionKind: ["workspace"]`, so it runs where the workspace files are. The
browser and the VS Code window are always on the developer's desktop, which runs Windows, macOS,
or Linux. The plan supports these three topologies, and each phase must work in all of them.

| Topology | Desktop                  | Extension host and language server      | Browser, VS Code window, `SecretStorage` |
| -------- | ------------------------ | --------------------------------------- | ---------------------------------------- |
| Local    | Windows, macOS, or Linux | The desktop                             | The desktop                              |
| WSL      | Windows                  | The Linux distribution in WSL           | The desktop                              |
| Coder    | Windows, macOS, or Linux | The Coder workspace, through Remote-SSH | The desktop                              |

The Coder topology is desktop VS Code with the Coder Remote extension, which connects through
Remote-SSH. The browser editors that a Coder workspace can serve (code-server and VS Code for the
Web) are not in this plan: they cannot receive a `vscode://` callback, and they keep secrets on
the server.

The topologies have these consequences for the design:

1. **The redirect must reach a process on another machine.** In the WSL and Coder topologies, a
   loopback listener in the extension host is on a machine that the browser cannot reach directly.
   WSL port forwarding and SSH port forwarding can connect them, but an organization can turn
   either off, and VS Code documents neither for this use. A `vscode://` callback goes to the
   VS Code window on the desktop, and VS Code passes it to the extension host wherever that is. The
   plan therefore uses the URI handler in every topology.
2. **Two machines talk to Backstage.** The browser reaches Backstage from the desktop. The extension
   host makes the token requests, and the language server makes the catalog requests, from WSL or
   from the Coder workspace. Backstage must be reachable under the same URL from both, because the
   issuer must equal the configured authorization server. A proxy or a private certificate
   authority must be configured on both.
3. **Tokens are in the memory of the remote host.** In the WSL and Coder topologies, the access
   token is in process memory on the remote host. The refresh token rests on the desktop, in
   `SecretStorage`, but the extension host receives it for each refresh. See the
   [remaining risks](#remaining-risks) and the
   [alternative with a companion extension](#alternative-a-companion-extension-on-the-developers-machine).
4. **The trusted configuration file is on the remote host.** A person who can write that file can
   name another authorization server. The extension therefore asks the developer to approve each
   new authorization server once, and it keeps the approval on the desktop, in `SecretStorage`.
5. **A callback can arrive in another window.** The redirect URI is fixed, so the desktop gives the
   callback to the VS Code window that was active last. A window without the matching pending
   attempt ignores the callback.
6. **The server process differs.** The fourth pipe for the credential is created by `node.exe` on
   Windows, and by the macOS or Linux runtime elsewhere.
7. **The desktop decides whether sign-in can work.** The desktop's installation of VS Code
   registers the `vscode://` scheme, and the desktop's keyring protects `SecretStorage`. Windows
   and macOS always provide both. A Linux desktop can lack either. In the WSL and Coder
   topologies the extension runs on another machine and cannot inspect the desktop, so it checks
   what VS Code lets it check and reports the rest when it fails. See the
   [checks before sign-in](phase-3-extension-sign-in.md#checks-before-sign-in).

## Evidence layers

The tests of this plan run in four layers. Each layer shows one thing, and the phases name the
layer of every check.

| Layer | What it shows                                                                               | Where it runs                                           |
| ----- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1     | The sign-in logic of the extension and the server, against a fake authorization server      | The hosted Ubuntu, Windows, and macOS runners           |
| 2     | The real Backstage applications accept the flow and the token, on both pinned releases      | The hosted Ubuntu runner, with Docker                   |
| 3     | VS Code delivers a `vscode://` link to the extension, also when the extension runs remotely | The three hosted runners, and the SSH fixture on Ubuntu |
| 4     | The operating system hands the redirect of a real browser to VS Code                        | By hand, on the owner's desktops                        |

Layer 3 works because an operating system opens a `vscode://` link by starting VS Code with the
option `--open-url`. A test gives the link to the installed VS Code of the test with the same
option. The layer leaves out only the registration of the scheme at the operating system, which
the installation of VS Code provides.

The desktops have this evidence:

- **Windows:** layers 1 to 4, with layer 4 in the local, WSL, and Coder topologies.
- **Linux:** layers 1 to 4, with layer 4 in the local and Coder topologies.
- **macOS:** layers 1 to 3 on the hosted runner. The owner has no macOS desktop, so no run by
  hand takes place. Phase 1 tries the `open` command on the hosted runner as a replacement for
  layer 4.

## Decisions

### Decisions of the owner

The owner made these decisions on 2026-11-13. A phase plan does not reopen them.

1. **The developer's own token is the default in the editor.** The owner accepts that a Backstage
   user token has the developer's full authority, as the [remaining risks](#remaining-risks)
   describe.
2. **A static token stays as an option for an enterprise.** A configuration can still select
   `tokenEnv` or `tokenFile`, and the token reaches the tools through the environment or a file.
   A distribution build never contains the token. The tools do not track an expiry for it,
   because a Backstage static token does not expire.
3. **The Coder topology** is desktop VS Code with the Coder Remote extension and a workspace of
   the Coder product.
4. **The CLI in CI prefers the CI system's own token.** The job sends the OIDC token of the CI
   system to Backstage, which verifies it with the built-in `jwks` external access type. A token
   from the identity provider through an application registration is an option that the
   documents recommend only for Azure DevOps. A static token is the fallback. The project ships
   no Backstage backend module. [Phase 6](phase-6-cli-credentials.md) specifies this. The owner
   decided this on 2026-11-14, and it replaces the decision of 2026-11-13.
5. **GitHub checks come later through a GitHub App.** This plan covers only the CLI for CI.
6. **A developer's machine uses the Backstage CLI.** `bve` gets no sign-in command of its own.
   The developer takes a user token from the Backstage CLI.
7. **The sign-in approach.** On 2026-11-14 the owner confirmed proposed decisions 1, 9, and 10:
   Backstage is the authorization server, one extension uses the URI handler, and each customer
   distribution has its own redirect URI and client document.
8. **The setup guide of the VS Code extension documents the sign-in setup.** The guide is
   `extensions/vscode/README.md`, which the package contains.
   [Phase 5](phase-5-qualification.md#documents) specifies its content.
9. **Refresh tokens are used by default, and a configuration can turn them off.** With
   `signIn.refreshTokens` set to `false`, the extension requests no refresh token, and the
   developer signs in again when the access token expires.
10. **Sign-in requires Backstage 1.53.0 or later with the New Frontend System and the consent
    page plugin.** An installation that does not meet this uses the static token.
11. **Windows, macOS, and Linux desktops are supported.** When secure storage does not work, or
    when the callback does not arrive, the extension shows an error that names the cause and
    stops the sign-in. Local validation continues. macOS is qualified by automated tests only.
12. **The organization that runs Backstage hosts the client document.** Its HTTPS URL is a
    setting, `signIn.clientId` in the trusted configuration. The setup guide of the extension
    documents the document and the setting. The project hosts no client document, and the tests
    serve one from the test harness.
13. **The distribution builder generates the client document.** For a customer distribution, the
    builder writes the client document and the Backstage settings from the distribution manifest,
    so that the three parts of the setup agree.
14. **A customer distribution can contain its sign-in values.** The distribution manifest can
    name the authorization server and the client document, and the builder compiles both into the
    build. A developer then configures nothing for sign-in. The workspace still cannot select
    these values. [Phase 5 of the distribution plan](../distributions/phase-5-distribution-builder.md#sign-in-client-document)
    specifies this.
15. **The editor can keep a static token in secret storage.** As an alternative to an environment
    variable or a file, the developer enters the static token once, the extension keeps it in
    `SecretStorage` on the desktop, and the extension passes it to the server on the credential
    pipe. The CLI keeps the environment variable and the file.
    [Phase 4](phase-4-session-lifetime.md#stored-static-token) specifies this.
16. **The setup guide gives guidance for static tokens:** restrict the token to catalog reads,
    issue one token with its own subject for each team or environment, and rotate by adding the
    new token before removing the old one.
17. **The CLI takes the token from a default environment variable or from standard input,** so
    that an organization can use its own secret store. No build contains a token.
    [Phase 6](phase-6-cli-credentials.md#changes-to-the-cli) specifies this.

### Proposed decisions

The owner has confirmed all of these decisions, the last of them on 2026-11-14. Decision 3 holds
together with decision 14 of the owner: a customer distribution can also contain the values.

1. **Backstage is the authorization server.** The extension signs in to Backstage, not to the
   organization's identity provider. Backstage keeps its own sign-in provider and sign-in
   resolver, and the extension needs no knowledge of them. The result is a user principal.
2. **No client secret, anywhere.** The extension is a public client. Neither the package nor the
   trusted configuration holds a credential.
3. **The trusted launcher configuration selects sign-in.** The authorization server and the
   client identifier come only from the file that `backstageValidation.configPath` or
   `BVE_LSP_CONFIG` names. Workspace settings, initialization options, and source files cannot
   select them.
4. **Tokens stay in memory.** The access token exists only in the memory of the extension host
   and the language server. The refresh token exists only in VS Code `SecretStorage`, which keeps
   secrets on the developer's own machine, also for a remote window.
5. **Credentials never enter the LSP stream.** The extension passes the token to the server on a
   separate pipe that only the two processes hold. LSP messages and LSP traces carry no token.
6. **The session is private to the extension.** The extension does not register a VS Code
   authentication provider, because a registered provider lets other extensions ask for the token.
7. **Static tokens keep their behavior.** A configuration with `tokenEnv` or `tokenFile` behaves
   as it does today. The stored static token of decision 15 is an addition.
8. **Minimum Backstage release.** Sign-in needs Backstage 1.53.0 or later with the New Frontend
   System. The qualified releases are the pinned 1.55.3 and 1.56.3 applications.
9. **One extension, and the URI handler in every topology.** The sign-in code stays in the
   existing workspace extension. The redirect URI is `vscode://<publisher>.<name>/sign-in`, where
   `<publisher>.<name>` is the identifier of the installed extension. For this repository's
   extension it is `vscode://chtaylo3.backstage-validation-engine/sign-in`. The Backstage operator
   adds that pattern to `allowedRedirectUriPatterns`.
10. **A customer distribution has its own redirect URI and its own client document.** The
    [distribution plan](../distributions/README.md) gives each distribution its own publisher and
    name, so its redirect URI differs, for example `vscode://acme.acme-backstage-validation/sign-in`.
    The extension derives the redirect URI from its own identifier at run time. The customer hosts
    a client document that lists that URI, and names its URL in `signIn.clientId`.
11. **Desktop VS Code only.** Sign-in supports the stable desktop VS Code on Windows, macOS, and
    Linux in the three [topologies](#deployment-topologies). It does not support VS Code Insiders,
    other editors, or the browser editors.

### Alternative: a companion extension on the developer's machine

A second, small extension with `extensionKind: ["ui"]` always runs on the desktop. It registers a
VS Code authentication provider, performs the sign-in, and keeps and uses the refresh token. The
workspace extension asks it for an access token through `vscode.authentication.getSession`.

- **Gain.** The refresh token never leaves the developer's machine, and only the short-lived
  access token reaches WSL or the Coder workspace. The redirect is a loopback listener next to
  the browser, which Backstage allows by default and documents. Consequences 1, 3, and 5 of the
  topologies no longer apply.
- **Cost.** Two extensions to build, sign, install, and keep at matching versions, also in a
  customer distribution. VS Code lets other extensions ask the provider for the token, after the
  developer consents for each extension. The companion needs its own source of approved
  authorization servers, because the trusted configuration file is on the other machine.

This plan does not use the alternative. Choose it if Phase 1 shows that Backstage refuses the
`vscode://` redirect or that the callback is unreliable in a topology, or if the owner decides
that a refresh token must never be in the memory of a remote host.

### Alternative: sign in to the identity provider

The extension could sign in to the organization's identity provider (Entra ID, Okta, Keycloak) and
send that provider's access token to Backstage through `externalAccess` type `jwks`. That works on
a Backstage without the New Frontend System. It has three costs: the caller is a service principal
again, so the permission policy does not apply per developer; every identity provider needs its
own registration, audience, and qualification; and the extension must verify identity tokens from
arbitrary issuers. Add it as a later plan only if a deployment cannot enable
`auth.clientIdMetadataDocuments`.

## Target design

```text
Developer        Extension host            Browser            Backstage          Language server
   | Sign In          |                       |                   |                     |
   |----------------->| discovery             |                   |                     |
   |                  |---------------------------------------->  |                     |
   |                  | open /v1/authorize (PKCE S256, state)     |                     |
   |                  |---------------------->|------------------>| sign-in, consent    |
   |                  |    redirect with code and state           |                     |
   |                  |<----------------------|<------------------|                     |
   |                  | POST /v1/token (code, verifier)           |                     |
   |                  |---------------------------------------->  |                     |
   |                  | GET /v1/userinfo                          |                     |
   |                  |---------------------------------------->  |                     |
   |                  | credential on the private pipe            |                     |
   |                  |---------------------------------------------------------------->|
   |                  |                       |                   |  catalog reads      |
   |                  |                       |                   |<--------------------|
```

The trusted configuration replaces the token source with a `signIn` object:

```json
{
  "connectionId": "primary",
  "baseUrl": "https://backstage.example.com/api/catalog",
  "scope": ["catalog:read"],
  "maxAgeMs": 30000,
  "signIn": {
    "authorizationServer": "https://backstage.example.com/api/auth",
    "clientId": "https://example.com/backstage-validation/vscode-client.json"
  }
}
```

The Backstage operator enables the flow and approves the client:

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

Phase 1 confirms the redirect pattern and settles the location of the client document.

## Design rules that this plan proposes

1. **One credential source.** A catalog configuration selects exactly one of `tokenEnv`,
   `tokenFile`, `tokenStorage`, and `signIn`.
2. **No token at rest in plain text.** No phase writes an access token or a refresh token to a
   file, an environment variable, a setting, workspace state, a log, a trace, or a test evidence
   file.
3. **A token goes only where the trusted configuration says.** The access token is sent to the
   configured catalog base URL and to endpoints of the configured authorization server. No
   redirect is followed with a token.
4. **The discovered endpoints belong to the configured server.** The issuer in the discovery
   document must equal `signIn.authorizationServer`, and every endpoint must have the same origin.
   The scheme is HTTPS, or HTTP to a loopback address.
5. **The browser opens only after an action by the developer.** The prompt names the host of the
   authorization server.
6. **Fail closed, and keep local validation.** Without a valid credential, catalog reads are
   unavailable and local validation continues. The findings are the ones that a denied catalog
   produces today.
7. **The server decides nothing about identity.** The principal comes from the Backstage
   `userinfo` endpoint, through the extension. Backstage alone verifies the token.

## Threats and controls

| Threat                                                           | Control                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A token is read from a file, the environment, or a log           | Design rule 2. A test puts a canary token through every flow and searches every output         |
| Another application receives the redirect with the code          | PKCE with S256. The code is useless without the verifier                                       |
| A web page sends a forged callback to the extension              | The `state` value must match the one pending attempt. An unsolicited callback has no effect    |
| A repository under validation redirects sign-in or the token     | Decision 3 and design rules 3 and 4. An untrusted workspace starts nothing                     |
| A changed discovery document points at another server            | Design rule 4                                                                                  |
| Another extension asks for the token                             | Decision 6. The extension's exported API returns no credential                                 |
| An LSP trace records the token                                   | Decision 5                                                                                     |
| A stolen refresh token is used                                   | Backstage rotates the token on every use. Sign-out revokes it                                  |
| The developer is used to sign-in prompts and accepts a false one | Design rule 5. One notification per window start                                               |
| The host of the client document is compromised                   | The operator approves one exact client URL and exact redirect patterns, and can self-host      |
| The configuration file on a remote host names another server     | The developer approves each new authorization server once. The approval is kept on the desktop |
| A developer leaves the organization                              | Access ends within one access token lifetime after Backstage removes the user entity           |

### Remaining risks

- **The user token has more authority than the static token.** The static token can be restricted
  to catalog reads. The user token has no scope: it can do in every Backstage plugin what the
  developer can do. A stolen access token is usable for up to one token lifetime, and a stolen
  refresh token for up to its own lifetime. The plan trades a shared, permanent, read-only secret
  for a personal, short-lived, full-authority one. The owner must accept that trade.
- **Tokens are in the memory of the remote host** in the WSL and Coder topologies, including the
  refresh token during a refresh. A person who administers that host can read them. The
  [companion extension](#alternative-a-companion-extension-on-the-developers-machine) removes the
  refresh token from that host.
- The access token is a bearer token. Backstage does not bind it to the client, so a token that
  leaves process memory can be used until it expires.
- On Linux without a keyring, VS Code falls back to a store that hides secrets but does not
  encrypt them securely.
- Backstage refresh tokens are experimental. Without them, the developer signs in again when the
  access token expires.

## Success criteria and exit criteria

Each phase plan has both. A success criterion states an outcome that the change must achieve, and
the implementer shows evidence for it. An exit criterion states a condition for closing the phase
and starting the next one.

### Success criteria of the plan

The plan is complete when all of these hold, with evidence in the Phase 5 report.

1. **No shared secret.** On a clean machine, a developer installs the extension, selects a trusted
   configuration with `signIn`, signs in, and gets catalog completion and catalog rule results.
   No catalog token exists in the environment, in a file, or in a setting.
2. **Standard flow.** The authorization request uses the code flow with PKCE S256 and a `state`
   value of at least 128 bits. The package and the configuration contain no client secret. The
   extension rejects a callback with a wrong or missing `state`, and it rejects a second use of a
   callback.
3. **Per-developer identity.** Two developers who read the catalog appear in Backstage as two
   different user entities. A permission policy that denies one of them changes only that
   developer's results.
4. **Individual removal.** When Backstage no longer has a developer's user entity, that
   developer's catalog access ends within one access token lifetime. Other developers are not
   affected, and no value is redistributed.
5. **No token outside memory and secret storage.** A search for the canary access token and the
   canary refresh token finds nothing in the output channel, LSP messages, an LSP trace at the
   verbose level, the server's standard error, workspace state, global state, the file system
   under the test's control, and the uploaded evidence.
6. **No interruption while the session is valid.** With refresh tokens enabled, validation and
   completion continue across at least three access token lifetimes without a prompt.
7. **Clear loss of session.** When refresh fails or Backstage rejects the token, catalog reads
   become unavailable within one request, local findings are unchanged, and the developer sees
   one sign-in notification, not one for each request.
8. **Sign-out.** After sign-out, the server holds no token, secret storage holds no refresh token,
   the refresh token is revoked at Backstage, and the next catalog read is unavailable.
9. **Every topology and desktop.** Sign-in, refresh, and sign-out complete in the local, WSL, and
   Coder [topologies](#deployment-topologies), from VS Code on Windows, macOS, and Linux, with the
   [evidence layers](#evidence-layers) that each desktop has.
10. **Both pinned releases.** The real Backstage 1.55.3 and 1.56.3 applications accept the token
    as a user. They reject an expired token, a token with a changed signature, and a token from
    another Backstage instance.
11. **No regression.** A configuration with `tokenEnv` or `tokenFile` produces byte-identical
    findings, coverage, and wire messages, in the editor and in the CLI.
12. **CI without a shared secret.** The CLI reads the catalog of both pinned Backstage releases
    with a short-lived token from a test issuer. Backstage refuses a token with another issuer,
    another audience, a passed expiry, or a changed signature.

### Exit criteria for every phase

The [exit criteria of the distribution plan](../distributions/README.md#exit-criteria-for-every-phase)
apply without change.

## Rules for every phase

The [architecture remediation rules](../architecture-remediation/README.md#rules-for-every-phase)
apply, with these differences:

1. **Behavior.** Each phase plan names the behavior it adds. A configuration without `signIn`
   produces byte-identical findings, coverage, rule states, exit codes, and wire messages.
2. **Public API and schemas.** A phase may add the exports, methods, commands, and schema
   properties that its plan names. It must not remove or rename an existing one.
3. **Dependencies.** Do not add, remove, or upgrade a dependency unless the phase plan names it.
   The sign-in flow uses Node's `crypto` and `fetch`. It does not parse or verify a token.
4. **Heavy suites.** Phase 1 and Phase 5 run the Backstage container suites and the installed
   VS Code suites, because their questions cannot be answered otherwise.
5. **Secrets in tests.** Tests use synthetic tokens. A test never prints a token that a real
   Backstage application issued, and no evidence file contains one.

## Verification gate and report

The verification gate and the final report are the ones in the
[architecture remediation plan](../architecture-remediation/README.md#verification-gate). The
installed-editor suites run only in GitHub CI; say in the report which cases your change affects.

## Sources

- [Backstage service-to-service authentication](https://backstage.io/docs/auth/service-to-service-auth)
- [Backstage CLI authentication module](https://backstage.io/docs/tooling/cli/module-auth)
- [Backstage MCP actions and client metadata documents](https://backstage.io/docs/ai/mcp-actions)
- [VS Code remote extensions: secrets and callbacks](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- [RFC 8252: OAuth 2.0 for native apps](https://www.rfc-editor.org/rfc/rfc8252.html)
- [RFC 9700: OAuth 2.0 security best current practice](https://datatracker.ietf.org/doc/html/rfc9700)

# Phase 6: CLI credentials

Read [the plan overview](README.md) first. This plan uses the separate report of HTTP 401
from [Phase 2](phase-2-launcher-credentials.md). It does not need phases 3 to 5.

## Goal

The CLI reads the catalog in CI with a short-lived token that belongs to the CI job, and on a
developer's machine with the developer's own token. The shared static token becomes an
alternative, not the default.

## Current state

- `runCli` reads one bearer token through `tokenEnv` or `tokenFile` of the catalog configuration.
  The token is any single-line value of at most 8,192 characters, so the CLI can already send a
  JWT.
- `principalId` and `credentialRevision` in the catalog configuration are statements by the host.
- The release test applications declare only static external access tokens.
- Backstage verifies an external JWT with `backend.auth.externalAccess`, type `jwks`. The entry
  has the options `url`, `issuer`, `audience`, `algorithm`, and `subjectPrefix`, and the sibling
  `accessRestrictions`.
- That entry checks the signature, the issuer, the audience, and the expiry. It reads only the
  `sub` claim. It cannot require any other claim, such as a repository or a branch. An omitted
  `issuer` or `audience` is not checked at all.
- The caller becomes a service principal. Backstage does not consult the permission policy for
  it, so `accessRestrictions` is the only limit on what the token can do.

## Target design

### Decisions

The owner made these decisions on 2026-11-14:

1. **Preferred: the CI system's own token.** The job sends the OIDC token of the CI system to
   Backstage. This needs no registration at an identity provider. It is the preferred approach
   for GitHub Enterprise Cloud, TeamCity, and every other CI system whose issuer belongs to one
   organization.
2. **Option for Azure DevOps: a token from the identity provider.** The job receives a
   short-lived Microsoft Entra token through an application registration, and Backstage verifies
   that token. This option is recommended only for Azure DevOps, because an Azure DevOps job has
   no token that Backstage can verify directly.
3. **Fallback: a static token**, as today, through an environment variable or a file.
4. **No Backstage backend module.** The built-in `jwks` type is the only verifier.
5. **A developer's machine uses the Backstage CLI** for the developer's own token.
6. **The CLI takes the token from any secret store.** It reads the token from a default
   environment variable, or from standard input. The organization's own tool supplies the value:
   a CI secret, HashiCorp Vault, OpenBao, PowerShell SecretManagement, or another one. No build
   contains a token, and the CLI has no option that takes the token as an argument value.

### What the preferred approach gives and does not give

Backstage accepts every token that has the configured issuer and audience. It cannot ask which
repository, project, or build the token came from. With the CI system's own token, every job of
that CI system can therefore read the catalog. The entry is restricted to catalog reads, so a job
can read and cannot change anything. The operator document states this consequence in the
procedure of each environment.

An organization that must limit catalog reads to named repositories or builds needs the identity
provider option, because only an identity provider can make that decision. The operator document
says so in one sentence. It does not present the option as a general alternative.

### Backstage entry

```yaml
backend:
  auth:
    externalAccess:
      - type: jwks
        options:
          url: https://token.actions.githubusercontent.com/.well-known/jwks
          issuer: https://token.actions.githubusercontent.com/ENTERPRISE
          audience: https://backstage.example.com/catalog-read
          algorithm: RS256
          subjectPrefix: ci
        accessRestrictions:
          - plugin: catalog
            permissionAttribute:
              action: read
```

`ENTERPRISE` is the name of the organization's GitHub enterprise. The operator takes `url` from
the discovery document of the issuer.

The operator document states these rules for every environment:

- Always set `issuer`, `audience`, and `algorithm`. An omitted `issuer` accepts the tokens of
  every customer of a shared CI service.
- Use an issuer that belongs to one organization. Never use the shared issuer of github.com or
  gitlab.com.
- Choose an audience that only this Backstage uses, and never the audience `backstage`.
  Backstage takes such a token for a user token and refuses it.
- Always restrict the entry to catalog reads.

### Environments

| Environment             | Approach                                                               | Registration at an identity provider |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| GitHub Enterprise Cloud | Preferred: the GitHub token, with the issuer of the enterprise         | No                                   |
| TeamCity                | Preferred: the TeamCity token, with the issuer of the TeamCity server  | No                                   |
| Azure DevOps            | Option: a Microsoft Entra token through a workload identity connection | Yes                                  |
| Any CI system           | Fallback: the static token                                             | No                                   |
| Developer's machine     | The developer's own Backstage user token, in `tokenEnv`                | No                                   |

Notes for the operator document:

- **GitHub Enterprise Cloud.** Enable the issuer of the enterprise
  (`https://token.actions.githubusercontent.com/<enterprise>`). The job needs the permission
  `id-token: write` and requests a token with the configured audience. The token is valid for
  about five minutes, so the job requests it directly before it runs the CLI.
- **TeamCity.** OIDC tokens come from a plugin, and the issuer is the root URL of the TeamCity
  server. Backstage must be able to reach the key URL of that server.
- **Azure DevOps.** The pipeline uses a service connection with workload identity federation and
  requests a Microsoft Entra token for an application that represents Backstage. The entry in
  Backstage names the Microsoft Entra tenant as the issuer and that application as the audience.
  At Microsoft Entra, require an assignment for the application, so that only the named service
  connection can get a token.
- **Developer's machine.** The Backstage CLI prints a user token with `auth print-token` after
  `auth login`. The owner decided that `bve` gets no sign-in command of its own.

### How the operator document presents the approaches

`docs/cli-credentials.md` starts with a table that maps each environment to one approach. The
section for the identity provider option carries this notice directly under its heading:

> Use this option only for Azure DevOps. For GitHub Enterprise Cloud, TeamCity, and other CI
> systems with their own issuer, send the CI system's token directly. That approach needs no
> application registration.

The sections for GitHub Enterprise Cloud and TeamCity do not describe the identity provider
option.

### Changes to the CLI

The CLI gets two ways to receive a token that need no token source in the catalog
configuration. Both work with any secret store, because the organization's own tool supplies the
value when it starts the CLI.

- **Default environment variable.** When the catalog configuration names no token source, the
  CLI reads the token from `BVE_CATALOG_TOKEN`. A configuration with `tokenEnv` or `tokenFile`
  behaves as before.
- **Standard input.** With the option `--catalog-token-stdin`, the CLI reads the token from
  standard input: one line, at most 16,384 bytes, with the checks of the token file. The option
  is refused together with a configuration that names `tokenEnv` or `tokenFile`, and without
  `--catalog-config`.

The CLI has no option that takes the token as an argument value. An argument value is visible in
the process list of the machine, in the shell history, and in the commands that a CI system
prints. A CI system masks a secret in its log, but the value is still an argument of the process.
The operator document says this, and shows one example for each kind of store:

```sh
# A CI secret, for example in GitHub Actions: map the secret to the variable of the step.
#   env:
#     BVE_CATALOG_TOKEN: ${{ secrets.BVE_CATALOG_TOKEN }}
bve validate --release RELEASE.json --trust TRUST.json --source SNAPSHOT.json \
  --catalog-config CATALOG.json

# HashiCorp Vault or OpenBao: pipe the value.
bao kv get -field=token kv/bve/catalog |
  bve validate --release RELEASE.json --trust TRUST.json --source SNAPSHOT.json \
    --catalog-config CATALOG.json --catalog-token-stdin
```

```powershell
# PowerShell SecretManagement: pipe the value.
Get-Secret -Name BveCatalogToken -AsPlainText |
  bve validate --release RELEASE.json --trust TRUST.json --source SNAPSHOT.json `
    --catalog-config CATALOG.json --catalog-token-stdin
```

The same two ways carry the short-lived token of a CI system and a static token.

This phase also adds a separate message for a refused credential. When Backstage answers
HTTP 401, the CLI writes one fixed line to standard error: the catalog credential was refused.
For HTTP 403 it writes that the credential has no access to the catalog. The result, the
findings, and the exit code do not change.

The CLI does not decode a token, and it does not request a token from a CI system. The language
server keeps its explicit token sources and gets no default variable.

### Release tests

Add a test issuer to the release test harness. It signs RS256 tokens with Node's `crypto` module
and serves its keys. Add one `jwks` entry for it to both test applications, restricted to
catalog reads. A new CLI phase reads the catalog with a token from the test issuer.

## Work order

1. Add the test issuer and its `jwks` entry to the release test applications.
2. Add the CLI phase and the negative controls to the release tests.
3. Add the default environment variable, the option `--catalog-token-stdin`, and the two
   standard error messages to `runCli`, and extend the help text.
4. Write `docs/cli-credentials.md` as the section above describes: the table, the Backstage
   entry, the rules, and one procedure for each environment. Mark each procedure as checked by
   hand or as taken from the vendor's documents.
5. Update [the CLI document](../policy-cli.md) and add the new document to `docs/README.md`.

## Success criteria

1. The packaged CLI reads the catalog of Backstage 1.55.3 and 1.56.3 with a token from the test
   issuer, and no static token is in its environment.
2. Backstage refuses each token of the negative controls, and the CLI exits with code 2 and the
   message for a refused credential.
3. A token from the test issuer cannot read another plugin and cannot change the catalog.
4. The four existing static-token phases pass unchanged.
5. The procedure for GitHub Enterprise Cloud has been run once by hand, with the result in the
   report, or the report says why it was not run. The same holds for Azure DevOps.
6. The CLI reads the catalog with a token from the default variable and with a token from
   standard input, and the token is in no argument of the process.
7. A reader of `docs/cli-credentials.md` who uses GitHub Enterprise Cloud or TeamCity reaches a
   working setup without reading about an application registration, and the notice appears
   under the heading of the identity provider option.

## Test cases

1. A valid token: the catalog rule results equal the ones of the static reader token.
2. Refused tokens: another issuer; another audience; the audience `backstage`; a passed expiry; a
   changed signature; the algorithm `none`; a key that the issuer does not serve.
3. A token of another issuer that the same key signed is refused. This models a shared CI
   service whose customers share signing keys.
4. A valid token against a plugin other than the catalog is refused.
5. HTTP 401 and HTTP 403 each produce their own standard error line, and equal results.
6. A token of 8,192 characters is sent, and a token of 8,193 characters is refused before any
   request.
7. Token sources: the default variable with a configuration that names no source; the default
   variable unset; `--catalog-token-stdin` with a token, with an empty input, with two lines, and
   with 16,385 bytes; the option together with `tokenEnv`, with `tokenFile`, and without
   `--catalog-config`; a configuration with `tokenEnv` behaves as before.
8. The token of each source appears in no output, no report, and no standard error line.

## Exit criteria

The [exit criteria for every phase](README.md#exit-criteria-for-every-phase) apply.

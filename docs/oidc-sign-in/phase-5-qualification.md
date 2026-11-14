# Phase 5: Qualification and migration

Read [the plan overview](README.md) first. This plan qualifies the work of phases 2 to 4.

## Goal

Show the [success criteria of the plan](README.md#success-criteria-of-the-plan) with evidence from
the real Backstage applications and the installed extension, and remove the shared token from the
documents that a developer follows.

## Current state

- The Backstage release tests run the packaged CLI and the editor suite against the 1.55.3 and
  1.56.3 applications with four static tokens.
- After Phase 1, both applications accept sign-in, and a harness script performs the flow.
- [Local setup](../local-setup.md) tells the developer to install a token in the WSL server
  environment.
- The hosted workflow in [GitHub Actions](../github-actions.md) runs the installed-editor suites
  on Linux, macOS, and Windows, and the SSH fixture on Linux.

## Target design

### Release tests

Add an editor session to `test/integration/backstage/editor/suite.mjs` that uses a `signIn`
configuration. The suite signs in through the browser driver, as the guest user and as a second
user that the test permission policy denies. The CLI phases keep their static tokens.

### Negative controls on real Backstage

Each control states the observation that proves it:

| Control                                        | Observation                                               |
| ---------------------------------------------- | --------------------------------------------------------- |
| An expired token                               | HTTP 401, a rejection notification, and a refresh         |
| A token with one changed signature character   | HTTP 401                                                  |
| A token that the other test application issued | HTTP 401                                                  |
| A user that the permission policy denies       | The denied result for that user only, and no notification |
| A user entity removed from the catalog         | The next refresh is refused, and the session ends         |

### Evidence for each topology and desktop

Qualification uses the four [evidence layers](README.md#evidence-layers). Layers 1 to 3 run in the
hosted workflows. Layer 4 runs by hand.

| Layer | What runs                                                                                     | Where                                            |
| ----- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1     | The installed-editor sign-in cases with the fake authorization server and the fake Backstage  | The Ubuntu, Windows, and macOS runners           |
| 2     | The `signIn` editor session and the negative controls against the real Backstage applications | The Ubuntu runner                                |
| 3     | The sign-in cases with the callback given to VS Code through `--open-url`                     | The three runners, and the SSH fixture on Ubuntu |
| 4     | The procedure by hand, with a real browser                                                    | The owner's desktops                             |

The layers cover the [topologies](README.md#deployment-topologies) and desktops as follows:

| Desktop | Topology | Layers 1 and 3                    | Layer 4                                    |
| ------- | -------- | --------------------------------- | ------------------------------------------ |
| Windows | Local    | The Windows runner                | By hand                                    |
| Windows | WSL      | The SSH fixture, as a remote host | By hand                                    |
| Windows | Coder    | The SSH fixture, as a remote host | By hand, with the open-source Coder server |
| Linux   | Local    | The Ubuntu runner                 | By hand                                    |
| Linux   | Coder    | The SSH fixture                   | By hand, with the open-source Coder server |
| macOS   | Local    | The macOS runner                  | The `open` command on the runner, or none  |
| macOS   | Coder    | The SSH fixture, as a remote host | None                                       |

- **The SSH fixture stands for a remote extension host.** The Coder Remote extension and the WSL
  extension both place the extension host on another machine, as the SSH fixture does. The fixture
  does not replace layer 4 for WSL and Coder.
- **macOS has automated evidence only.** No run by hand takes place on macOS. If Phase 1 showed
  that the `open` command delivers a link on the macOS runner, that case is the layer 4 evidence
  for macOS. Otherwise macOS has none, and the setup guide and the final report say so.
- **The procedure by hand** records one row for each step: sign-in with a real browser, a
  catalog completion, a refresh after a shortened token lifetime, a second window, sign-out, and
  the leak search on the remote host. The owner runs it for each row of the table that says "By
  hand".
- **The two Linux failure cases** run by hand, and the report records the message of each:
  VS Code installed without the `vscode://` registration, and a desktop without a keyring.

### Leak search

Add a release evidence check: after the editor session, search the evidence directory, the output
channel capture, the verbose LSP trace, and the server's standard error for every token that the
session received, and for the static token of a session that uses the stored token. The check fails on one match. The check holds the tokens in memory and never
writes them.

### Documents

- **Local setup.** Replace the token steps with `Sign In`. Remove the `--install-wsl-env` step,
  which writes the token to a shell file. For an application without sign-in, the named
  alternative is the stored static token with `Set Catalog Token`.
- **Setup guide of the extension.** Add the section "Set up sign-in" to
  `extensions/vscode/README.md`. It is the one place that a Backstage operator and a developer
  follow, and it is in the package. It contains:
  - The three parts that must agree: the client document, the Backstage configuration, and
    `signIn` in the trusted configuration.
  - How the redirect URI follows from the publisher and the name of the installed extension, with
    the value for this repository's extension and an example for a customer distribution.
  - The complete content of a client document, the requirement of an HTTPS URL that the
    Backstage server can reach, and the statement that the organization hosts the document and
    sets its URL in `signIn.clientId`.
  - The Backstage configuration, with the exact redirect pattern, and the statement that a
    configured `allowedRedirectUriPatterns` replaces the loopback defaults that the Backstage CLI
    needs.
  - The Backstage requirements: release 1.53.0 or later, the New Frontend System, and
    `@backstage/plugin-auth`.
  - What a developer sees when a part does not agree: a Backstage error page in the browser, and
    a sign-in in VS Code that ends at its time limit. One row for each cause, with its correction.
  - The static token as the alternative: the stored token for the editor, and an environment
    variable or a file where a person does not enter it.
  - The guidance for static tokens at Backstage: restrict the token to catalog reads, issue one
    token with its own subject for each team or environment, and rotate by adding the new token
    before removing the old one.
- **Operator guide.** A new document, `docs/sign-in-operations.md`: the refresh token setting and
  its experimental status, the remaining risks, and how to remove one developer's access. It
  links to the setup guide and does not repeat it.
- **Reference documents.** [The language server](../lsp.md), [the catalog provider](../catalog-provider.md),
  [architecture](../architecture.md), and `extensions/vscode/README.md` describe the third
  credential source.
- **Index.** Add the new documents to `docs/README.md`.

### Static tokens in the editor

When the extension starts a server whose configuration uses `tokenEnv` or `tokenFile`, it writes
one line to the output channel: the configuration uses a shared token, and sign-in is available.
It shows no notification, and validation is unchanged.

## Work order

1. Add the `signIn` editor session and the second user to the release tests.
2. Add the negative controls.
3. Add the leak search to the release evidence checks, and document its row in
   [the release evidence document](../release-evidence-contract.md).
4. Add the layer 3 cases to the hosted workflows, and run the workflows.
5. Give the owner the procedure by hand. The owner runs it on Windows in the local, WSL, and
   Coder topologies, and on a Linux desktop in the local and Coder topologies.
6. Write the operator guide and change the other documents.
7. Add the output channel line for static tokens.
8. Write the final report with one row for each of success criteria 1 to 11 of the plan, and one
   table that names the layers with evidence for each desktop and topology.

## Success criteria

1. Success criteria 1 to 11 of the plan are each marked met, with a named test or evidence file.
2. The release tests pass on Backstage 1.55.3 and 1.56.3 with the `signIn` session, and the
   existing static-token phases pass unchanged.
3. Each negative control shows its stated observation on both releases.
4. The leak search finds no match, and a planted token in a fixture makes it fail.
5. A developer who follows the changed local setup reaches working catalog completion without
   handling a token.
6. A person who follows only the setup guide of the extension configures an unprepared Backstage
   test application and the extension, and sign-in works. For each cause in the guide's table, the
   deliberate mismatch shows the described symptom.
7. The packaged VSIX for each platform contains no client secret and no token, and it contains
   the setup guide. The package check states this.
8. Every row of the table of desktops and topologies has the evidence that the table names, and
   the setup guide states that macOS is qualified by automated tests only.

## Test cases

1. Release test: sign-in as the guest user, catalog completion, and a catalog rule result, on both
   releases.
2. Release test: the denied user gets the denied result, and the guest user's results do not
   change.
3. Each row of the negative controls.
4. Leak search: a clean session passes; a planted token in the evidence directory fails.
5. Installed editor, layers 1 and 3: the sign-in cases on the hosted Windows, macOS, and Linux
   runners and the SSH fixture, once with the callback from the test harness and once with the
   callback through `--open-url`.
6. Layer 4: the procedure by hand for each row of the table that says "By hand", and the two
   Linux failure cases.
7. Static token line: one line for `tokenEnv`, one for `tokenFile`, none for `signIn`.
8. Markdown links: the link check and the index check pass with the new documents.

## Exit criteria

The [exit criteria for every phase](README.md#exit-criteria-for-every-phase) apply. In addition:

1. Move this plan and its records to `docs/history/` when the owner accepts the final report.

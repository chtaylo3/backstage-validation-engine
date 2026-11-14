# Phase 4: Signed releases in the language server

Read [the plan overview](README.md) first. This plan uses the entry functions from Phase 1.

## Goal

Let the language server load a signed policy release and verify it against a trust file, as the
CLI does, and let a build carry that trust file so that developers do not configure it.

## Current state

- The CLI requires `--release` and `--trust`. `verifyPolicyRelease` in `src/policy/releases.ts`
  checks the Ed25519 signature, the validity window (seven days at most), the activation, the
  mandatory baselines, and the bundle closure.
- The language server's trusted launcher configuration (`parseLspConfig` in `src/lsp/config.ts`)
  carries `policy`, `profile`, `activation`, and `schemaArtifacts` as plain JSON. Nothing
  verifies a signature. Trust rests on the user choosing the file.
- The VS Code extension reads the configuration path from the application-scoped setting
  `backstageValidation.configPath` or from `BVE_LSP_CONFIG`. It does not start in an untrusted
  workspace.
- The server watches the configuration file and reloads it. A reload does not repeat when the
  file bytes equal the configuration in use.
- A release has no revocation. It stays valid until it expires.

## Target design

### Configuration

The launcher configuration accepts `release` in place of `policy`, `profile`, `activation`, and
`schemaArtifacts`. `release` is a path to a signed release file, absolute or relative to the
configuration file. The two forms are mutually exclusive.

With `release`, the server verifies the file with `verifyPolicyRelease` and uses the verified
policy, profile, activation, and schema artifacts. Editor artifacts stay in the launcher
configuration; their digests already bind the policy and the profile.

### Trust

`runCli` and `runStdioServer` accept an optional `trust` option: a parsed trust record, or
`undefined`.

| Build has `trust` | Launcher configuration | Result                                                  |
| ----------------- | ---------------------- | ------------------------------------------------------- |
| Yes               | `release`              | Verified against the built-in trust                     |
| Yes               | Plain policy           | Rejected: a build with trust accepts signed policy only |
| No                | `release` and `trust`  | Verified against the trust file that `trust` names      |
| No                | Plain policy           | Accepted, as today                                      |

In a build with trust, the CLI accepts a run without `--trust`. A `--trust` file whose record
differs from the built-in trust is an error; the CLI never ignores the flag silently.

### Revocation

Add an optional `revoked` array of digests to the trust contract. `verifyPolicyRelease` rejects a
release whose release digest, root digest, or any closure digest is listed. A plugin digest in
the list rejects a release that needs that plugin.

### Expiry and reload

- The server watches the release file with the mechanism that watches the configuration file,
  including the digest rule that prevents a repeated reload.
- When the release in use expires, the server reports blocked required coverage for open
  documents, as the CLI reports a release that expires during a run. It does not keep validating
  with an expired policy.
- A reload whose release fails verification keeps the session in use until that session's
  release expires, and logs the fixed rejection reason.

## Work order

1. Add the `revoked` property and its check. Regenerate the schemas.
2. Add `release` to the launcher configuration and the verification path.
3. Add the `trust` option to both entry functions and the table above.
4. Add the release watch and the expiry behavior.
5. Add tests, then update `docs/lsp.md`, `docs/policy-cli.md`, and `docs/local-setup.md`.

## Success criteria

1. A stdio session started with a signed release produces the same diagnostics as a session
   started with the same policy as plain JSON.
2. Each row of the trust table has a test through `runStdioServer` and through `runCli`.
3. A tampered release, an untrusted key, an expired release, and a wrong generation are each
   rejected at start with the fixed startup error.
4. A revoked release digest, root digest, closure digest, and plugin digest are each rejected.
5. Replacing the release file with a newer valid release reloads the session once.
6. After the injected clock passes the release expiry, open documents report blocked required
   coverage and no finding from the expired policy.
7. Every existing launcher configuration fixture loads without change in a build without trust.

## Test cases

- **Parity.** One policy, plain and signed, with byte-identical published diagnostics.
- **Trust table.** Four rows for the server and four for the CLI.
- **Verification failures.** Signature, key, window, generation, identity, missing baseline.
- **Revocation.** Each of the four digest kinds; an empty list; a duplicate entry.
- **Reload.** Valid replacement; invalid replacement keeps the session; identical bytes cause no
  reload.
- **Expiry.** Expiry while idle and expiry during a request.
- **Release path.** An absolute path and a path relative to the configuration file. The server
  reads the release with the bounded, stable read that it uses for the configuration file,
  including that read's handling of symbolic links.

## Exit criteria

The phase is complete, and Phase 5 may start, when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. The existing installed-editor cases pass in GitHub CI on the three platforms, because the
   configuration loader changed.
3. The report states, for a build with trust, every input through which a policy can reach the
   server, and that each one is verified.

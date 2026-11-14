# Phase 5: Distribution builder

Read [the plan overview](README.md) first. This plan uses Phases 1 to 4.

## Goal

Provide one command that builds a customer's VSIX and CLI archive from a distribution manifest,
with the customer's plugins and trust file compiled in, and with a record of exactly what the
build contains.

## Current state

- `scripts/package-extension.mjs` bundles `extensions/vscode/src/extension.ts` with esbuild,
  copies `dist/` as the server, installs production dependencies with
  `npm ci --omit=dev --ignore-scripts`, writes a CycloneDX SBOM, adds the pinned Node runtime, writes
  `build-info.json`, and packages `NAME-VERSION-TARGET.vsix` with a `.sha256` file. The name,
  publisher, and version come from `extensions/vscode/package.json`.
- `scripts/cli-candidate.mjs` packages a CLI archive with a shrinkwrap, a metadata file (exact
  revision, digest, lock digest, Node version, file list), and a `.sha256` file. It refuses
  uncommitted inputs for a release candidate.
- The extension contributes the setting `backstageValidation.configPath` and commands with fixed
  identifiers.
- `.npmrc` sets `ignore-scripts=true`, `save-exact=true`, and `engine-strict=true`.
- The package is `private`, and `@marcbachmann/cel-js` resolves from a GitHub archive URL with a
  lockfile integrity value.

## Target design

### Distribution manifest

The customer's repository holds `bve-distribution.json`:

```json
{
  "schemaVersion": 1,
  "engineCommit": "ENGINE_COMMIT",
  "identity": {
    "publisher": "acme",
    "name": "acme-backstage-validation",
    "displayName": "Acme Backstage Validation",
    "version": "1.0.0",
    "cliName": "acme-bve",
    "settingsPrefix": "acmeBackstageValidation"
  },
  "plugins": [{ "package": "@acme/bve-zones", "version": "1.2.0" }],
  "trust": "trust.json"
}
```

`ENGINE_COMMIT` is the 40-character commit of this repository that the build uses. `trust` is
optional and names a trust file next to the manifest. Add a JSON Schema for the manifest under
`schemas/`.

### Command

Add `scripts/build-distribution.mjs` and the npm script `distribution:build`. The customer runs
it from a checkout of this repository:

```sh
npm run distribution:build -- --manifest MANIFEST_PATH --out OUTPUT_DIRECTORY
```

`MANIFEST_PATH` is the path of `bve-distribution.json`, and `OUTPUT_DIRECTORY` receives the
artifacts. The directory of the manifest must contain a `package.json`, a `package-lock.json`,
and an installed `node_modules`.

### Checks before building

The builder stops with a named error when any of these fails:

1. `git rev-parse HEAD` of the engine checkout equals `engineCommit`, and the checkout has no
   uncommitted change.
2. Every plugin package name is scoped, appears in the customer's lockfile at the exact version
   with an `integrity` value, and is installed at that version.
3. No plugin package, and no package it depends on, contains a native addon (`.node` file) or a
   symbolic link that leaves its directory.
4. Each plugin's default export is a `PluginDefinition` whose `version` equals the package
   version.
5. The trust file, when named, parses as the trust contract.
6. `identity.publisher` and `identity.name` differ from this repository's extension identity,
   and `settingsPrefix` differs from `backstageValidation`.

### Generated entries

The builder writes three modules into a build directory. Each contains only literal imports:

- A CLI entry that imports the plugins and calls `runCli` with them and the trust record.
- A server entry that does the same with `runStdioServer`.
- A plugin worker entry that imports the plugins for the worker threads of Phase 2.

It bundles each with esbuild. Plugin dependencies resolve from the customer's `node_modules`
only. The engine resolves from the checkout.

For each plugin, the builder computes the artifact digest: the SHA-256 of the canonical list of
`[relative path, SHA-256 of content]` pairs over the installed package directory. The generated
entries pass this digest to the registry, and policy authors copy it into their bundles.

### Artifacts

- **VSIX**, one per target, built by the existing packaging steps with the customer's identity.
  The extension reads its setting prefix and command prefix from a build-time constant, so that
  the customer's extension and this repository's extension can be installed together.
- **CLI archive**, built by the existing packaging steps, with `cliName` as the `bin` name.
- **`distribution.json`**, inside both artifacts and next to them: the engine commit, the Node
  version, the manifest digest, the digest of each lockfile, each plugin's name, version,
  lockfile integrity, and artifact digest, and the trust file digest.
- **SBOM** covering the engine's and the plugins' production dependencies.
- **`.sha256`** files for both artifacts.

### Sign-in client document

The [OIDC sign-in plan](../oidc-sign-in/README.md) is complete before this phase. A distribution
has its own redirect URI, `vscode://PUBLISHER.NAME/sign-in`, and the organization hosts a client
document that lists it. The builder generates that document, so that it cannot differ from the
identity of the build.

The manifest gains the optional property `signIn` with two properties:

- `clientDocumentUrl`: the HTTPS URL at which the customer will host the document, without a
  query or a fragment.
- `authorizationServer`: optional. The base URL of the Backstage auth plugin.

With `authorizationServer`, the builder compiles both values into the extension and the server as
built-in sign-in values. The owner decided on 2026-11-14 that a distribution can contain them.

- A developer configures nothing for sign-in. In the trusted launcher configuration,
  `catalog.signIn` can be an empty object.
- A trusted configuration that names another authorization server or another client is refused
  at startup. The built-in values cannot be replaced by a file, a setting, or the workspace.
- The extension does not ask the developer to approve the built-in authorization server.
- The catalog base URL must have the origin of the built-in authorization server.
- `distribution.json` records both values.

With `signIn`, the builder writes two files next to the artifacts:

- **`sign-in-client.json`**: the client document. Its client identifier is `clientDocumentUrl`,
  its name is `identity.displayName`, and its one redirect URI follows from `identity.publisher`
  and `identity.name`. The other content is the one that the setup guide of the extension
  defines.
- **`sign-in-backstage.yaml`**: the `auth.clientIdMetadataDocuments` settings for Backstage, with
  the exact client URL and the exact redirect URI, and a comment that a configured
  `allowedRedirectUriPatterns` replaces the loopback defaults.

`distribution.json` records the digest of the client document. The builder does not publish the
document and makes no request to its URL. Without `signIn`, the builder writes neither file.

### Traceability

- `CLI_NAME --version --json` prints the content of `distribution.json`.
- The server reports the distribution name and version in `serverInfo` of the `initialize`
  result.
- The JSON result and the SARIF `tool.driver` carry the distribution name, version, and digest.
  This is an optional addition to result contract 0.2; a build without a manifest omits it.

## Work order

1. Add the manifest schema and its parser, with unit tests.
2. Factor the shared steps out of `package-extension.mjs` and `cli-candidate.mjs` so that the
   builder and the existing scripts call the same code.
3. Add the checks, the entry generation, and the artifact digests.
4. Add the settings and command prefix constant to the extension.
5. Add traceability to the CLI, the server, and the reports.
6. Add the `signIn` property and the two generated files.
7. Add `docs/distributions.md` for customers: repository layout, CI steps, registry mapping for
   scoped packages, and signing of the artifacts.

## Success criteria

1. From a fixture distribution repository with one fixture plugin, the command produces a VSIX
   and a CLI archive, and the installed CLI runs the plugin's rule.
2. Each of the six pre-build checks fails the build with its own error when violated.
3. Two builds from the same inputs produce identical `distribution.json` content and identical
   plugin artifact digests.
4. `npm run extension:package` and `npm run cli:package` produce the artifacts they produced
   before, with this repository's identity.
5. The generated entries contain no non-literal import, and the architecture check covers them.
6. A report from the built CLI names the distribution, and a report from this repository's own
   build omits the property.
7. The build makes no network request other than the ones that the existing packaging makes.
8. With `signIn` in the manifest, the generated client document is accepted by a Backstage test
   application that uses the generated settings, and the built extension signs in with it.
9. A build with built-in sign-in values signs in without sign-in values in the trusted
   configuration, and refuses a configuration that names other values.

## Test cases

- **Manifest.** Missing property, unknown property, 39-character commit, unscoped plugin,
  duplicate plugin, bad semantic version.
- **Engine pin.** Wrong commit; dirty checkout.
- **Lockfile.** Plugin absent from the lockfile; version mismatch; missing integrity; installed
  version differs from the lockfile.
- **Package content.** A `.node` file in a plugin; one in a dependency; an escaping symbolic
  link.
- **Identity.** Same publisher and name as this repository; same settings prefix.
- **Digest stability.** Rebuild after touching file times; rebuild after a one-byte change.
- **Side by side.** A tooling test checks that the two extension manifests share no setting key
  and no command identifier.
- **Trust.** A build with trust rejects a plain-policy configuration; a build without trust
  accepts it.
- **Built-in sign-in values.** A build with them signs in with an empty `signIn` object; a
  configuration with another authorization server, with another client, or with a catalog base
  URL of another origin is refused; a build without them requires the values in the
  configuration.
- **Sign-in.** A manifest without `signIn` writes no sign-in file; a URL that is not HTTPS, or
  that has a query, fails the build; the redirect URI in both files equals the one that the built
  extension sends.

## Exit criteria

The phase is complete, and Phase 6 may start, when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. A CI job builds the fixture distribution on Ubuntu, Windows, and macOS and runs the packaged
   harness against it.
3. The fixture distribution's VSIX passes the quick installed-editor selection in CI.
4. `docs/distributions.md` has been followed from an empty directory by someone other than its
   author, and the build succeeded.

# Hosted qualification and VS Code packages

The `CI` workflow runs on pushes, pull requests and manual dispatch. It uses the
pinned Node version in `.nvmrc`, locked dependencies, immutable action commits and
read-only repository permissions. Its independent jobs are:

| Job                               | Scope                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Full harness, Linux/Windows/macOS | Typecheck, lint, formatting, generated schema/build checks and **every** production `test/*.test.ts` file                 |
| Dependency audits                 | Full and production dependency audits; both must pass                                                                     |
| Full harness coverage             | Entire suite with JUnit, machine-readable counts and LCOV                                                                 |
| VSIX, Linux/Windows/macOS         | Self-contained package, entire suite using packaged Node/server, installed-extension tests in VS Code 1.106.3 and 1.145.2 |

The test runner discovers the complete compiled suite, records an inventory,
keeps test-file concurrency at one, and retains the existing 30-second per-test
bound. HTTP fixtures bind ephemeral loopback ports. No deployed Backstage or
production credentials are required. Any skipped test makes CI fail explicitly;
an OS limitation cannot silently turn into a passing reduced suite. The frozen
CEL corpus is exercised by production workers as part of the suite. Historical
Go/Python comparison programs in the separate ignored planning checkout are
historical evidence, not production tests or prerequisites for this workflow.

The packaged run starts the whole suite with the VSIX's pinned Node executable.
Real stdio and CLI subprocess cases use the packaged server/CLI entry points;
the remaining tests still use the compiled production source under test. There
is no replacement subset labeled as a full harness run.

`scripts/package-extension.mjs` bundles the editor client, copies the engine and
schemas, installs only locked production dependencies, includes the pinned Node
binary and license, generates a production CycloneDX SBOM, and builds a platform
VSIX with SHA-256 and build metadata. No repository checkout or global Node/npm
installation is needed by the installed extension. The language client's glob
dependency uses the audited 5.1.9 API because its file-operation implementation
still calls `Minimatch.makeRe`; other tooling uses patched 11.0.1. Audits remain
enabled, and editor integration tests exercise the actual packaged client.

The editor tests install the VSIX into an isolated extensions directory. A separate
test-driver extension loads the tests, so the product is **not** replaced by a
development-path override. Cases cover startup, diagnostics, reference completion,
versioned fixes, stale replay, save/watch invalidation and repair, restart, and
process shutdown. A conflicting workspace setting proves that workspace content
cannot select the trusted configuration. User/launcher configuration supplies
authority; the package contains no policy credentials. Watcher workspaces live
in native temporary directories rather than the ignored artifact tree.

Every run retains JUnit/count/inventory artifacts. Coverage includes `lcov.info`.
The three `vscode-*` artifacts contain native-target VSIX files, checksums, SBOM,
runtime/revision metadata, packaged-suite reports and editor result JSON. Artifacts
are retained for 14 days; this workflow does not publish to the Marketplace or
create releases. Download the appropriate target and install it using VS Code's
**Extensions: Install from VSIX** command. See [extension setup](../extensions/vscode/README.md).

Run equivalent checks locally with Node 24.20.0:

```sh
npm ci
npm run check
npm run extension:package
npm run test:packaged
# Linux requires a display; use Xvfb on a headless machine:
xvfb-run -a npm run test:extension
# On Windows/macOS or with a display:
npm run test:extension
npm run test:coverage
```

The `Backstage API drift` workflow remains a separate read-only scheduled/manual
network check and also runs when its fixture/discovery inputs change. Its GitHub
token is sent only to `api.github.com`, never to raw artifact hosts. Changed
upstream artifacts fail for review; the workflow does not silently update pins.

Hosted fixture/editor qualification does not establish real Backstage backend
authentication/processing semantics, JetBrains support, all CPU architectures,
interactive UI/upgrade behavior, Marketplace publication, or hosted confinement.
Those remain separate release gates. Consult the actual workflow run and retained
reports for results; failed/skipped jobs must not be reported as qualified.

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

The ordinary catastrophic-shaped RE2 case must return `false`. A separate
maximum-size stress case accepts only `false` or the typed production
`execution_timeout`, then requires pool recovery. Coverage/cloud CPU overhead
cannot guarantee completion at that size within the fixed 100 ms production
budget. No production deadline is raised and no test is skipped.

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
Editor profiles use short native temporary paths to stay within macOS socket
path limits. Each discovered `extensions/vscode/test/cases/*.case.ts` scenario runs
in its own fresh editor process, profile and workspace. The immutable installed
payload is shared only within one editor version. Setup, execution and cleanup
are recorded separately; failed scenarios cannot suppress later scenarios or the
other editor version. Sessions have a 120-second outer watchdog, and POSIX process
groups / Windows process trees bound crash cleanup.

`editor-results/` contains incrementally written JSON and JUnit, the discovered
scenario inventory, artifact revision/checksum metadata, per-case progress,
launch arguments and editor logs. A zero exit code without a matching completed
case report fails qualification. Incomplete cases are never reported as passes or
skips. Each OS also runs `test:extension:verify`, which injects an early assertion,
an editor crash and a cleanup failure. Each must fail its scenario and allow the
next independent scenario to pass. Its intentionally failing case reports live
under `verification-*`, separately from product qualification, with an explicit
verification summary. These are harness fault tests, not product recovery tests.

VSIX installation uses the pinned 1.145.2 CLI for both editor versions. The
1.106.3 CLI can abort on shutdown after successful installation with the upstream
[module-resolution crash](https://github.com/microsoft/vscode/pull/279806).
Installer provenance is recorded separately from the actual editor version;
every scenario executes in the requested, unmodified editor. This qualifies
installed behavior on the older editor, not its affected CLI installer. No test
failure is retried or accepted as a pass because installation appeared to finish.

Code-action readiness uses the existing 20-second bounded wait and the current
diagnostic on each query, as completion readiness does. Diagnostics can appear
before the editor's code-action context is ready; the harness must still receive
an actual guarded command. Crash cleanup sends one process-group kill, avoiding
a second kill of an already-terminated group on macOS. These changes do not retry
failed scenarios or increase production deadlines.

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
xvfb-run -a npm run test:extension:verify
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

## VS Code test remediation plan

The baseline at `6239437` has
816 engine/LSP tests and one sequential installed-extension scenario with ten
reported checkpoints, repeated on three operating systems and two editor versions.
Those checkpoints are not independent tests, and engine LCOV does not measure
extension-client coverage. Increment 1 now implements independent scenarios,
incremental reporting and runner failure verification. Increment 2 adds native
configuration rejection/recovery, server-crash/manual-restart and overlapping
lifecycle scenarios, plus a separate client coverage job on every OS. Further
increments below are still planned. Qualification requires the actual
hosted results for the candidate revision.

The client coverage gate executes the production extension entry point with
explicit VS Code/language-client adapters under Node's module hooks. It requires
90% lines and 85% branches, nonzero tests and zero skips. Its LCOV source inventory
must exactly match every `extensions/vscode/src/*.ts` file after source mapping;
empty 100% reports, missing sources and dependency/test contamination fail. Clean
installed-VSIX scenarios remain separate. Native denied-read fixtures use POSIX
permissions or a Windows ACL and first prove that access is actually denied.

Local debugging can select `npm run test:extension -- --case=<discovered-id>`.
Focused reports go to `editor-focused/`; CI rejects focused selection and runs the
complete declared inventory. Fixture-owned delayed-request races and deactivation
during validation are qualified in increment 3.

Keep the existing full source and packaged suites, dependency audits, native VSIX
builds and installed-payload assertions. Run behavior tests against the installed
product; only the separate driver is a development extension. A client unit test
or simulated remote host cannot substitute for an installed-editor result.

### Gap 1: failure recovery and lifecycle

**Changes:** Extend the fixture factory and independent-case runner from gap 5.
Add lifecycle cases under `extensions/vscode/test/`, with fresh editor sessions
where startup configuration or activation state differs. Separate client lifecycle
coordination from VS Code adapters only where needed to exercise deterministic
ordering. Retain production error handling and deadlines while testing them.

**Cases:**

- No configuration: remain stopped, explain configuration in output, then recover
  after a valid User Setting is supplied. Verify User Setting precedence over the
  environment and rejection of workspace/folder overrides.
- Relative, missing, unreadable, malformed, oversized and structurally invalid
  configuration; invalid/non-file/ambiguous source URIs and the 1001-file limit.
  Test the accepted boundaries too. Use a real denied-access fixture on an OS
  where permissions enforce it and a portable injected read failure in client
  tests; do not label a Windows permission simulation a native ACL test.
- Configuration that passes client selection but fails server initialization:
  report failure, leave no child process, then recover with corrected input.
- Terminate a running server, including during validation; characterize the
  language client's restart policy, make the intended bounded behavior explicit,
  and test eventual recovery or a stopped state recoverable by Restart. Assert
  that crash loops cannot spawn unbounded processes or notifications.
- Issue overlapping Stop/Restart commands and configuration changes. The final
  effective configuration must win; the operation queue must recover after a
  rejected start. Stop, window close and reload must clean up pending work and
  every child process. Deactivation during startup must also terminate cleanly.

Use the exposed server PID for external crash injection. Use fixture-owned
request gates for slow validation. Do not ship a product command that enables
test faults or rely on arbitrary sleeps to establish ordering.

**Acceptance:** All portable cases pass on the existing six OS/editor combinations;
OS-specific cases have explicitly required lanes. Failures identify their case
and lifecycle phase. No orphaned server remains, recovery needs no editor reinstall,
and repeated crash/restart cycles remain within the declared process/retry bounds.

### Gap 2: document races and workspace isolation

**Changes:** Add fixtures with multiple approved files, two folders, identical
basenames, an unapproved file and separate window profiles. Reuse the pinned local
catalog fixtures and response gates for delayed results. Drive actual VS Code
documents, edits, code actions and filesystem events through the installed client.

**Cases:**

- Request a fix, edit before applying it, and assert stale rejection with the
  entire intervening buffer preserved. Repeat after close/reopen, after restart,
  with Unicode/CRLF input, and after a relevant referenced file changes.
- Hold an old validation/completion response, make a newer edit, then release the
  old response. Assert that stale diagnostics never replace current diagnostics
  and that completion cancellation settles without corrupting later requests.
- Save or externally change a file while validation is held; delete, recreate,
  rename and atomically replace an approved dependency. Verify watcher refresh,
  repair and diagnostic clearing, including dirty-buffer versus disk precedence.
- Open a multi-root workspace with approved files in both roots. Verify correct
  file association, escaped filename characters, platform URI spelling and no
  edits or findings attached to a same-named unapproved file.
- Run two windows concurrently with distinct configured authorities and fixtures.
  Verify that buffers, caches, diagnostics and child-process cleanup do not cross
  windows. Test an overlapping approved path explicitly rather than assuming
  distinct folders prove isolation.

**Acceptance:** Use entered/released gate evidence to prove each race occurred.
Compare exact document text and versions, finding ownership and server lifetimes.
Run these cases on both editor versions on all three OS targets; repeat the
deterministic race group 20 times in a scheduled job without retrying failed runs
into success. Any data loss, cross-window contamination or stale fix is a blocker.

### Gap 3: Workspace Trust

**Changes:** Add trust-aware sessions to the explicit launcher introduced in
increment 1. It currently passes `--disable-workspace-trust` to preserve the
trusted baseline. Remove that flag for trust qualification and assert the actual
workbench state. The locked `@vscode/test-electron` runner adds the flag
unconditionally, so do not switch back to it for trust cases. Give each trust
case a fresh profile and folder outside trusted ancestor directories.

The driver must declare its own Restricted Mode support so it can inspect the
workbench while the product remains disabled. Keep the product's current
`untrustedWorkspaces.supported: false` declaration. Do not grant it a test-only
trust override or call its activation API to simulate the trust boundary.

**Cases:**

- Assert `workspace.isTrusted === false` before testing Restricted Mode. Verify
  that the installed product stays inactive, launches no server and contributes
  no product diagnostics, completions or fixes, even with valid launcher input.
- Open a trusted workspace with trust enforcement still enabled and verify the
  normal installed-product scenario. A run with trust disabled is not this case.
- Through workbench UI automation, grant trust, verify activation and normal
  behavior, then revoke trust and follow the editor's required reload behavior.
  Verify server cleanup and disabled functionality after the transition.
- Reopen with persisted trust, then open a new unrelated untrusted folder; verify
  that the previous decision does not contaminate the new case. Repeat the
  conflicting workspace configuration test across the transition.

VS Code's [testing guidance](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
states that extension tests cannot programmatically grant or revoke trust. Use
separate initial-state runs and actual UI automation for transitions, rather than
editing internal trust storage. The [manifest contract](https://code.visualstudio.com/api/extension-guides/workspace-trust)
disables this product until trust is granted; partial Restricted Mode support is
not part of this plan.

**Acceptance:** Initial trusted/untrusted cases pass on all six combinations.
First establish repeatable transition automation on Linux with the current pinned
editor, then qualify both versions on all three OS targets. Record effective
arguments, asserted trust state, product activation, process evidence and failure
screenshots. An unavailable transition lane remains an open requirement.

### Gap 4: environments, coexistence, upgrades and endurance

**Changes:** Add a scheduled/manual compatibility workflow and a release-candidate
gate that consumes exact VSIX artifacts with recorded revision and checksum.
Keep portable local cases in pull-request CI; place expensive sessions in explicit
compatibility lanes. Scheduled success does not qualify a different release SHA.

**Cases and environments:**

- Install a pinned YAML language extension alongside the product. Assert each
  extension's findings separately, exercise overlapping completion/code actions,
  and verify that product Stop does not remove the other extension's results.
- Qualify real Remote SSH and Dev Containers sessions using ephemeral Linux hosts
  and a pinned container image. Qualify WSL using an actual Windows editor and WSL
  distribution. Start each with an infrastructure preflight; provision a dedicated
  runner if the hosted Windows runner cannot provide the necessary environment.
  Running the extension tests directly inside Linux is not a WSL or remote test.
- For every remote case, verify the workspace extension runs on the remote host,
  installs the host-target VSIX, uses remote configuration/credentials and the
  bundled runtime, maps editor URIs correctly, refreshes files, applies fixes and
  cleans up on disconnect/reconnect. Verify the User Setting/environment selection
  actually visible to the remote extension host. URI/configuration incompatibility
  is product work to resolve before claiming remote support.
- Upgrade from a recorded previous supported VSIX to the candidate using the same
  profile and workspace. Verify settings, diagnostics, one live server per window,
  reload, disable/re-enable and uninstall/reinstall. Until a previous released VSIX
  exists, use two reproducible fixture package versions to test the mechanism and
  explicitly retain historical-release upgrade qualification as open.
- Exercise cold startup, rapid editing, watcher bursts and completion at 100 and
  1000 configured files, remaining within current configuration size limits. Run
  a 30-minute scheduled soak and a two-hour release soak with fixed workloads,
  periodic restarts and catalog interruption/recovery. Record readiness, latency
  percentiles, errors, child-process count and post-warmup RSS/handle trends for
  both the client host and server. Separate editor baseline overhead from product
  growth; retained state must plateau rather than grow with each operation.

The [remote-extension architecture](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
places workspace extensions with the workspace. These tests must establish that
our local-file assumptions still hold there; the manifest's workspace extension
kind alone is not qualification. Web and virtual workspaces remain outside the
current product contract, with explicit disabled-behavior tests.

**Acceptance:** Publish a support matrix containing exact editor, host architecture,
remote-extension/image version, artifact SHA and case results. Pin latency and
memory budgets from repeated measurements on declared fixtures before counting
performance qualification complete; retain the existing 20-second readiness
bound in the meantime. Missing infrastructure or failed preflight fails a required
lane and stays visible as unqualified. Remote support remains pending until its
actual session tests pass; require all claimed environments and upgrade/soak gates
at the release-candidate SHA before broad release.

### Gap 5: independent cases, evidence and client coverage

**Changes:** Refactor `extensions/vscode/test/suite.ts` into discovered, named cases
with reusable fixture builders, bounded event waits and unconditional cleanup.
Keep intentional steps within a scenario sequential, but restore its own fixtures
and product state before the next case. Use fresh processes/profiles for activation,
trust and upgrade scenarios. Poisoned cleanup must fail visibly and restart the
session before continuing independent cases.

Replace the fixed success-only case list in `scripts/test-extension.mjs` with
actual per-case JUnit and JSON: discovered/executed counts, result, duration,
failure phase, editor/OS/architecture, revision and installed VSIX checksum. Write
incremental results so an editor crash cannot erase earlier outcomes. Record an
interrupted active case as failed and remaining cases as unexecuted; never infer
passes from discovery or static labels. Attempt later independent sessions and
both editor versions even if one session fails, then return a failing aggregate.

Add a dedicated client coverage lane, separate from engine LCOV. Measure client
logic with explicit VS Code adapters/mocks and source-mapped coverage; exercise
configuration boundaries, URI conversions, start/stop scheduling and all recovery
branches. Target at least 90% client line and 85% branch coverage, with named tests
for every trust, configuration-authority and stale-edit boundary. A source-mapping
check must prove the report includes `extensions/vscode/src/` and excludes bundled
dependencies. Any instrumented-editor coverage package is a separately labeled
test artifact; clean VSIX tests remain required for shipped-payload behavior.

**Acceptance:** Deliberately fail an early case, crash an editor and fail cleanup in
runner verification. Confirm correct failure/nonexecution accounting, retained
logs, later independent execution and nonzero CI exit. Missing cases, zero tests,
skips, missing reports or coverage below the declared client thresholds fail CI.
Always retain case reports, client LCOV, editor logs and relevant UI screenshots;
add the new paths to the current upload step. Logs use synthetic credentials and
must not expose environment secrets. Preserve the existing engine coverage report.

### Delivery order and completion gates

| Increment | Work                               | Exit gate                                                                                |
| --------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| 1         | Gap 5 case isolation and reporting | Existing checkpoints become independently reported scenarios; runner failure checks pass |
| 2         | Gap 1 and gap 5 client coverage    | Recovery/lifecycle matrix passes; separate client coverage thresholds enforced           |
| 3         | Gap 2                              | Gated document/workspace races pass, including scheduled repetition                      |
| 4         | Gap 3                              | Real trust enforcement and UI transitions qualify on the declared matrix                 |
| 5         | Gap 4                              | Coexistence, actual remote/WSL, upgrade and measured endurance lanes qualify             |

Each increment should be a separate reviewable change with its own scenario
inventory and hosted run evidence. Preserve the current three native targets and
two pinned editor versions throughout. Add compatibility infrastructure before
marking its cases required; once required, do not silently skip unavailable lanes.
The inventory must distinguish implementation complete, executed and qualified at
a specific revision. No gap closes solely because a workflow or test file exists.

The first implementation step is increment 1. It makes later failures attributable
and prevents one broken scenario from suppressing evidence for the rest.

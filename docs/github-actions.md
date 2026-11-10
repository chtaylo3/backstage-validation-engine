# Hosted qualification and VS Code packages

The `CI` workflow runs on pushes, pull requests, and manual dispatch. CI means continuous
integration: automated checks of proposed source changes. The workflow uses the Node version in
`.nvmrc`, locked dependencies, immutable action commits, and read-only repository permissions. Its
jobs run independently:

| Job                                  | Scope                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Full harness, Linux/Windows/macOS    | Typecheck, lint, formatting, generated schema/build checks and every production `test/*.test.ts` file                     |
| Dependency audits                    | Full and production dependency audits. Both must pass                                                                     |
| Authenticated SSH fixture networking | Real key authentication over native host networking and published loopback ports; setup evidence only                     |
| Full harness coverage                | Entire suite with JUnit, machine-readable counts and LCOV                                                                 |
| CLI candidate                        | Exact-revision archive, published dependency lock, checksum and package provenance                                        |
| VSIX, Linux/Windows/macOS            | Self-contained package, entire suite using packaged Node/server, installed-extension tests in VS Code 1.106.3 and 1.145.2 |

A feature push and an open pull request produce separate runs with the same job names.
The push run checks the branch commit. The pull-request run checks its proposed merge with the base branch.
These results can differ when the base branch adds changes.

Client coverage requires tests to execute at least 90% of client code lines and 85% of branches.
Passing assertions alone do not satisfy those thresholds. Both `npm run check` and the separate client job enforce them.

The SSH networking job uses an isolated fixture and fresh keys. It checks both transports on native Linux for each push and pull request.
The remote qualification workflow also checks both transports before its full SSH lane, which explicitly selects host networking.
These preflights do not count as installed remote-editor sessions. See [SSH fixture networking](vscode-qualification.md#ssh-fixture-networking) for local development.

The test runner discovers the complete compiled suite and records an inventory. It runs one test
file at a time and retains the 30-second limit for each test. HTTP fixtures use temporary loopback
ports. Tests need no deployed Backstage instance or production credentials.

Any skipped test fails CI. An OS limitation cannot silently reduce the passing suite. Production
workers run the frozen CEL corpus as part of the suite.

The separate ignored planning checkout retains historical Go and Python comparison programs. They
are historical evidence. They are not production tests or prerequisites for this workflow.

The ordinary catastrophic-shaped RE2 case must return `false`. A separate maximum-size stress case
accepts only `false` or the typed production `execution_timeout`, then requires pool recovery.
Coverage/cloud CPU overhead cannot guarantee completion at that size within the fixed 100 ms
production budget. No production deadline is raised and no test is skipped.

The packaged run starts the whole suite with the VSIX's pinned Node executable. Real stdio and CLI
subprocess cases use the packaged server/CLI entry points. The remaining tests still use the
compiled production source under test. There is no replacement subset labeled as a full harness run.

`scripts/package-extension.mjs` bundles the editor client, copies the engine and schemas, and
installs only locked production dependencies. It includes the pinned Node binary and license and
generates a production CycloneDX software bill of materials (SBOM). It then builds a platform VSIX
with SHA-256 and build metadata. A VSIX is an installable extension package. The installed extension
needs no repository checkout or global Node or npm installation.

The language client's glob dependency uses the audited 5.1.9 API because its file-operation code
still calls `Minimatch.makeRe`. Other tooling uses patched 11.0.1. Audits remain enabled, and editor
integration tests exercise the packaged client.

`npm run cli:package` builds the CLI candidate archive.
It includes `npm-shrinkwrap.json`, an exact copy of the checked-in dependency lock.
Sidecars record the source revision, archive checksum, Node version, file inventory, dependency-lock checksum, and dirty-source status.
The `CLI candidate` job uploads these files as `cli-candidate` for 14 days.
Dirty local packages support development but cannot qualify as release candidates.

The editor tests install the VSIX into an isolated extensions directory. A separate test-driver
extension loads the tests, so the product is not replaced by a development-path override. Cases
cover startup, diagnostics, reference completion, versioned fixes, stale replay, save/watch
invalidation and repair, restart, and process shutdown. A conflicting workspace setting proves that
workspace content cannot select the trusted configuration.

User or launcher configuration supplies authority. The package contains no policy credentials.
Watcher workspaces live in native temporary directories rather than the ignored artifact tree.
Editor profiles use short native temporary paths to stay within macOS socket path limits. Each
discovered `extensions/vscode/test/cases/*.case.ts` scenario runs in its own fresh editor process,
profile and workspace.

The immutable installed payload is shared only within one editor version. Setup, execution and
cleanup are recorded separately. Failed scenarios cannot suppress later scenarios or the other
editor version. Sessions have a 120-second outer watchdog, and POSIX process groups / Windows
process trees bound crash cleanup.

`editor-results/` contains incrementally written JSON and JUnit, the discovered scenario inventory,
artifact revision/checksum metadata, per-case progress, launch arguments and editor logs. A zero
exit code without a matching completed case report fails qualification. Incomplete cases are never
reported as passes or skips. Each OS also runs `test:extension:verify`, which injects an early
assertion, an editor crash and a cleanup failure.

Each must fail its scenario and allow the next independent scenario to pass. Its intentionally
failing case reports live under `verification-*`, separately from product qualification, with an
explicit verification summary. These are harness fault tests, not product recovery tests.

VSIX installation uses the pinned 1.145.2 CLI for both editor versions. The 1.106.3 CLI can abort on
shutdown after successful installation with the upstream
[module-resolution crash](https://github.com/microsoft/vscode/pull/279806). Installer provenance is
recorded separately from the actual editor version. Every scenario executes in the requested,
unmodified editor. This qualifies installed behavior on the older editor, not its affected CLI
installer. No test failure is retried or accepted as a pass because installation appeared to finish.

Code-action readiness uses the existing 20-second bounded wait and the current diagnostic on each
query, as completion readiness does. Diagnostics can appear before the editor's code-action context
is ready. The harness must still receive an actual guarded command. Crash cleanup sends one
process-group kill, avoiding a second kill of an already-terminated group on macOS. These changes do
not retry failed scenarios or increase production deadlines.

Every run retains JUnit/count/inventory artifacts. Coverage includes `lcov.info`. The three
`vscode-*` artifacts contain native-target VSIX files, checksums, SBOM, runtime/revision metadata,
packaged-suite reports and editor result JSON. Artifacts remain available for 14 days.

This workflow does not publish to the Marketplace or create releases. Download the appropriate
target and install it using VS Code's Extensions: Install from VSIX command. See
[extension setup](../extensions/vscode/README.md).

Run equivalent checks locally with Node 24.22.1:

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

The `Backstage API drift` workflow remains a separate read-only scheduled/manual network check and
also runs when its fixture/discovery inputs change. Its GitHub token is sent only to
`api.github.com`, never to raw artifact hosts. Changed upstream artifacts fail for review. The
workflow does not silently update pins.

Hosted fixture/editor qualification does not establish real Backstage backend
authentication/processing semantics, JetBrains support, all CPU architectures, interactive
UI/upgrade behavior, Marketplace publication, or hosted confinement. Those remain separate release
gates. Consult the actual workflow run and retained reports for results. Do not report failed or
skipped jobs as qualified.

## VS Code test remediation plan

The baseline at `6239437` has 816 engine and LSP tests. It also has one sequential
installed-extension scenario with ten reported checkpoints, repeated on three operating systems and
two editor versions. Those checkpoints are not independent tests. Engine LCOV does not measure
extension-client coverage. Increment 1 implements independent scenarios, incremental reporting, and
runner failure verification. Increment 2 adds native configuration rejection and recovery, server
crash and manual restart, overlapping lifecycle scenarios, and client coverage on every OS.

Increment 3 adds deterministic document races, simultaneous windows, multi-root workspaces, native
close and reload, and a weekly or manual repetition workflow. Increment 4 adds five native Workspace
Trust cases. They use visible controls through Chrome DevTools Protocol input events, screenshots,
and a driver that can inspect Restricted Mode. Broader compatibility remains in progress.
Qualification requires hosted results for the candidate revision.

Increment 5 implements separate compatibility, remote, load and endurance lanes, plus an
exact-artifact release verdict. See the [support/evidence matrix](vscode-qualification.md) for
commands, environment pins, workload definitions, acceptance checks and remaining qualification
limits. Long workflows consume the actual CI VSIX rather than rebuilding a different artifact with
the same source revision.

The first increment 3 matrix at `d8b2f15` passed 74 installed-editor executions on Linux and
Windows. Its macOS run exposed a transport-error shutdown status race and the native behavior where
closing the last window leaves the application running. The follow-up marks transport failures
disconnected immediately and uses Quit to complete the suite. It observes the closed workbench and
dead server before it terminates the remaining owned macOS application. The failed run is retained
as evidence, not counted as qualification.

Trust cases omit `--disable-workspace-trust`, assert enforcement and the absence of a product trust
override, and never call product activation while restricted. Grant and revoke use native pointer
input on the visible Trust pane. Revocation must cause a real editor reload and terminate the
previous server. Persistence and unrelated-folder cases launch a second editor process with the same
profile. `native-sessions.json`, asserted API state, UI action records and screenshots are retained.
The product's Restricted Mode declaration remains unchanged.

Increment 2 qualified at `d3884ed`:
[all eleven jobs passed](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42445289384).
This included 851 full-harness tests, 44 installed-editor executions per OS, and client coverage on
all three operating systems. No tests were skipped.

The client coverage gate executes the production extension entry point with explicit VS
Code/language-client adapters under Node's module hooks. It requires 90% lines and 85% branches,
nonzero tests and zero skips. Its LCOV source inventory must exactly match every
`extensions/vscode/src/*.ts` file after source mapping. Empty 100% reports, missing sources, and
included dependency or test code fail the check. Clean installed-VSIX scenarios remain separate.
Native denied-read fixtures use POSIX permissions or a Windows ACL and first prove that access is
actually denied.

Local debugging can select `npm run test:extension -- --case=<discovered-id>`. Focused reports go to
`editor-focused/`. CI rejects focused selection and runs the complete declared inventory.
Fixture-owned delayed-request races and deactivation during validation are qualified in increment 3.

Race scenarios use authenticated, fixture-owned loopback controls separate from the two pinned
catalog APIs. `catalog-events.json` records request entry, cancellation/release and version
provenance. A race fails if it lacks the required gate observation. Stale diagnostics are checked
against current editor versions.

Edit-delivery races suspend only the owned packaged server and record execute/didChange order in its
protocol trace. They then require the actual VS Code client to reject the old-version edit. POSIX
uses process stop/continue. Windows uses documented OpenThread/SuspendThread/ResumeThread APIs
through a fixture-only PowerShell helper.

Two-window scenarios share one approved disk path but use separate profiles, authorities, buffers
and server PIDs. Their barrier evidence proves unsaved edits and Stop do not cross windows.
Multi-root cases include matching basenames, literal glob metacharacters and an unapproved file.
Dirty-buffer cases explicitly preserve VS Code's external-edit save-conflict protection.

Native close/reload scenarios use a normal workbench driver because VS Code's extension-test mode
terminates when its test host reloads. The product still comes from the installed VSIX. Close
success requires parent-observed editor exit and owned-server death before parent process cleanup.
Reload requires a distinct server PID and fresh diagnostics. These observations are retained with
the case.

`VS Code race repetition` runs weekly/manual on all three OS targets and both pinned editor
versions. Its default is 20 fresh repetitions, with separate reports for every iteration. Any failed
repetition fails the job even if later repetitions pass. A manual one-repetition mode supports
infrastructure qualification.

Do not describe it as the full repetition requirement. Run locally with
`npm run test:extension -- --races --repeat=20`. `scripts/build-extension-tests.mjs` rebuilds only
the test driver when debugging test changes against an unchanged VSIX.

Keep the existing full source and packaged suites, dependency audits, native VSIX builds and
installed-payload assertions. Run behavior tests against the installed product. Only the separate
driver is a development extension. A client unit test or simulated remote host cannot substitute for
an installed-editor result.

### Gap 1: failure recovery and lifecycle

Changes: Extend the fixture factory and independent-case runner from gap 5. Add lifecycle cases
under `extensions/vscode/test/`, with fresh editor sessions where startup configuration or
activation state differs. Separate client lifecycle coordination from VS Code adapters only where
needed to exercise deterministic ordering. Retain production error handling and deadlines while
testing them.

Cases:

- No configuration: remain stopped, explain configuration in output, then recover after a valid User
  Setting is supplied. Make sure that User Settings take precedence over the environment and reject
  workspace or folder overrides.
- Relative, missing, unreadable, malformed, oversized and structurally invalid configuration.
  Invalid/non-file/ambiguous source URIs and the 1001-file limit. Test the accepted boundaries too.
  Use a real denied-access fixture where the OS enforces permissions. Also inject a portable read
  failure in client tests. Do not label a Windows permission simulation a native ACL test.
- Configuration that passes client selection but fails server initialization: report the failure.
  Leave no child process. Then recover with corrected input.
- Terminate a running server, including during validation. Characterize the language client's
  restart policy, make the intended bounded behavior explicit, and test eventual recovery or a
  stopped state recoverable by Restart. Assert that crash loops cannot spawn unbounded processes or
  notifications.
- Issue overlapping Stop/Restart commands and configuration changes. The final effective
  configuration must win. The operation queue must recover after a rejected start. Stop, window
  close and reload must clean up pending work and every child process. Deactivation during startup
  must also terminate cleanly.

Use the exposed server PID for external crash injection. Use fixture-owned request gates for slow
validation. Do not ship a product command that enables test faults or rely on arbitrary sleeps to
establish ordering.

Acceptance: All portable cases pass on the existing six OS and editor combinations. OS-specific
cases have explicitly required lanes. Failures identify their case and lifecycle phase. No orphaned
server remains, recovery needs no editor reinstall, and repeated crash/restart cycles remain within
the declared process/retry bounds.

### Gap 2: document races and workspace isolation

Changes: Add fixtures with multiple approved files, two folders, identical basenames, an unapproved
file and separate window profiles. Reuse the pinned local catalog fixtures and response gates for
delayed results. Drive actual VS Code documents, edits, code actions and filesystem events through
the installed client.

Cases:

- Request a fix, edit before applying it, and assert stale rejection with the entire intervening
  buffer preserved. Repeat after close/reopen, after restart, with Unicode/CRLF input, and after a
  relevant referenced file changes.
- Hold an old validation/completion response, make a newer edit, then release the old response.
  Assert that stale diagnostics never replace current diagnostics and that completion cancellation
  settles without corrupting later requests.
- Save or externally change a file while validation is held. Delete, recreate, rename and atomically
  replace an approved dependency. Verify watcher refresh, repair and diagnostic clearing, including
  dirty-buffer versus disk precedence.
- Open a multi-root workspace with approved files in both roots. Make sure that file association,
  escaped filename characters, and platform URI spelling are correct. Make sure that a same-named
  unapproved file receives no edits or findings.
- Run two windows concurrently with distinct configured authorities and fixtures. Verify that
  buffers, caches, diagnostics and child-process cleanup do not cross windows. Test an overlapping
  approved path explicitly rather than assuming distinct folders prove isolation.

Acceptance: Use entered/released gate evidence to prove each race occurred. Compare exact document
text and versions, finding ownership and server lifetimes. Run these cases on both editor versions
on all three OS targets. Repeat the deterministic race group 20 times in a scheduled job without
retrying failed runs into success. Any data loss, cross-window contamination or stale fix is a
blocker.

### Gap 3: Workspace Trust

Changes: Add trust-aware sessions to the explicit launcher introduced in increment 1. It currently
passes `--disable-workspace-trust` to preserve the trusted baseline. Remove that flag for trust
qualification and assert the actual workbench state. The locked `@vscode/test-electron` runner adds
the flag unconditionally, so do not switch back to it for trust cases. Give each trust case a fresh
profile and folder outside trusted ancestor directories.

The driver must declare its own Restricted Mode support so it can inspect the workbench while the
product remains disabled. Keep the product's current `untrustedWorkspaces.supported: false`
declaration. Do not grant it a test-only trust override or call its activation API to simulate the
trust boundary.

Cases:

- Assert `workspace.isTrusted === false` before testing Restricted Mode. Even with valid launcher
  input, make sure that the installed product stays inactive and launches no server. Make sure that
  it supplies no diagnostics, completions, or fixes.
- Open a trusted workspace with trust enforcement still enabled and verify the normal
  installed-product scenario. A run with trust disabled is not this case.
- Through workbench UI automation, grant trust, verify activation and normal behavior, then revoke
  trust and follow the editor's required reload behavior. Verify server cleanup and disabled
  functionality after the transition.
- Reopen with persisted trust, then open a new unrelated untrusted folder. Verify that the previous
  decision does not contaminate the new case. Repeat the conflicting workspace configuration test
  across the transition.

VS Code's
[testing guidance](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
states that extension tests cannot programmatically grant or revoke trust. Use separate
initial-state runs and actual UI automation for transitions, rather than editing internal trust
storage. The [manifest contract](https://code.visualstudio.com/api/extension-guides/workspace-trust)
disables this product until trust is granted. Partial Restricted Mode support is not part of this
plan.

Acceptance: Initial trusted/untrusted cases pass on all six combinations. First establish repeatable
transition automation on Linux with the current pinned editor, then qualify both versions on all
three OS targets. Record effective arguments, asserted trust state, product activation, process
evidence and failure screenshots. An unavailable transition lane remains an open requirement.

### Gap 4: environments, coexistence, upgrades and endurance

Changes: Add a scheduled/manual compatibility workflow and a release-candidate gate that consumes
exact VSIX artifacts with recorded revision and checksum. Keep portable local cases in pull-request
CI. Place expensive sessions in explicit compatibility lanes. Scheduled success does not qualify a
different release SHA.

Cases and environments:

- Install a pinned YAML language extension alongside the product. Assert each extension's findings
  separately. Exercise overlapping completion and code actions. Make sure that product Stop does not
  remove the other extension's results.
- Qualify real Remote SSH and Dev Containers sessions using ephemeral Linux hosts and a pinned
  container image. Qualify WSL using an actual Windows editor and WSL distribution. Start each with
  an infrastructure preflight. Provision a dedicated runner if the hosted Windows runner cannot
  provide the necessary environment. Running the extension tests directly inside Linux is not a WSL
  or remote test.
- For each remote case, make sure that the workspace extension runs on the remote host and installs
  the host-target VSIX. Make sure that it uses remote configuration, credentials, and the bundled
  runtime. Exercise URI mapping, file refresh, fixes, and cleanup on disconnect and reconnect.
  Verify the User Setting/environment selection actually visible to the remote extension host.
  URI/configuration incompatibility is product work to resolve before claiming remote support.
- Upgrade from a recorded previous supported VSIX to the candidate using the same profile and
  workspace. Verify settings, diagnostics, one live server per window, reload, disable and
  re-enable, and uninstall and reinstall. Until a previous released VSIX exists, use two
  reproducible fixture package versions to test the mechanism and explicitly retain
  historical-release upgrade qualification as open.
- Exercise cold startup, rapid editing, watcher bursts, and completion at 100 and 1000 configured
  files. Stay within current configuration size limits. Run a 30-minute scheduled soak and a
  two-hour release soak with fixed workloads, periodic restarts and catalog interruption/recovery.
  Record readiness, latency percentiles, errors, child-process count and post-warmup RSS/handle
  trends for both the client host and server. Separate editor baseline overhead from product growth.
  Retained state must reach a stable level rather than grow with each operation.

The
[remote-extension architecture](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
places workspace extensions with the workspace. These tests must establish that our local-file
assumptions still hold there. The manifest's workspace extension kind alone is not qualification.
Web and virtual workspaces remain outside the current product contract, with explicit
disabled-behavior tests.

Acceptance: Publish a support matrix containing exact editor, host architecture,
remote-extension/image version, artifact SHA and case results. Pin latency and memory budgets from
repeated measurements on declared fixtures before counting performance qualification complete.
Retain the existing 20-second readiness bound in the meantime. Missing infrastructure or failed
preflight fails a required lane and stays visible as unqualified. Remote support remains pending
until its actual session tests pass. Require all claimed environments and upgrade/soak gates at the
release-candidate SHA before broad release.

### Gap 5: independent cases, evidence and client coverage

Changes: Refactor `extensions/vscode/test/suite.ts` into discovered, named cases with reusable
fixture builders, bounded event waits and unconditional cleanup. Keep intentional steps within a
scenario sequential, but restore its own fixtures and product state before the next case. Use fresh
processes/profiles for activation, trust and upgrade scenarios. Poisoned cleanup must fail visibly
and restart the session before continuing independent cases.

Replace the fixed success-only case list in `scripts/test-extension.mjs` with per-case JUnit and
JSON results. Record discovered and executed counts, result, duration, failure phase, editor, OS,
architecture, revision, and installed VSIX checksum. Write incremental results so an editor crash
cannot erase earlier outcomes. Record an interrupted active case as failed and remaining cases as
unexecuted. Never infer passes from discovery or static labels. Attempt later independent sessions
and both editor versions even if one session fails, then return a failing aggregate.

Add a dedicated client coverage lane, separate from engine LCOV. Measure client logic with explicit
VS Code adapters/mocks and source-mapped coverage. Exercise configuration boundaries, URI
conversions, start/stop scheduling and all recovery branches. Target at least 90% client line and
85% branch coverage, with named tests for every trust, configuration-authority and stale-edit
boundary.

A source-mapping check must prove the report includes `extensions/vscode/src/` and excludes bundled
dependencies. Any instrumented-editor coverage package is a separately labeled test artifact. Clean
VSIX tests remain required for shipped-payload behavior.

Acceptance: Deliberately fail an early case, crash an editor and fail cleanup in runner
verification. Confirm correct failure/nonexecution accounting, retained logs, later independent
execution and nonzero CI exit. Missing cases, zero tests, skips, missing reports or coverage below
the declared client thresholds fail CI. Always retain case reports, client LCOV, editor logs and
relevant UI screenshots.

Add the new paths to the current upload step. Logs use synthetic credentials and must not expose
environment secrets. Preserve the existing engine coverage report.

### Delivery order and completion gates

| Increment | Work                                  | Exit gate                                                                                                   |
| --------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1         | Gap 5 case isolation and reporting    | Existing checkpoints become independently reported scenarios. Runner failure checks pass                    |
| 2         | Gap 1 and gap 5 client coverage       | Recovery/lifecycle matrix passes. Separate client coverage thresholds enforced                              |
| 3         | Gap 2                                 | Gated document/workspace races pass, including scheduled repetition                                         |
| 4         | Gap 3                                 | Real trust enforcement and UI transitions qualify on the declared matrix                                    |
| 5         | Gap 4                                 | Coexistence, actual remote/WSL, upgrade and measured endurance lanes qualify                                |
| 6         | Real local Backstage and both clients | A repeatable seeded Backstage application passes CLI and installed-VSIX tests locally and in GitHub Actions |

Deliver each increment as a separate reviewable change with its own scenario inventory and hosted
run evidence. Preserve the current three native targets and two pinned editor versions throughout.
Add compatibility infrastructure before its cases become required. Once a lane is required, do not
silently skip it when unavailable. The inventory must distinguish implementation complete, executed
and qualified at a specific revision. No gap closes solely because a workflow or test file exists.

The first implementation step is increment 1. It makes later failures attributable and prevents one
broken scenario from suppressing evidence for the rest.

### Increment 6: real local Backstage and client tests

Status: implementation complete. Exact-candidate local and hosted qualification remains open.
This increment follows the existing five remediation increments.
The [detailed design](backstage-release-test-plan.md) defines the application, sample data,
commands, scenarios and release gates. It is separate from phase 6 of the broader product roadmap.

The [environment guide](../test/integration/backstage/README.md) describes the shared runner and local commands.
The dedicated `Backstage release qualification` workflow runs only after an explicit manual release request.
It accepts direct dispatch or a guarded call from the existing CI workflow.
Supply a full candidate commit. Select its workflow ref. The workflow requires both revisions to match.
It downloads that revision's CLI archive and Linux VSIX from CI, then invokes the shared release runner.
Only declared reports and sanitized logs are uploaded. Credentials and SQLite files remain outside those paths.

GitHub requires the new workflow on the default branch before its first standalone dispatch.
See the [manual-dispatch requirement](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).
To test a candidate branch before that registration, dispatch the existing CI workflow with the explicit release option:

```sh
gh workflow run ci.yml --ref CANDIDATE_REF -F qualify_backstage=true -f revision=FULL_CANDIDATE_SHA
```

This release job waits for the CLI candidate, then calls the shared workflow at the same revision.
It retrieves the Linux VSIX when its artifact becomes available and runs alongside the ordinary editor checks.
The aggregate release verifier still requires a successful CI run for that candidate.
The option defaults to false. Pushes, pull requests, and ordinary manual CI runs cannot start the Docker suite.
The called job also requires a manual-dispatch event and an exact workflow and candidate match.

The aggregate extension verifier also requires this workflow's successful report, including when the manual CI release job calls it.
It compares client checksums, required cases, application packages and locks, sample data, and policy against the same candidate.
Missing cases, changed inputs, or failed cleanup block the verdict.

Run a real Backstage application with its frontend, backend, authentication and SQLite files. A
versioned JSON dataset enters through actual catalog ingestion. Backstage creates and updates the
database through its normal processing. The packaged CLI and installed VSIX use the same application
and signed policy. The current simulated API fixtures retain their existing test scope.

Use one optional development environment with isolated locked dependencies. One Node runner and one
Docker Compose definition perform image construction, startup, ingestion, tests, reset and cleanup
locally and in GitHub Actions. A shared Linux test image runs the packaged CLI and automated editor
beside Backstage on the Compose network. The Windows baseline uses Ubuntu 24.04 under WSL 2 and a
checkout inside ext4.

Follow the [checkout transition plan](wsl-development-transition-plan.md). Restart scenarios
preserve SQLite state. Full reset recreates the database. The environment stays excluded from
released CLI and extension packages.

The full image build and real-backend suite run only during release qualification or explicit local
development tests. Pull requests, merges, ordinary pushes and scheduled checks do not build or start
this environment. The dedicated workflow requires an explicit release candidate and runs before
publication. Static dataset and runner checks can run without Docker.

Acceptance requires a documented local release-profile run and a successful GitHub Actions run for
the same candidate revision and declared Backstage versions. Both pinned editor versions and the
packaged CLI must exercise actual ingestion, mutations, authentication, recovery, persistent
restart, reset and cleanup. Reports retain exact versions, package digests, sample-data and policy
digests, actual case counts and sanitized logs. Missing required cases or infrastructure leave this
increment open. Planning files do not count as executed tests.

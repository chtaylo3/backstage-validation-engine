# VS Code qualification evidence

Implementation records which features exist. Qualification records which required tests passed for a
specific candidate. A workflow file, a successful short test of the harness, or a build from another
revision does not complete qualification.

| Area                       | Implemented qualification                                                                                                                                             | Evidence required before support is claimed                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable desktop           | Installed VSIX, 44 independent scenarios on Ubuntu 24.04 x64, Windows 2025 x64 and macOS 15 arm64, VS Code 1.106.3 and 1.145.2                                        | All six combinations at the candidate SHA. No failed or unexecuted cases                                                                                                          |
| Races and native lifecycle | Entered/cancelled/released catalog gates, suspended-server apply delivery, watchers, multi-root and two real windows, native reload and close                         | 20 independent repetitions per OS and editor, with every earlier failure retained                                                                                                 |
| Workspace Trust            | Restricted Mode, visible grant/revoke, actual reload, persisted consent and unrelated folder isolation                                                                | Native trust API state, no product override, screenshots, UI actions and owned server cleanup on all six combinations                                                             |
| YAML coexistence           | Red Hat YAML 1.19.1, independent findings, overlapping completions, guarded fix and formatting, continued YAML validation after product Stop                          | Both editor versions on all three OS targets                                                                                                                                      |
| Package lifecycle          | Fixture predecessor 0.0.1 → candidate 0.1.0, disable/re-enable, uninstall/reinstall, persistent User Settings and one native server                                   | Both versions on all three OS targets. A real historical release remains unqualified until a supported predecessor exists                                                         |
| Virtual workspace          | Native custom filesystem workspace. Installed product stays inactive without diagnostics, fixes or completions                                                        | Both versions on all three OS targets. This is not a browser test                                                                                                                 |
| Remote SSH                 | Native Linux desktop, Remote SSH 0.120.0, authenticated ephemeral container host                                                                                      | Assert `remoteName`, hostname, host-target installed VSIX/revision, bundled runtime, visible User Setting, URI behavior, watcher/fix/completion, disconnect cleanup and reconnect |
| Dev Containers             | Native Linux desktop, Dev Containers 0.430.0, actual attached container workspace                                                                                     | Same remote assertions. Running local tests inside Docker cannot satisfy this lane                                                                                                |
| WSL                        | Native Windows desktop, WSL extension 0.104.3, isolated imported WSL2 distro containing the Linux candidate                                                           | Actual WSL2 kernel and remote extension host. Failed virtualization/import preflight fails the required lane                                                                      |
| Load and endurance         | 100/1000 configured files, cold editor readiness, dirty edit and native watcher bursts, completion, periodic restarts and catalog authorization interruption/recovery | Native client/server RSS and handles, one owned server, latency percentiles and post-warmup growth checks. Full 30-minute scheduled and two-hour release workloads                |

Remote fixtures use the immutable Ubuntu 24.04 base manifest
`sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852`. Reports retain the built
image ID, editor server commit/archive checksum, remote extension version, runner image, revision
and VSIX checksum. WSL imports a root filesystem exported by the Linux lane and verifies its
checksum and revision. The container and WSL distribution belong only to the workflow and are
removed after process-death observations.

Container hosts use Docker's init process to reap exited descendants. Disconnect probes retain
process state on failure and collect remote extension-host logs before removing the host. Windows
editor metadata resolves both flat resources and the commit-directory layout used by newer archives.

## Running the qualification

`ci.yml` builds each OS candidate and runs the source, packaged and portable editor harness.
`vscode-races.yml` and `vscode-compatibility.yml` download those exact candidate artifacts. They
verify VSIX and runtime checksums and revision, extract the installed payload, and compile the
driver from the same checkout. They do not rebuild another product VSIX for qualification.

Fixture predecessors are identified separately and cannot count as historical-release coverage. The
immutable candidate is uploaded immediately after packaging so independent remote and endurance
lanes can run concurrently with portable tests. The release verdict requires the entire CI run to
succeed. It matches every lane to the same checksum in the final CI evidence.

The shared command launcher runs the native VS Code executable with its JavaScript command script.
It sets `ELECTRON_RUN_AS_NODE=1` and passes each argument without a command shell. This avoids
`DEP0190` and shell interpretation of argument text. The launcher clears `VSCODE_DEV` and
`VSCODE_IPC_HOOK_CLI` before it starts a command. It keeps the existing isolated profiles and pinned
installer version. It supports both flat and versioned Windows resource directories.

Run `npm run test:extension:cli` after packaging to test the command launcher. CI runs this test on
all three OS targets and retains `cli-results/results.json`. The test installs, lists, removes and
reinstalls the exact candidate package. It uses paths with spaces, Unicode and shell characters. It
also requires a nonzero result for a missing package and rejects `DEP0190`. Separate process tests
cover literal arguments, output capture, output limits and termination of a command and its child
process after a timeout.

The compatibility workflow has three manual modes:

- `quick`: coexistence, package lifecycle, virtual workspace, both load sizes and the three real
  remote lanes. Long soaks and the release verdict are omitted.
- `full`: the same lanes plus 30 minutes of fixed workload per editor and OS.
- `release`: two hours of fixed workload per editor and OS, followed by a strict verdict. That
  verdict also requires successful portable CI and all 20 race repetitions at this revision with the
  same OS-specific VSIX checksums.

The release verdict rejects missing or duplicate cases, wrong versions, focused reports, and
unfinished cleanup. It also rejects short or empty resource reports, earlier failed race
repetitions, missing native environments, and different candidate artifacts. It does not publish an
extension. No remote environment is optional in this verdict.

For local debugging, use `npm run test:extension -- --trust`,
`npm run test:extension:compatibility`, `npm run test:extension:load`, or
`npm run test:extension:remote -- --mode=ssh-remote`. A local 60-second soak mechanism check is
available with `BVE_SOAK_SECONDS=60`. CI rejects that duration. Every scheduled or release soak, a
sustained workload test, must run for its full declared duration.

The load and soak fixture contains one Group. The remaining files are Components. Only the edited
Component initially violates the policy. It uses the production 25 ms debounce, a five-second engine
deadline and the existing 20-second readiness bound. A separate zero-debounce saturation case makes
all 999 Components violate policy.

Each edit must complete or publish a typed bound. Guarded fixes remain unavailable after incomplete
validation. The test preserves exact buffer text, then verifies that fixes recover with a smaller
source. Its observations do not establish capacity to complete every zero-debounce 1000-violation
workload. Performance budgets are explicit in `resource-metrics.json`. Local timings do not qualify
hosted hardware.

The client baseline is measured after product Stop and includes the loaded client module, while cold
readiness starts at the parent editor launch timestamp. Catalog authorization is interrupted and
recovered live each minute, with a new denied and then successful authenticated read required.
Recovery must keep the same server PID, the process identifier. Fifteen-minute process epochs allow
post-warmup growth to be measured before periodic restarts switch between both pinned catalog
versions. Watcher files have bounded, stable content size throughout the workload.

The load lane exposed duplicate native source/baseline preparation by validation and completion.
Catalog-backed LSP generations now share that immutable local preparation before catalog HTTP. Each
still enforces the original deadline and generation cancellation. An actual held-HTTP test on both
API pins verifies that local completion remains available, and a newer edit cancels the old
generation. There is no persistent cross-request source cache. Repeated structural contract checks
reuse only the parser's own deeply frozen output identities.

Mutable inputs, clones, and caller-frozen counterfeits still receive full validation. Authority,
request bindings, cancellation, and deadlines are checked separately. Filesystem capture overlaps at
most eight approved reads, reduced further by the request/file byte budgets. Each read still checks
root/path containment, descriptor and named-file identity, links, UTF-8, mutations and cancellation.
All reads in a failed batch finish before rejection. The reader publishes no partial snapshot.

Native descriptor-barrier tests verify concurrency bounds and awaited close, alongside aggregate
overflow/recovery and the original deadline tests. Read buffers use the checked file length plus one
growth-detection byte, capped at 64 KiB. Tiny files no longer allocate the full chunk allowance, and
a file that grows during capture is rejected immediately with its descriptor closed. The pinned
native adapter and fixed CEL worker slots are prepared during LSP initialization. This static
dependency preparation remains inside measured cold editor readiness.

Source capture and all validation still share one original five-second request deadline. Native
policy composition reuses its own detached JSON checkpoint between successive policies. Each policy
output still receives full bounded JSON checks. Unchanged canonical output needs no second
serialization or comparison. Authored input stays detached and frozen, and mutation provenance is
checked against both native adapter pins. There is no cross-request entity-result cache.

Native steps yield before each entity and at the same eight-millisecond cooperative bound used by
parsing, with deadline/cancellation checks around every policy call. Tests also inject queued
cancellation on both adapter pins. Resource comparisons require ten warmup operations per process
and at least three later samples. A sample at each restart records the new process epoch. The 128
MiB RSS, 64-handle and 0.15 MiB/operation growth caps remain unchanged. Negative checker tests
reject post-warmup RSS/handle leaks, persistent slopes and insufficient live-process evidence.

Each native process receives its own application shared-data directory as well as an isolated user
profile and extension directory. Remote extension pins are checked against both editor versions
before launching. Dev Containers attach consent uses a visible native workbench dialog and records
the click for the workflow-owned container. It does not modify the extension's private consent
storage.

## SSH fixture networking

Native Linux CI explicitly selects `--ssh-network=host` for the full SSH lane.
The fixture shares the runner network and starts SSH on an available loopback port.
The ordinary CI workflow and remote qualification workflow authenticate over both supported transports before qualification.

Local development defaults to `--ssh-network=auto`. It selects published ports outside CI, including Docker Desktop and WSL2.
Auto selection also keeps published ports when a Desktop or WSL2 environment sets `CI=true`.
The fixture uses a bridge network and container port 22. Docker assigns a host port published only on `127.0.0.1`.
The harness reads that mapping and uses it in the real SSH configuration.
This avoids reliance on Docker Desktop's optional [host networking](https://docs.docker.com/engine/network/drivers/host/).
Docker documents [loopback port publication](https://docs.docker.com/engine/network/port-publishing/) separately from host networking.

Test authenticated connectivity without starting an editor:

```sh
npm run test:extension:ssh-network
# Explicit development route:
npm run test:extension:ssh-network -- --network=published
# Native Linux CI route:
npm run test:extension:ssh-network -- --network=host
```

Each preflight creates and removes its own container and key pair.
It verifies the remote hostname after key authentication and records its selected transport and endpoint.
Reports under `.artifacts/vscode/ssh-network-preflight/` record zero product sessions.
A successful preflight cannot satisfy the four installed SSH disconnect/reconnect cases.

For a full local run, build and test the same candidate revision with the pinned Node version:

```sh
BVE_SSH_CANDIDATE_REVISION="$(git rev-parse HEAD)"
GITHUB_SHA="$BVE_SSH_CANDIDATE_REVISION" npm run extension:package
env -u ELECTRON_RUN_AS_NODE -u BVE_LSP_CONFIG -u BVE_MANUAL_CATALOG_TOKEN \
  GITHUB_SHA="$BVE_SSH_CANDIDATE_REVISION" xvfb-run -a \
  npm run test:extension:remote -- --mode=ssh-remote
```

`--ssh-network=published` and `--ssh-network=host` explicitly override auto selection.
The full report records the selected strategy. A failed strategy does not trigger a transport fallback.
The readiness check retries refused or timed-out connections for at most 30 seconds before any editor session starts.
Authentication or hostname mismatch fails immediately. Product checks, artifact identity, disconnect cleanup, and reconnect assertions remain unchanged.

## Current qualification status

The LSP separation completed phases 0 through 9 and merged in [PR #2](https://github.com/chtaylo3/backstage-validation-engine/pull/2).
Tested head `6938b8b85c1b5889af3fbe1119684de6577e5b45` passed the native source, packaged, installed-editor, and quick qualification lanes.
Each operating system passed 989 source tests, 989 packaged tests, and 88 portable installed-editor cases.
Quick qualification passed 36 desktop compatibility/load cases and 12 real remote disconnect/reconnect sessions.
The [separation record](lsp-separation-implementation-record.md#hosted-qualification-and-merge) supplies exact digests and successful workflow links.

The first macOS qualification attempt passed 87/88 after a native `trust-persisted` UI timeout.
The separate PR run passed. An isolated macOS rerun also passed 88/88 with unchanged assertions and bounds.
The original failure evidence remains retained. This does not establish a fix for native Trust automation reliability.
The [five-phase editor plan](lsp-editor-improvements-plan.md) defers that reliability work, installed JetBrains qualification, and longer final-candidate release workloads to phase 5.

## Installed request and input controls

Rule-contribution readiness reads completion, hover, and code-action results through a bounded helper.
Only an explicit editor `Canceled` error is retried, within the existing 20-second readiness bound.
The report records each cancellation and its provider command. Other errors still fail the case.
A cancelled read cannot count as an empty result or prove that a candidate disappeared.
Guarded edit commands are never retried through this helper.

Native clicks locate the named control again after pointer focus and before mouse release.
This handles a focus-induced scroll that moves the Trust button between the two input events.
The helper releases the mouse even if the control cannot be reacquired.
Trust state still comes from the real workspace API and visible workbench controls.
Neither correction increases timeouts, retries a failed scenario, or changes the Trust assertions.

The unit controls cover cancellation, successful reads, error propagation, deadlines, focus movement, and mouse release after failure.
A separate owned-renderer experiment exercises actual native input against a button that moves when focused.
The broader phase 5 qualification and reliability work remains deferred.

## Historical qualification checkpoints

The checkpoints below retain their original candidate revisions and limitations.
Their pending native/remote statements do not supersede the completed candidate qualification above.
Historical successes also do not qualify longer release workloads for a later candidate.

Increment 2 is qualified at `d3884ed` by
[CI 42445289384](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42445289384).
The native race and lifecycle scenarios passed on all six OS and editor combinations in `b7035e2`.
The overall CI run failed on trust automation because of command-palette focus and transient Windows
locks during evidence-file renames. Those failures remain recorded in
[CI 42449939578](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42449939578).
The follow-up waits for a visible Restricted Mode banner/status control or the native Workspace
Trust tab before clicking, then pins the tab.

It does not open the command palette over a workbench whose first controls have not painted.
Evidence replacement uses bounded atomic rename retries only for native Windows sharing errors. It
does not retry a failed scenario into success. Windows virtual/remote launches use
`--folder-uri=value` to avoid the
[upstream Chromium argument filtering issue](https://github.com/microsoft/vscode/blob/main/src/vs/code/node/cli.ts).
The preliminary WSL lane booted kernel `6.18.54.1-microsoft-standard-WSL2` on `windows-2025` image
`20261103.298.1`.

Its editor session still needs qualification. At `a3ac158`, its minimum-editor disconnect and
reconnect both passed. The current-editor launch exposed the newer Windows resources layout. SSH and
Dev Containers reached their real remote hosts and passed both catalog API versions and editor
feature checks. They then failed the post-disconnect PID observation.

Those partial sessions do not qualify the complete remote matrix. At `0fa0821`,
[CI 42458216928](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42458216928)
passed all 11 jobs: 862 source/packaged tests on each native target and all 252 portable editor
scenarios. All 12 real remote sessions also passed with one Linux VSIX checksum. Subsequent load
observations drove the explicit resource warmup, initialization preparation and native checkpoint
changes described above. Final workload qualification must use the corrected candidate's own runs.

The final matrix, repetition, compatibility and soak qualifications must be read from their actual
candidate runs. Remote lanes remain unqualified until those real sessions pass. Historical-release
upgrades remain open because the current predecessor is a reproducible fixture. Web/VS Code for the
Web is outside the current desktop/workspace extension contract and has not been browser-qualified.

The Windows packaged harness at `3f09ccc` exposed a native Node 24.20.0 exit `3221225477`
(`0xC0000005`) in the CEL worker lifecycle file. This matches the
[upstream Windows test-process crash pattern](https://github.com/nodejs/node/issues/65756), whose
worker Realm cleanup fix shipped in [Node 24.22.0](https://nodejs.org/en/blog/release/v24.22.0). The
runtime is now pinned to security patch 24.22.1, and Windows CI repeats the actual packaged worker
and completion lifecycle files 20 times. Every iteration must pass. The original failure remains
recorded. This pin update must qualify through the same full matrix.

Client cancellation is ordered at provider entry through a real in-process JSON-RPC connection,
proving abort propagation and suppressed completion items. A separate native-process case
deliberately cancels after the bounded local reply and verifies native HTTP shutdown cleanup. An
HTTP-entry acknowledgement from another process cannot prove that cancellation preceded the 50 ms
reply. Once packaging succeeds, independent native editor and runtime stress checks still execute
after another test failure, while the aggregate CI job stays red.

At `6bd98e5`, all 11 CI jobs and the full compatibility workflow passed. This included all six
30-minute soaks and real SSH, Dev Container, and WSL2 sessions. Linux and macOS passed all 600
repeated race cases each. Windows passed 597 of 600. Three sessions published incomplete initial
validation and correctly withheld guarded fixes. These failures remain qualification failures, even
though later independent cases passed.

Worker readiness includes a fixed interpreter parse and evaluation warmup under the existing startup
deadline. This prepares the compiler before the first repository expression. Fresh worker tests
exercise both first selectors without replacing a worker. Rule-stage evidence also distinguishes the
CEL attempt deadline from the overall request deadline. No execution, readiness or resource ceiling
was raised, and the changed candidate requires its own complete qualification.

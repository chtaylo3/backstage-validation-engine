# VS Code qualification evidence

Implementation and qualification are tracked separately. A workflow's presence,
a green short mechanism run, or a build from another revision does not close a
qualification requirement.

| Area                       | Implemented qualification                                                                                                                                             | Evidence required before support is claimed                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable desktop           | Installed VSIX, 42 independent scenarios on Ubuntu 24.04 x64, Windows 2025 x64 and macOS 15 arm64, VS Code 1.106.3 and 1.145.2                                        | All six combinations at the candidate SHA; no failed or unexecuted cases                                                                                                          |
| Races and native lifecycle | Entered/cancelled/released catalog gates, suspended-server apply delivery, watchers, multi-root and two real windows, native reload and close                         | 20 independent repetitions per OS and editor, with every earlier failure retained                                                                                                 |
| Workspace Trust            | Restricted Mode, visible grant/revoke, actual reload, persisted consent and unrelated folder isolation                                                                | Native trust API state, no product override, screenshots, UI actions and owned server cleanup on all six combinations                                                             |
| YAML coexistence           | Red Hat YAML 1.19.1, independent findings, overlapping completions, guarded fix and formatting, continued YAML validation after product Stop                          | Both editor versions on all three OS targets                                                                                                                                      |
| Package lifecycle          | Fixture predecessor 0.0.1 → candidate 0.1.0, disable/re-enable, uninstall/reinstall, persistent User Settings and one native server                                   | Both versions on all three OS targets; a real historical release remains unqualified until a supported predecessor exists                                                         |
| Virtual workspace          | Native custom filesystem workspace; installed product stays inactive without diagnostics, fixes or completions                                                        | Both versions on all three OS targets; this is not a browser test                                                                                                                 |
| Remote SSH                 | Native Linux desktop, Remote SSH 0.120.0, authenticated ephemeral container host                                                                                      | Assert `remoteName`, hostname, host-target installed VSIX/revision, bundled runtime, visible User Setting, URI behavior, watcher/fix/completion, disconnect cleanup and reconnect |
| Dev Containers             | Native Linux desktop, Dev Containers 0.430.0, actual attached container workspace                                                                                     | Same remote assertions; running local tests inside Docker cannot satisfy this lane                                                                                                |
| WSL                        | Native Windows desktop, WSL extension 0.104.3, isolated imported WSL2 distro containing the Linux candidate                                                           | Actual WSL2 kernel and remote extension host; failed virtualization/import preflight fails the required lane                                                                      |
| Load and endurance         | 100/1000 configured files, cold editor readiness, dirty edit and native watcher bursts, completion, periodic restarts and catalog authorization interruption/recovery | Native client/server RSS and handles, one owned server, latency percentiles and post-warmup growth checks; full 30-minute scheduled and two-hour release workloads                |

Remote fixtures use the immutable Ubuntu 24.04 base manifest
`sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852`.
Reports retain the built image ID, editor server commit/archive checksum, remote
extension version, runner image, revision and VSIX checksum. WSL imports a root
filesystem exported by the Linux lane and verifies its checksum and revision.
The container and WSL distribution belong only to the workflow and are removed
after process-death observations.

## Running the qualification

`ci.yml` builds each OS candidate and runs the source, packaged and portable editor
harness. `vscode-races.yml` and `vscode-compatibility.yml` download those exact
candidate artifacts, verify the recorded VSIX/runtime checksums and revision,
extract the installed payload, and compile the driver from the same checkout.
They do not rebuild another product VSIX for qualification. Fixture predecessors
are identified separately and cannot count as historical-release coverage.

The compatibility workflow has three manual modes:

- `quick`: coexistence, package lifecycle, virtual workspace, both load sizes and
  the three real remote lanes. Long soaks and the release verdict are omitted.
- `full`: the same lanes plus 30 minutes of fixed workload per editor and OS.
- `release`: two hours of fixed workload per editor and OS, followed by a strict
  verdict that also consumes the successful portable CI and all 20 race
  repetitions at this revision and the same OS-specific VSIX checksums.

The release verdict rejects missing or duplicate cases, wrong versions, focused
reports, unfinished cleanup, short/empty resource reports, an earlier failed race
repetition, missing native environments, or a different candidate artifact. It
does not publish an extension. No remote environment is optional in this verdict.

For local debugging, use `npm run test:extension -- --trust`,
`npm run test:extension:compatibility`, `npm run test:extension:load`, or
`npm run test:extension:remote -- --mode=ssh-remote`. A local 60-second soak
mechanism check is available with `BVE_SOAK_SECONDS=60`; CI rejects that duration.
Every real scheduled/release soak must finish its declared workload duration.

The load/soak fixture contains one Group and the remaining files are Components;
only the edited Component initially violates the policy. It uses the production 25 ms debounce, a
five-second engine deadline and the existing 20-second readiness bound. A
separate zero-debounce saturation case makes all 999 Components violate policy.
It requires each edit to complete or publish a typed bound, disallows guarded
fixes after incomplete validation, preserves exact buffer text and then verifies
positive fix recovery with a smaller source. Its observations do not establish
capacity to complete every zero-debounce 1000-violation workload. Performance budgets are explicit
in `resource-metrics.json`; observed local timings do not qualify hosted hardware.
The client baseline is measured after product Stop and includes the loaded client
module, while cold readiness starts at the parent editor launch timestamp.
Catalog authorization is interrupted and recovered live each minute, with a new
denied and then successful authenticated read required; recovery must keep the
same server PID. Fifteen-minute process epochs allow post-warmup growth to be
measured before periodic restarts switch between both pinned catalog versions.
Watcher files have bounded, stable content size throughout the workload.

The load lane exposed duplicate native source/baseline preparation by validation
and completion. Catalog-backed LSP generations now share that immutable local
preparation before catalog HTTP; each still enforces the original deadline and
generation cancellation. An actual held-HTTP test on both API pins verifies that
local completion remains available, and a newer edit cancels the old generation.
There is no persistent cross-request source cache. Repeated structural contract
checks reuse only the parser's own deeply frozen output identities. Mutable
inputs, clones and caller-frozen counterfeits still receive full validation;
authority, request bindings, cancellation and deadlines are checked separately.

Each native process receives its own application shared-data directory as well
as an isolated user profile and extension directory. Remote extension pins are
checked against both editor versions before launching. Dev Containers attach
consent uses a visible native workbench dialog and records the click for the
workflow-owned container; it does not modify the extension's private consent
storage.

## Current qualification status

Increment 2 is qualified at `d3884ed` by
[CI 42445289384](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42445289384).
The subsequent native race/lifecycle scenarios passed on all six OS/editor
combinations in `b7035e2`, but its overall CI run failed on trust automation:
command-palette focus and transient Windows evidence-file rename locks. Those
failures remain recorded in
[CI 42449939578](https://github.com/chtaylo3/backstage-validation-engine/actions/runs/42449939578).
The follow-up uses the Restricted Mode banner and pins the native Workspace Trust
tab; the palette is only a fallback. Evidence replacement uses bounded atomic
rename retries only for native Windows sharing errors. It does not retry a failed
scenario into success. Windows virtual/remote launches use `--folder-uri=value`
to avoid the [upstream Chromium argument filtering issue](https://github.com/microsoft/vscode/blob/main/src/vs/code/node/cli.ts).
The preliminary WSL lane booted kernel `6.18.54.1-microsoft-standard-WSL2` on
`windows-2025` image `20261103.298.1`; its editor session still needs to qualify.

The final matrix, repetition, compatibility and soak qualifications must be read
from their actual candidate runs. Remote lanes remain unqualified until those
real sessions pass. Historical-release upgrades remain open because the current
predecessor is a reproducible fixture. Web/VS Code for the Web is outside the
current desktop/workspace extension contract and has not been browser-qualified.

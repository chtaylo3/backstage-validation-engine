# Phase 7: Conformance and qualification

Read [the plan overview](README.md) first. This plan follows Phases 1 to 6.

## Goal

Give plugin authors a conformance kit that runs in their CI, ship a sample distribution that
this repository's CI builds on every change, and record the evidence for the whole plan.

## Current state

- `docs/plugin-capabilities-plan.md` defines the conformance cases PC-01 to PC-11 and states
  that executable plugins stay disabled until their profile passes them.
- The test harness under `test/harness/` and the fixture plugins of Phases 2, 3, and 6 exercise
  the plugin host from inside this repository. A plugin author cannot run them.
- `examples/` holds runnable examples. None builds a distribution.
- GitHub CI packages this repository's extension and CLI and runs the packaged harness and the
  installed-editor cases on three platforms.

## Target design

### Conformance kit

Add `scripts/plugin-conformance.mjs` and the npm script `plugin:conformance`. It takes a built
plugin package directory and runs these checks against the plugin in the real plugin workers:

| Check               | What it proves                                                             |
| ------------------- | -------------------------------------------------------------------------- |
| Definition          | The default export is valid and its version equals the package version     |
| Replies             | Every declared check and suggestion returns an admissible reply on samples |
| Deadline            | Every check ends or is terminated within the per-call limit                |
| Cancellation        | An aborted call settles and leaves no pending lookup                       |
| Determinism         | Two calls with the same pinned input return the same reply                 |
| No ambient access   | The plugin opens no socket, child process, or file outside its package     |
| Unavailable catalog | The plugin does not report a pass when a lookup or query fails             |

The plugin author supplies sample inputs in a `conformance/` directory of the package: entities,
bound references, and catalog fixtures per check.

The "no ambient access" check starts the kit's process with the Node permission model, which
denies child processes and file access outside the package. Node 24 has no permission switch
for the network, so the kit replaces the network modules in the worker with recording stubs. The
check tests the plugin's behavior on the samples. It is not a sandbox.

The distribution builder runs the kit for every plugin and stops on a failure. A flag
`--skip-conformance` exists for local iteration; `distribution.json` records its use.

### Sample plugin and distribution

Add `examples/plugins/zones/`: a plugin with one rule that detects dependency cycles, one rule
that limits Systems per zone (when Phase 6 delivered queries), and one suggestion function. Add
`examples/distribution/` with a manifest, a lockfile, and a trust file generated for the test.

### Continuous qualification

Add a CI job that, on the three platforms:

1. Builds the sample distribution with the builder.
2. Runs the packaged harness against the built server and CLI.
3. Installs the built VSIX and runs the quick installed-editor selection plus one plugin case.
4. Uploads `distribution.json`, the SBOM, and the checksums.

### Documents and evidence

- Complete `docs/distributions.md` with the conformance kit and a troubleshooting section for
  each builder error.
- Add `docs/plugin-authoring.md`: the plugin interface, the reply limits, the outcome table, the
  catalog access rules, and the trust statement of decision 3.
- Update `docs/plugin-capabilities-plan.md`: mark which PC cases the compiled profile passes and
  which do not apply to it.
- Record in `docs/implementation-status.md`, for one commit: the gate result, the packaged
  results, the CI run identifiers, and what was not run.
- Add every new document and this plan directory to `docs/README.md`.

## Work order

1. Build the conformance kit against the fixture plugins, including failing fixtures per check.
2. Add the sample plugin and distribution.
3. Call the kit from the builder.
4. Add the CI job.
5. Write the documents and record the evidence.

## Success criteria

1. The sample plugin passes every conformance check, and one failing fixture per check fails
   exactly that check.
2. The CI job passes on Ubuntu, Windows, and macOS for the recorded commit.
3. The installed sample extension shows a plugin finding and a plugin suggestion in the
   installed-editor case.
4. `docs/plugin-authoring.md` and `docs/distributions.md` name no behavior that lacks a test.
5. The PC case table in `docs/plugin-capabilities-plan.md` has a status and evidence link for
   PC-01 to PC-09.
6. This repository's own extension and CLI artifacts are unchanged in content, apart from
   version and build metadata.

## Test cases

- **Kit, passing.** The sample plugin.
- **Kit, failing.** One fixture plugin per check: invalid definition, oversized reply, busy
  loop, ignored abort, time-dependent reply, socket open, pass on failed lookup.
- **Builder integration.** A failing plugin stops the build; `--skip-conformance` is recorded.
- **Sample distribution.** Built CLI runs both sample rules; built server offers the sample
  suggestion.
- **Document commands.** A tooling test runs each command block of `docs/distributions.md`
  against the sample distribution.

## Exit criteria

The plan is complete when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. The evidence record names one commit, and the pull-request run and the push run of that
   commit both passed, including the sample distribution job.
3. Every open point that an earlier phase reported is closed or listed in
   `docs/distributions.md` as a known limit.
4. [Issue #5](https://github.com/chtaylo3/backstage-validation-engine/issues/5) links to
   `docs/plugin-authoring.md` as the starting point for external-system access.
5. The owner has accepted the evidence record.

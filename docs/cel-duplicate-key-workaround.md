# Temporary CEL duplicate-key fix

Status: local mitigation verified on Linux x64. Upstream publication remains pending.
The user authorized this follow-up after H1 through H6 acceptance. H7 remains deferred.

## Dependency and provenance

The dependency uses [PR #113](https://github.com/marcbachmann/cel-js/pull/113) from `chtaylo3/cel-js`.
Its immutable commit is `2af49f7b595368d031403de04d5b6f777b7d53d4`.
`package.json` selects that commit's HTTPS archive, and `package-lock.json` records its SHA-512 integrity.
The archive requires no Git or SSH credentials during installation. Install scripts remain disabled.
The source package reports `0.0.0-placeholder`. It is a temporary fork, not a published replacement version of upstream `8.0.0`.
The lockfile and packaged dependency evidence identify that distinction.

The initial Git dependency resolved to SSH even with an explicit HTTPS Git URL.
The final archive URL avoids that normalization and supplies archive integrity metadata.
No postinstall hook or additional evaluator changes apply this fix.
CLI shrinkwrap and VSIX production installation consume the same locked dependency.

## Behavior and scope

The patch rejects map entries that repeat a key, including keys computed from entity values.
Production workers expose these failures through the existing sanitized `evaluation` error.
Mandatory rule failures prevent a successful validation result and block dependent rules.
Distinct-key controls retain their ordinary true/false results, and workers remain usable after errors.

The original unpatched worker, rules-stage, and CLI regressions fail at their intended assertions before the dependency changes.
Permanent controls cover literal, nested, numeric-equivalent, computed, cached, and distinct-key worker evaluations.
CLI and LSP controls distinguish evaluation failure from a completed policy violation.
The installed `rule-contributions` case checks policy reload, blocked coverage, diagnostics, and distinct-key recovery with an unchanged buffer and PID.

This mitigates the reproduced N1 cases locally. It does not establish complete CEL map conformance.
[Issue #111](https://github.com/marcbachmann/cel-js/issues/111) separately describes key coercion and dropped prototype-related keys in the underlying object representation.
The temporary patch retains that representation. Those existing limitations remain outside this fix.
The frozen 61-vector Go comparison corpus remains unchanged because the pinned Go implementation still accepts the original duplicate-key probes.
Separate regression expectations require the CEL-defined error and do not treat Go agreement as the expected outcome for N1.

## Removal and qualification

After upstream publishes a release containing the fix, replace the archive dependency with that exact npm version.
Regenerate the lockfile, repeat clean installation and package checks, and retain the regression tests.
Upstream merge alone does not update an installed npm dependency.

## Execution record

The clean qualification source is `c3b82dee65161bcc0cc5fc634e2609cd322400f7`.
The final documentation commit follows that source and changes no executable inputs.
Node `24.22.1` ran installation and qualification. Install scripts stayed disabled.
The retained evidence is under `.artifacts/cel-fork/qualification/`.
Its `qualification-summary.json` binds the source, counts, dependency provenance, and package hashes.

| Check                                      | Result                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clean installation and `npm run check`     | Passed. 1,385 source tests and 45 client tests passed. No failures, cancellations, skips, or todos.                                                          |
| Client coverage                            | 99.79% lines, 95.87% branches, and 98.25% functions. Existing 90% line and 85% branch thresholds stayed unchanged.                                           |
| VSIX packaging and `npm run test:packaged` | Passed. All 1,385 packaged tests passed without failures, cancellations, skips, or todos.                                                                    |
| Fresh CLI installation                     | Four controls passed. Literal and computed duplicate keys returned exit 2 with blocked required coverage. Distinct-key controls returned exits 0 and 1.      |
| Installed VSIX                             | The focused `rule-contributions` case passed in VS Code `1.106.3` and `1.145.2` on Linux x64. Both records reached their final phase.                        |
| Dependency provenance                      | All 22 runtime, type, package, README, and license files matched the fork's Git blob hashes in both installed payloads. CLI shrinkwrap matched the lockfile. |

The installed test retained the existing schema finding during duplicate-key failure.
That finding carried current-generation execution failure evidence, consistent with existing diagnostic behavior.
The test also required blocked rule coverage, ordinary distinct-key violations, and an unchanged document and server PID.
The test did not require an additional standalone incomplete diagnostic when another finding already carried the failure evidence.
The harness enabled its existing read-only coverage observation and verbose trace for this case.
Diagnostic presentation and harness deadlines stayed unchanged.

| Artifact                                               | SHA-256                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `backstage-validation-engine-0.1.0-linux-x64.vsix`     | `08b5d392b6500c2612105b849a623047c0491cb3fc797fc314055307a6eaa4d1` |
| `chtaylo3-backstage-validation-engine-0.1.0-dev.0.tgz` | `75f6e893eda3e0c8d911707488c8cc2125ab0e0b18c162b152f6b644d2167873` |
| Packaged Node `24.22.1`                                | `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb` |

The VSIX contains 5,223 files and is 52,293,974 bytes. The CLI archive is 532,668 bytes.
The fork source archive adds upstream files beyond the published npm payload. The current package checks accept that payload.

Development logs retain the expected pre-fix failures, corrected test assumptions, and earlier native launch failures.
One development run was deliberately stopped after harness configuration inspection. Its incomplete records are not passing qualification evidence.
Final native runs used private D-Bus and Xvfb sessions, and their source and artifact revisions both match the qualified source.
These focused Linux checks do not claim other-platform installation, native Workspace Trust, JetBrains qualification, or endurance coverage.
H7 and the separate map representation issue remain outside this mitigation.

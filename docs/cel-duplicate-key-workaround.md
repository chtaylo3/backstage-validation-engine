# Temporary CEL duplicate-key fix

Status: local mitigation under validation. Upstream merge and release remain pending.
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
The execution record below will identify the qualified source, package identities, actual counts, and limits after validation.

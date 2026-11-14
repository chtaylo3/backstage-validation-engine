# Distributions and compiled plugins plan

This directory holds the implementation plans for customer distributions: a customer's own build
of the CLI and the VS Code extension, made from a pinned commit of this repository with the
customer's plugins compiled in. The plans are for the engineers and agents who implement and
review the work. Each phase is one independently reviewable change, and the phases run in order.

| Phase | Plan                                                                 | Outcome                                                                |
| ----- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1     | [Composition roots](phase-1-composition-roots.md)                    | The CLI and the stdio server are callable functions that take plugins  |
| 2     | [Plugin rules](phase-2-plugin-rules.md)                              | A policy can call a compiled plugin's rule; absent plugins fail closed |
| 3     | [Plugin suggestions](phase-3-plugin-suggestions.md)                  | A plugin can supply editor value suggestions                           |
| 4     | [Signed releases in the language server](phase-4-signed-releases.md) | The language server verifies releases against a built-in trust file    |
| 5     | [Distribution builder](phase-5-distribution-builder.md)              | One command builds a customer's VSIX and CLI from a manifest           |
| 6     | [Catalog queries for plugins](phase-6-catalog-queries.md)            | A plugin can ask the catalog a bounded, complete question              |
| 7     | [Conformance and qualification](phase-7-conformance.md)              | A conformance kit, a sample distribution, and cross-platform evidence  |

Phases 2 and 3 use binding trees from the [cross-entity rules plan](../cross-entity-rules/README.md),
phases 1 to 3. Finish those first.

On 2026-11-14 the owner decided the order with the [OIDC sign-in plan](../oidc-sign-in/README.md#order-with-the-other-plans):
Phase 1 of this plan runs first, then phases 2 to 5 of the sign-in plan, then phases 2 to 7 of
this plan. Phases 4 and 5 of this plan are therefore written against a language server and an
extension that have sign-in.

## Usage scenario

A customer keeps a small distribution repository. Their CI does the following:

1. Checks out this repository at a pinned commit and installs it with `npm ci`.
2. Installs their plugin packages from their own npm registry with `npm ci` and scripts disabled.
3. Runs the builder with their distribution manifest.
4. Publishes the resulting VSIX and CLI archive to their developers and pipelines.

Rules still change without a rebuild: the customer signs a policy release, and the distribution
verifies it against the trust file that the build contains.

## Decisions

The owner made these decisions on 2026-11-13. A phase plan does not reopen them.

1. **Build-time composition.** Plugins are compiled into the customer's build. The engine has no
   run-time plugin loader, never runs `npm install`, and never resolves a package by name at run
   time.
2. **Source builds at a pinned commit.** A distribution builds the engine from a 40-character
   commit of this repository. Installing the engine from an npm registry waits until the
   `@marcbachmann/cel-js` fork dependency is replaced by a published upstream version.
3. **Plugins are trusted code.** A plugin has the authority of the tool that contains it. The
   customer's lockfile, registry, and review are the security control. The engine does not
   sandbox plugins.
4. **What a plugin provides.** Rule logic and editor value suggestions.
5. **What a plugin reads.** The entity under validation, declared binding trees, and the catalog
   through the host's connection. A plugin opens no network connection of its own and receives
   no credential. [Issue #5](https://github.com/chtaylo3/backstage-validation-engine/issues/5)
   tracks access to other systems.

## Design rules that this plan proposes

The plan author proposes these rules. The owner has not yet confirmed them; confirm or change
them before Phase 2 starts.

1. **Reply admission stays.** The host validates, bounds, and binds every plugin reply, although
   the plugin shares the process. This catches plugin defects and keeps the option of moving a
   plugin out of process without changing it.
2. **The request deadline holds.** Plugin code runs in a supervised worker thread that the host
   can terminate. A plugin that loops cannot block the language server or exceed the request
   time. This is supervision, not isolation.
3. **Fail closed.** A policy names the plugins it needs. A build without one of them rejects the
   policy. A plugin failure gives incomplete coverage and exit code 2. A plugin adds findings and
   cannot remove a finding of another rule.
4. **Plugin messages.** A plugin violation may carry its own plain-text message of 512
   characters at most. Every other rule kind reports a fixed message.
5. **Signed policy only in a build with trust.** A build that contains a trust file rejects a
   plain-policy launcher configuration (Phase 4).
6. **Revocation.** The trust file gains a list of revoked digests (Phase 4).
7. **Separate identity.** A distribution must use its own publisher, name, and settings prefix,
   so that it installs next to this repository's extension (Phase 5).
8. **Catalog queries.** Phase 6 is in the plan because catalog-wide totals need it. It has open
   design points and an explicit exit that stops it.
9. **Conformance is required.** The builder runs the conformance kit for every plugin (Phase 7).

## What a plugin author writes

```ts
import { definePlugin } from '@chtaylo3/backstage-validation-engine/plugins';

export default definePlugin({
  id: 'acme/zones',
  version: '1.2.0',
  rules: {
    'no-dependency-cycles': async ({ entity, refs, catalog, signal }) => {
      // Follow dependsOn through catalog.lookup until a cycle or the bound is reached.
      return { passed: true };
    },
  },
});
```

The policy calls it by name:

```json
{
  "id": "no-dependency-cycles",
  "kind": "plugin",
  "version": "1",
  "mandatory": true,
  "severity": "error",
  "requires": ["dependencies-exist"],
  "plugin": { "id": "acme/zones", "version": "1.2.0", "digest": "sha256:…" },
  "check": "no-dependency-cycles"
}
```

## Rules for every phase

The [architecture remediation rules](../architecture-remediation/README.md#rules-for-every-phase)
apply, with these differences:

1. **Behavior.** Each phase plan names the behavior it adds. A build without plugins and a policy
   without plugin rules produce byte-identical findings, coverage, rule states, exit codes, and
   wire messages.
2. **Public API and schemas.** A phase may add the exports, entry points, and schema properties
   that its plan names. It must not remove or rename an existing one. The `bin` paths
   `dist/cli/main.js` and `dist/lsp/stdio.js` keep working.
3. **Dependencies.** Do not add, remove, or upgrade a dependency unless the phase plan names it.
4. **No dynamic loading.** No phase adds an `import()` or `require()` whose argument comes from
   configuration, policy, a manifest, or a repository under validation. The architecture check
   enforces this from Phase 1.

## Success criteria and exit criteria

Each phase plan has both. A success criterion states an outcome that the change must achieve,
and the implementer shows evidence for it. An exit criterion states a condition for closing the
phase and starting the next one.

### Exit criteria for every phase

1. Every success criterion of the phase is marked met, with its evidence, in the final report.
2. Every test case of the phase exists as an automated test and passes.
3. The verification gate passes, the test count is at least the count before the phase plus the
   new tests, and no test is skipped.
4. No existing test was deleted, skipped, or weakened. A changed assertion is named in the
   report with its reason.
5. The documents that the phase names are updated.
6. Every deviation from the plan, and every problem found but not fixed, is in the report.
7. An independent reviewer has read the change against the plan and has no open finding.

## Verification gate and report

The verification gate and the final report are the ones in the
[architecture remediation plan](../architecture-remediation/README.md#verification-gate). The
installed-editor suites run only in GitHub CI; say in the report which cases your change affects.

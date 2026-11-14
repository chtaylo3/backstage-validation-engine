# Phase 2: Plugin rules

Read [the plan overview](README.md) first. This plan uses the registry from Phase 1 and binding
trees from the [cross-entity rules plan](../cross-entity-rules/README.md).

## Goal

Let a policy rule call a check that a compiled plugin implements, with the request deadline
enforced by the host and every failure reported as incomplete work.

## Current state

- The rule union in `src/contracts/schemas.ts` has the kinds `cel`, `schema`, and `catalog`.
  `RULE_EVALUATORS` in `src/pipeline/rules/dispatch.ts` has one evaluator per kind, and a new
  kind does not compile until it has one.
- `PolicyBundleSchema.plugins` is an array of `{ id, version, digest }`. `resolvePolicyBundles`
  in `src/policy/bundles.ts` rejects every bundle whose `plugins` array is not empty.
- CEL runs in supervised worker threads (`src/runtime/cel/pool.ts`) with an empty environment,
  memory limits, a 100 ms execution limit, and termination on timeout.
- Findings of rules carry fixed messages.
- The catalog provider's `lookup` pins every observation into the request's data snapshot, and
  the language server's refresh records every looked-up reference.

## Target design

### Policy contract

- A bundle's `plugins` array lists the plugins that its rules need. Resolution accepts a
  non-empty array. It rejects, with `integrity`, a listed plugin that the registry does not
  contain with the same `id`, `version`, and `digest`.
- Add the rule kind `plugin` with `plugin` (an entry of the bundle's `plugins` array), `check`
  (128 characters at most), optional `config` (JSON, 16 KiB at most), and the optional `bindings`
  and `forEachReference` of the cross-entity rules plan.
- The LSP configuration applies the same checks as release verification.

### Check interface

A plugin's `rules` maps a check name to an asynchronous function. Its input is immutable:

| Property  | Value                                                                             |
| --------- | --------------------------------------------------------------------------------- |
| `entity`  | The normalized subject entity                                                     |
| `refs`    | The resolved bindings, when the rule declares them                                |
| `target`  | The bound item, in the per-reference mode                                         |
| `config`  | The rule's `config`                                                               |
| `catalog` | `lookup(refs)`: entity bodies by reference, through the host's catalog connection |
| `signal`  | Aborts at cancellation and at the request deadline                                |

It returns `{ passed: true }` or `{ passed: false, violations }`. A violation has an optional
`path` (a JSON Pointer into the subject), an optional `ref` (a reference the host bound or looked
up for this call), and an optional plain-text `message` of 512 characters at most. The host
maps `path` and `ref` to source locations. Up to 64 violations are admitted per call.

### Execution

Run plugin checks in supervised worker threads, with the lifecycle rules of the CEL pool: empty
environment, memory limits, a bounded queue, and replacement after a crash. The host terminates
a worker whose call passes the request deadline or a per-call limit of 1,000 ms. The registry
module is loaded in the worker from a literal import in the generated worker entry (Phase 5); in
tests, a fixture entry does the same.

`catalog.lookup` crosses the worker boundary as a message. The host answers it with the request's
provider and access context, applies proposed-catalog precedence, pins the observations, and
counts the references toward the request's 1,000-reference limit. A lookup after the deadline
fails.

### Admission and results

The host parses every reply with a generated schema, as capability replies are parsed. It
rejects a `ref` that it did not supply, a `path` that does not resolve in the subject, an
oversized reply, and a reply for a finished call.

| Outcome                                                 | Rule state                                |
| ------------------------------------------------------- | ----------------------------------------- |
| `{ passed: true }`                                      | `passed`                                  |
| `{ passed: false }`                                     | `failed`, one finding per violation       |
| Thrown error, rejected reply, crash, or unknown `check` | `error`, blocked coverage, internal error |
| Deadline, per-call limit, or cancellation               | `incomplete` with the interruption reason |
| Unreadable bound or looked-up entity                    | `incomplete`, `dependency_unavailable`    |

A plugin result affects only its own rule. No reply can change another rule's findings, states,
or coverage.

## Work order

1. Add the contract changes and regenerate the schemas.
2. Add the plugin worker pool, reusing the supervision code of the CEL pool where it is shared.
3. Add the brokered `catalog.lookup`.
4. Add the `plugin` rule evaluator and reply admission.
5. Wire the registry into `runCli` and `runStdioServer`.
6. Add tests with fixture plugins, and update `docs/contracts.md`, `docs/policy-cli.md`, and
   `docs/plugin-capabilities-plan.md`.

## Success criteria

1. A fixture plugin that detects a dependency cycle through `catalog.lookup` passes and fails
   the expected fixtures through the CLI and a stdio session.
2. A policy that lists a plugin absent from the registry, or present with another digest, is
   rejected by the CLI (exit code 2) and by the language server configuration.
3. A plugin check that loops forever is terminated; the run ends within the request time with
   exit code 2, and the next request succeeds.
4. Every row of the outcome table has a test, and none of the failure rows yields `passed`.
5. Observations from `catalog.lookup` appear in the pinned data snapshot and in the refresh
   inventory.
6. A policy without plugin rules produces byte-identical pipeline characterization output, and
   starts no plugin worker.

## Test cases

- **Pass and violation.** With `path`, with `ref`, with both, and with neither.
- **Messages.** A 512-character message is admitted; 513 characters reject the reply.
- **Reply admission.** Extra property, wrong type, 65 violations, a `ref` the host never
  supplied, a `path` outside the subject, a second reply for one call.
- **Runaway plugin.** Busy loop, unresolved promise, memory growth past the limit, and a thrown
  error.
- **Brokered lookup.** Proposed-catalog precedence; an unavailable entity; the 1,001st reference;
  a lookup after the deadline.
- **Fail closed.** Unknown plugin, wrong version, wrong digest, unknown `check`.
- **Isolation of results.** A plugin reply cannot name another rule; findings of other rules are
  unchanged when the plugin crashes.
- **Per-reference mode.** One call per reference, findings at each offending reference.
- **Lifecycle.** Shutdown with a call in flight; 100 reloads leave no worker, listener, or handle
  behind.

## Exit criteria

The phase is complete, and Phase 3 may start, when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. `npm run test:packaged` passes with the fixture plugin compiled into the packaged harness.
3. The report lists the measured overhead of one plugin call against one CEL evaluation.
4. The report confirms that the check interface passes no credential, environment variable, or
   file path to a plugin, and that the worker starts with an empty environment. This is not
   isolation: plugin code can still call Node APIs, as decision 3 of the overview accepts.

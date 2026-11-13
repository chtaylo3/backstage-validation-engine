# Architecture baseline

The accepted planning decisions, dated 2026-10-27, select one TypeScript engine on Node 24.x.
Production development starts with contract 0.2. The evaluation prototypes use 0.1 and remain
historical reference implementations.

## Runtime boundaries

The engine owns source snapshots, normalization, compatibility, reference overlays, rule
dependencies, and canonical results. It also records provenance, the source and processing history
of data. A policy resolver owns authoritative assignments, immutable baseline policies and
additions, activation, and bypass authority. Managed runtimes and providers limit execution and data
access.

They handle cancellation and cache data within authorization boundaries. CLI, LSP, and hosted
adapters translate trusted context and results for each client. A durable controller owns hosted
dispatch, recovery, activation generations, and authoritative GitHub publication.

These are logical boundaries. Start in one package and split packages when their build, ownership,
or distribution requirements justify it. Developer installation does not require a broker, database,
or central validation service.

## Engine structure

This section describes the source tree as it exists. `npm run architecture:check` and
`npm run lint` enforce the rules it states.

### Engine layers

Every top-level directory under `src/` is one layer. The layers are ordered, lowest first. A file
may import its own layer and any lower layer, directly or through other files. Layers in the same
row are peers and may not import each other. A helper that several layers share lives in the lowest
layer that all of its users may import.

| Order | Layer           | Contents                                                                                                      |
| ----- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| 1     | `protocol`      | Custom client/server method names, wire types, and guards. Imports nothing.                                   |
| 2     | `base`          | Errors, canonical JSON and digests, source URIs, the clock, bounded waits, type helpers. No internal imports. |
| 3     | `contracts`     | Schemas and their shared TypeBox builders, `parseContract` and its semantic invariants, kinds, rule order     |
| 4     | `core`          | Snapshots, results, request bindings, processor coverage helpers, the stage report contract                   |
| 5     | `runtime`       | Request budget, failure evidence, managed CEL runtime                                                         |
| 6     | `parsing`       | Source parser                                                                                                 |
| 7     | `compatibility` | Native Backstage adapters, substitutions, custom schemas, source validation stages                            |
| 8     | `policy`        | Bundles, default profile, signed releases                                                                     |
| 9     | `providers`     | Catalog provider and transport                                                                                |
| 10    | `capabilities`  | Capability contracts and sessions                                                                             |
| 11    | `pipeline`      | Reference preparation, rule execution, pipeline composition, verified result                                  |
| 12    | `reporting`     | SARIF                                                                                                         |
| 13    | `host`          | Host catalog configuration, built-in validation, rule contributions                                           |
| 14    | `cli`, `lsp`    | Adapters. Peers: neither may import the other.                                                                |

`src/index.ts` is the public barrel and may import layers 1 to 12 only. Nothing under `src/`
imports it, directly or through another file. It lists every exported name explicitly, grouped by
layer, as do the other entry points (`src/contracts/index.ts`, `src/lsp/index.ts`,
`src/capabilities/index.ts`, `src/protocol/index.ts`). `npm run lint` rejects `export *` in `src/`,
so a new export becomes public only when an entry point names it, and
`test/tooling/public-api.test.ts` compares the value and type names of each entry point with
`test/fixtures/public-api.json`. The VS Code client in `extensions/vscode/src` may import
`src/protocol/` and nothing else under `src/`, may not import the package, and nothing imports the
client.

`npm run architecture:check` runs `scripts/architecture-boundaries.mjs`, whose `LAYERS` list holds
the same order as this table. Type-only imports, re-exports, `import()`, and `createRequire` loaders
count as imports. The check also enforces these rules:

- No file-level import cycle exists anywhere in `src/`.
- A file in `src/protocol/` imports only other files in `src/protocol/`: no lower layer, no
  package, and no Node built-in module.
- A file outside a listed layer directory fails the check.
- The VS Code packages are imported only from `lsp` and the client.
- `@backstage/catalog-model` and `backstage-catalog-model-older` are imported only from
  `compatibility`, `@marcbachmann/cel-js` only from `runtime`, and `yaml` only from `parsing` and
  `lsp`.
- No function, method, constructor, accessor, or arrow function in `src/` or
  `extensions/vscode/src/` is longer than 150 lines. `scripts/function-size-allowlist.json` lists
  the older functions above the limit, each with its current length as a ceiling. An allowlisted
  function may not grow, and an entry fails once its function is within the limit or gone.
- The shared CEL runtime rules in [Clock and runtime](#clock-and-runtime).

### Clock and runtime

Engine decisions read time through a `Clock` (`src/base/clock.ts`): `wall()` for epoch
milliseconds that compare with contract deadlines, and `monotonic()` for elapsed time. Components
take an optional `clock` on their existing options or constructor, with `systemClock` as the
default at the parameter. Real timers stay real. `npm run lint` rejects `Date.now` and
`performance.now` in `src/`, except in the files that measure real time on purpose:
`src/base/clock.ts`, `src/runtime/cel/pool.ts` (worker supervision), and `src/parsing/budget.ts`
and `src/compatibility/adapter.ts` (cooperative yielding).

Every component receives a `CelRuntime` from its owner. Only `src/index.ts`, `src/cli/main.ts`,
`src/lsp/stdio.ts`, `src/runtime/cel/index.ts`, and `src/pipeline/rules/context.ts` import
`getSharedCelRuntime` or `closeSharedCelRuntime`. A namespace import, `export *`, or `import()` of
`src/runtime/cel/index.ts` counts as importing them. `src/pipeline/rules/context.ts` supplies the
documented default of rule execution, `defaultRuleRuntime`, when a caller passes none. Only that
module and `src/lsp/editor/state.ts` import `defaultRuleRuntime`, by the same rule: the editor
falls back to it lazily when its owner supplies no runtime.

### Shared protocol

`src/protocol/` defines the custom `bve/` methods that the language server and its clients
exchange, once:

- `methods.ts` holds `BVE_METHODS`, the frozen method names, and `BVE_METHOD_SHAPES`, the
  direction and message kind of each method.
- `types.ts` holds the parameter and result types as plain structural types. Where `src/lsp` sends
  an engine type, such as `CoverageObservation`, a compile-time mutual-assignability check in
  `src/lsp` keeps the engine type and the wire type equal.
- `guards.ts` holds the validation predicates for every payload that crosses the wire as
  `unknown`. A parameter guard accepts exactly what the server accepted before the guard existed;
  each handler keeps its answer to invalid input (`null`, an empty list, or a silent ignore).
- `index.ts` holds the explicit exports, published as the `./protocol` package entry point.

The module has no dependencies, so the VS Code extension bundles it by relative path, and another
client can use it without the engine. The extension validates every response with these guards
and treats an invalid response like a failed request. `node scripts/test-client.mjs` measures the
protocol files that the extension bundles together with the extension sources.

### Pipeline stages

Source validation, rule execution, and their composition report through one contract in
`src/core/stage-report.ts`: ordered findings, ordered coverage, and an interruption.
`INTERRUPTION_PRIORITY` and `mergeInterruption` rank interruptions, and `mergeCoverage` keeps one
row per stage and subject. `budgetInterruption` in `src/runtime/request-budget.ts` names why an
interrupted request budget stopped (`timeout` or `cancelled`).

- `src/compatibility/sources.ts` orchestrates the stage modules in `src/compatibility/stages/`:
  the processing gate, preparation, and per document substitution, native validation, admission,
  references, and Location discovery, followed by identity conflicts. The stages share one run
  state object. Source stages assign the interruption instead of merging it.
- `src/pipeline/cel-rules.ts` schedules subjects on lanes (`src/pipeline/rules/lanes.ts`) and
  evaluates each rule through `RULE_EVALUATORS`, one evaluator module per rule kind. A rule kind
  without an evaluator does not compile.
- `src/pipeline/policy-sources.ts` composes source validation, reference preparation, and rule
  execution for one request.

### Language server

CLI and LSP use neutral catalog admission and construction from `src/host/catalog-config.ts`.
The catalog file does not replace authority from a verified release or trusted editor launcher.
The root SARIF export uses neutral reporting. The CLI module path remains a compatibility wrapper.

`attachLspServer` (`src/lsp/server.ts`) is the composition root. It builds one server context
(`src/lsp/server-context.ts`) that holds the owners below, the connection lifecycle, the client
features accepted at `initialize`, and the latest coverage and filesystem observations. The handler
modules in `src/lsp/handlers/` (`lifecycle.ts`, `documents.ts`, `language.ts`, and `custom.ts` for
the `bve/` methods) register the protocol handlers over that context and keep no state of their
own. `EditorService` (`src/lsp/editor.ts`) is a facade over the indexing, rule contribution,
completion, navigation, and repair modules in `src/lsp/editor/`. [The language server
guide](lsp.md#internal-state-and-resource-ownership) describes the same structure from the
client's side.

The owners separate mutable source state, scheduling, session resources, requests, and
publication:

| Owner                   | Responsibility                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `WorkspaceState`        | Buffer mutation, immutable document views, lifetimes, source selection, and guarded disk captures |
| `ValidationCoordinator` | Debounce, cancellation, one active validation, latest pending update, and validation quiescence   |
| `SessionResources`      | Serialized replacement, one activation commit point, resource users, and bounded retirement       |
| `RequestContexts`       | Typed admission, captured session/source identity, original deadlines, and stale-result rejection |
| `DiagnosticPublisher`   | Diagnostic delivery and guarded clears, including document lifetime checks                        |
| `ClientEdits`           | One connection-wide edit reservation that survives local cancellation and configuration reload    |

Session generations own editor indexes, dynamic registrations, and credential watches.
The host's aggregate disposal callback closes the provider and filesystem resources it supplies.
The stdio process owns the fixed configuration watch, protocol connection, and shared managed CEL runtime.
A configuration reload does not close the shared runtime or create another connection edit slot.
Cleanup failure keeps the session unavailable and requires reconnection.

Native validation and optional editor presentation metadata share exact native package identity.
Missing presentation metadata cannot replace native validation or select a different installed version.
See the [implementation record](history/lsp-separation-implementation-record.md) for executed qualification and remaining limits.

### Tests

Every `*.test.ts` file lives in one group directory: `test/engine/` (engine layers and
`protocol`), `test/lsp/`, `test/cli/`, `test/extension/`, or `test/tooling/` (import policy,
public API, documentation links, harness evidence, and script tests). `test/harness/`,
`test/fixtures/`, and `test/integration/` hold support code and data. `scripts/test.mjs` discovers
the compiled test files of each group; `--group <name>` selects groups. `npm test` runs the
`engine` group in one parallel `node --test` invocation and every other file in a second, serial
invocation. `node scripts/test-client.mjs` runs the VS Code client tests with coverage. [The test
harness guide](testing-harness.md#test-layout-and-runner) holds the full runner rules, the serial
list, and the report files.

### Scalability limits

The current design has these limits:

- One process. The CLI and each language server session validate in a single Node process; there
  is no shared service, queue, or cache across processes.
- Whole-snapshot validation. Every request validates its whole source snapshot through every stage.
  The language server overlays open buffers on its workspace snapshot and validates all of it after
  each debounced change, with one active validation and one pending update.
- Two CEL workers and 64 outstanding jobs. The shared managed CEL runtime runs at most two worker
  threads and admits at most 64 outstanding evaluations (`CEL_LIMITS`); the default profile also
  caps a request at 1,000 entities, 16 MiB, and five seconds.
- No incremental validation. Each run parses and validates every file again, unchanged or not.
  Catalog lookups (within `maxAgeMs`) and editor completion keep bounded caches; neither makes
  validation incremental.

## Fixed decisions

- Native Backstage adapters pin catalog-model 1.10.2 and 1.7.5. The initial compatibility surface
  includes Component, API, Group, User, Resource, System, Domain, and Location. Compatibility
  includes explicitly declared native policies, reference contexts, local substitutions, admission,
  custom schemas, and proposed-state overlays. Full organization ingestion is not inferred from
  stock schema validation.
- CEL uses `bve-cel/1`: CEL-JS 8.0.0 with RE2JS 2.9.0 in supervised, replaceable workers. Two shared
  workers, 64 outstanding jobs, a 100 ms evaluation deadline, and a five-second whole-request
  deadline are initial ceilings. Both selectors and expressions must use the managed path. Go
  remains reference evidence.
- JSON-compatible YAML preserves missing/null and authored source positions. Parsing rejects
  duplicate keys, unsafe integers, and merge keys. It limits aliases, nesting depth, expansion, and
  source size. Custom schemas use draft-07, bundled refs, no network ref loading, no coercion, and
  no default mutation.
- Required unsupported processors or unavailable data produce incomplete coverage and block CI. A
  timeout is an incomplete execution. A false rule is a violation. An invalid rule is a policy
  configuration error.
- Centrally mandatory policies and limits cannot be weakened by repository additions. Repository
  metadata is a hint rather than assignment authority.
- Early emergency bypass follows trusted identity resolution and precedes parsing and expensive
  providers. Exactly one verified Git bundle bypass provider is planned per installation. Routine
  exceptions apply after rule execution.
- Hosted run identity binds installation/repository, target SHA, activation digest, and generation.
  Stale completion must not restore approval. The pilot targets publication reconciliation within 60
  seconds of authoritative changes.
- The small hosted pilot uses persistent SQLite WAL with one controller writer, a durable
  inbox/outbox, deduplication, leases, and restart reconciliation. Direct and central Actions
  backends share the execution contract. Application repositories need no workflow file for central
  Actions.
- Arbitrary untrusted plugins remain disabled until process/container isolation passes filesystem,
  network, credentials, CPU, and memory denial tests. Worker threads are not an operating-system
  sandbox.

## Pipeline

Run the pipeline in this order:

1. Resolve trusted identity.
2. Apply an authorized early emergency bypass.
3. Pin activation, source, policy, and profile.
4. Discover and parse sources.
5. Resolve substitutions.
6. Apply native policies and admission.
7. Build the proposed catalog overlay.
8. Collect and pin provider data within its limits.
9. Execute rules.
10. Apply routine exceptions.
11. Aggregate coverage and enforcement.
12. Check publication freshness.

Preserve the authored entity, the effective entity after processing, and the history that links
them. Invalid replacement entities and deletion tombstones must hide older catalog entries. A
tombstone records an explicit deletion. If a required transformation is unavailable, block every
stage that depends on it. Do not report speculative errors about data that the transformation was
expected to supply.

## Implemented parsing boundary

The [source parser](parsing.md) reads verified immutable snapshots. It returns frozen JSON
documents, source locations for authored and alias values, redacted diagnostics, and per-file parse
coverage. Coverage records which declared work completed. The parser loads its YAML 1.2 lexer,
parser, and composer only when needed.

It uses an iterative syntax guard, bounded JSON expansion, and cooperative request budgets. CI
excludes all entities from an invalid file. IDE mode retains unaffected documents but excludes
invalid documents from validation.

This stage precedes native Backstage checks. An excluded invalid source must later produce an
invalid-replacement marker in catalog overlays, preventing fallback to an older entity. Passing
parse coverage does not imply completed compatibility, substitution, admission, policy, or
hosted-authority coverage.

## Implemented native boundary

The [native compatibility adapter](backstage-compatibility.md) selects exact catalog-model
1.10.2/1.7.5 packages. It applies declared native policies and stock kind validators, with
source-attributed normalization separate from authored JSON. The
[snapshot-local resolver](substitutions.md) implements BC-04 with pinned roots, entrypoints, and
included-file locations. Required unavailable processors and readers block dependent native checks.
The source entry point combines parsing, BC-01 through BC-05, and identity-conflict checks.

[Admission and custom schemas](admission-custom-kinds.md) enforce pinned kind allowances by source
after native normalization. They also enforce immutable custom-kind artifacts. Stock validators
retain their versioned behavior. Reference preparation establishes BC-06 local facts and removals
relative to the baseline. Complete processing and governance remain separate stages.

## Implemented catalog access boundary

The [catalog provider](catalog-provider.md) uses a host-owned connection and credential resolver. It
runs native reference and envelope checks, limits HTTP lookups, and returns immutable snapshots with
availability and source history. Tests against the multi-version fake cover scoped caches,
first-in-first-out admission, retries, cooldowns, original deadlines, and cancellation. The provider
pins data before evaluation. Callers must retain required unavailable coverage and interruptions.

The [reference preparer](source-references.md) connects source contexts to observations and pins a
new evaluation request under the original deadline. Conservative guards prevent premature fallback.
[Explicit catalog rules and the stdio LSP](lsp.md) use those pins through `validatePolicySources`.
The editor adapter owns workspace generations, cancellation, and versioned publication.

The launcher retains authority. [Proposed overlays](proposed-overlays.md) establish valid local
targets, hide invalid or deleted identities, and bind baseline, source, and data before external
lookup. Real-backend and editor qualification remain open.

## Future rule and editor plugins

The [capability plan](plugin-capabilities-plan.md) defines proposed versioned interfaces for validation,
field metadata, values, hover, references, repairs, search, and source discovery. Existing CEL and
RE2 evaluation retains its qualified execution profiles. A validator supplies editor functions only
through declared metadata or a qualified capability provider.

The host owns authority, preparation, candidate evidence, source rendering, resource admission, and
edit guards. Capability declarations cannot grant credentials, bypass dependencies, or weaken
mandatory coverage. Missing required evaluation remains incomplete. Optional editor failures do
not suppress validation findings. The plan includes separate conformance and delivery gates before
generic executable plugins can be enabled.

## Release breadth

The pilot prioritizes engine/CLI, VS Code, a GitHub App, direct execution, and central Actions.
Stable release retains JetBrains, Kafka, SQS, governed programmable plugins, and operational/support
matrices. Visual Studio is optional. Installation access, organization processors, supported
IDE/OS/GHES versions, representative workload sizes, and staffing still need concrete qualification.

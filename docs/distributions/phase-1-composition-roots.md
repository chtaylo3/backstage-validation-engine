# Phase 1: Composition roots

Read [the plan overview](README.md) first.

## Goal

Make the CLI and the stdio language server callable functions that accept a list of plugins, so
that a generated entry module can start either one. This phase adds no plugin behavior: the list
is validated and otherwise unused.

## Current state

- `src/cli/main.ts` defines `main` and ends with `process.exitCode = await main()`. Nothing is
  exported.
- `src/lsp/stdio.ts` is a script. It reads `--config`, creates the resources, calls
  `attachLspServer`, and owns the process lifecycle.
- The built-in providers are constructed at four internal sites with `builtinCapabilitySession`:
  `src/host/builtin-validation.ts`, `src/capabilities/builtin-metadata.ts`,
  `src/lsp/discovery.ts`, and `src/lsp/completion.ts`.
- `CapabilityManifestSchema.executionProfile` accepts `builtin/1` and `declarative/1`.
- `scripts/architecture-boundaries.mjs` enforces the layer order and the package containment.
- The package exports `.`, `./contracts`, `./schemas/*`, `./lsp`, `./capabilities`, and
  `./protocol`.

## Target design

### Entry functions

- Move the body of `src/cli/main.ts` to `src/cli/run.ts` as
  `runCli(options): Promise<number>`. `options` has `argv`, `plugins`, and optional `clock`,
  `stdout`, and `stderr`. `main.ts` becomes
  `process.exitCode = await runCli({ argv: process.argv.slice(2), plugins: [] })`.
- Move the body of `src/lsp/stdio.ts` to `src/lsp/run-stdio.ts` as
  `runStdioServer(options): Promise<void>`, with `argv` and `plugins`. `stdio.ts` calls it with
  no plugins and keeps its shebang.
- Add the package export `./cli` for `runCli`, and export `runStdioServer` from `./lsp`.

### Plugin definition

Add the layer `plugins` directly below `pipeline` in `LAYERS`, and the package export
`./plugins`.

- `definePlugin(definition)` validates and freezes a definition: `id` (128 characters at most,
  `SCOPE/NAME` form), `version` (exact semantic version), and at least one of `rules` and
  `suggestions`. It returns an opaque `PluginDefinition`.
- `PluginRegistry` is built from a list of definitions plus the artifact digest that the build
  supplies for each. It rejects duplicate IDs, and it exposes `get(id)` and an inventory of
  `{ id, version, digest }`.

`runCli` and `runStdioServer` build one registry at start and fail to start on an invalid list.
Later phases pass the registry to the rule run and the editor.

### Execution profile

Add `compiled/1` to the manifest's `executionProfile` union. It identifies a provider whose code
the build contains and whose artifact digest the build recorded. `builtin/1` keeps its meaning.

### No dynamic loading

Add a check to `scripts/architecture-boundaries.mjs`: under `src/`, a dynamic `import()` or a
`require()` call must have a string literal argument. The two existing dynamic imports of the
catalog model in `src/compatibility/adapter.ts`, the parser import in `src/parsing/index.ts`, and
the literal-prefixed `require` calls in `src/compatibility/schema-artifacts.ts` are the reviewed
allowlist; name each one in the check with its reason.

## Work order

1. Extract `runCli` and `runStdioServer`; keep the `bin` files as thin callers.
2. Add the `plugins` layer with `definePlugin` and `PluginRegistry`, and their unit tests.
3. Add `compiled/1` and regenerate the schemas.
4. Add the dynamic-loading check and its tests.
5. Add the package exports and update the public API snapshot.
6. Update `docs/architecture.md` and `docs/capability-interfaces.md`.

## Success criteria

1. `node dist/cli/main.js` and `node dist/lsp/stdio.js` behave as before: the CLI subprocess
   tests and the stdio lifecycle goldens pass without change.
2. A test starts `runCli` and `runStdioServer` in-process with an empty plugin list and with one
   valid definition, and both complete a validation.
3. An invalid plugin list (duplicate ID, bad version, no rules or suggestions) stops both entry
   functions before any input is read, with exit code 2 from the CLI.
4. `npm run architecture:check` fails on a non-literal `import()` added under `src/`.
5. The public API snapshot differs only by `./cli`, `./plugins`, `runStdioServer`, and
   `compiled/1`.

## Test cases

- **Bin parity.** The existing CLI subprocess suite and the stdio suite run against the thin
  `bin` files.
- **In-process CLI.** `runCli` with injected `stdout` returns 0, 1, and 2 for an allowed, a
  violating, and an invalid run.
- **In-process server.** `runStdioServer` over in-memory streams completes `initialize`, one
  validation, and `shutdown`.
- **Definition validation.** Each invalid field has a case; a definition is frozen after
  `definePlugin`.
- **Registry.** Duplicate IDs are rejected; the inventory is sorted by ID.
- **Dynamic loading.** A fixture file with `import(name)` fails the check; each allowlisted site
  passes; removing an allowlist entry fails.

## Exit criteria

The phase is complete, and Phase 2 may start, when all of these hold:

1. The [shared exit criteria](README.md#exit-criteria-for-every-phase) are met.
2. `npm run test:packaged` and `npm run cli:package` pass, because both entry points moved.
3. The registry is constructed and has no consumer: no rule or editor path reads it.

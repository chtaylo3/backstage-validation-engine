# Phase 4: Shared protocol module

Read [the shared rules](README.md) first. This plan uses the handler modules from Phase 3.

## Goal

Define the custom client/server protocol once, in a module with no dependencies that both the
server and every client can import.

## Current state

Six custom methods are string literals in both `src/lsp/` and `extensions/vscode/src/extension.ts`.
Their payloads are typed `unknown` and checked by hand on each side:

| Method                      | Direction       | Kind         | Payload → result                                |
| --------------------------- | --------------- | ------------ | ----------------------------------------------- |
| `bve/reloadConfiguration`   | client → server | request      | none → `{ reloaded: boolean }`                  |
| `bve/recordSelection`       | client → server | notification | string of at most 512 characters                |
| `bve/searchReferences`      | client → server | request      | search input → `{ reference, source }[]`        |
| `bve/filesystemObservation` | client → server | request      | none → filesystem observation or `null`         |
| `bve/validationCoverage`    | client → server | request      | `{ uri, version, digest }` → coverage or `null` |
| `bve/configurationReloaded` | server → client | notification | none                                            |

The import policy correctly forbids the client from importing `src/`, but nothing takes its place.
A second client (JetBrains is planned) would copy the strings again.

`scripts/test-client.mjs` requires the client coverage report to list **exactly** the files in
`extensions/vscode/src/`, with 90% line and 85% branch coverage.

## Target design

### Module (`src/protocol/`)

- A new lowest layer, below `base`. It imports nothing: no internal module, no npm package, and no
  Node built-in. It must bundle into the extension and be usable by any client.
- `methods.ts`: one frozen object of method names. Include any other identifier that both sides
  must agree on; search for them (for example the `bve.applyFix` command ID, if the client refers
  to it).
- `types.ts`: parameter and result types for each method, written as plain TypeScript types.
- `guards.ts`: dependency-free validation functions for every payload that crosses the wire as
  `unknown`, for example `isValidationCoverageParams`, `isRecordSelectionParams`,
  `isSearchReferencesResult`, and `isReloadResult`. They encode the limits that the hand-written
  checks apply today, such as the 512-character bound.
- `index.ts`: the explicit exports.

Wire types that `src/lsp/coverage-observation.ts` defines today move to, or are mirrored in,
`src/protocol/types.ts`. Where an engine type and a wire type describe the same value, add a
compile-time mutual-assignability check in `src/lsp/` so they cannot drift.

### Consumers

- `src/lsp/handlers/custom.ts` and any other server code use the constants and guards. Behavior on
  invalid input stays the same (`null`, an empty list, or a silent ignore, as each handler does
  today).
- `extensions/vscode/src/extension.ts` imports the constants, types, and guards by relative path
  and validates responses it receives.
- Add a package export `./protocol` in `package.json` (`dist/protocol/index.js` and its types).
  This is the one permitted public API addition in this phase.

### Import policy

1. `protocol` is the first entry in `LAYERS`. A file in `protocol` that imports anything fails,
   whether the target is internal, an npm package, or a `node:` module.
2. The client may import `src/protocol/**` and nothing else under `src/`.
3. Update `docs/architecture.md` (the layer table and a short protocol section).

### Client coverage gate

Update `scripts/test-client.mjs` so that the expected source set is the files in
`extensions/vscode/src/` plus the files in `src/protocol/` that the client bundles. Keep the
thresholds at 90% and 85%. Do not loosen the "no other sources" assertion in any other way.

## Work order

1. Create `src/protocol/` with constants, types, and guards. Add its unit tests.
2. Extend the import policy and its tests.
3. Switch the server to the module.
4. Switch the extension to the module and update the client coverage gate.
5. Add the `./protocol` export and update the public API baseline with the new entry point only.
6. Update documents.
7. Run the verification gate, then `npm run extension:package` if it works offline.

## Success criteria

1. `grep -rn "'bve/" src extensions/vscode/src` finds matches only under `src/protocol/`.
2. Every custom payload received as `unknown` on either side is validated by a guard from
   `src/protocol/`.
3. `src/protocol/` has no import statement that leaves the directory.
4. `npm run architecture:check` enforces the two new rules.
5. Wire names and payload shapes are unchanged. No existing test changes, except for the client
   coverage inventory expectation if a test asserts it.
6. `node scripts/test-client.mjs` passes with the thresholds unchanged.
7. The public API baseline differs only by the new `./protocol` entry point.
8. `npm run extension:package` succeeds and the bundled `extension.cjs` does not contain engine
   code (search it for `validatePolicySources`; expect no match). If packaging needs a download and
   fails offline, report that and verify the bundle with a direct `esbuild` build of
   `extensions/vscode/src/extension.ts` using the options in `scripts/package-extension.mjs`.
9. The verification gate passes with zero skipped tests.

## Test cases

### New: `test/protocol.test.ts`

1. **Frozen wire names.** The method constants equal a literal list written in the test. This test
   keeps string literals on purpose: a rename must fail it.
2. **Guards accept** each valid payload: a minimal one and a maximal one.
3. **Guards reject**: wrong primitive types, arrays in place of objects, `null`, missing fields,
   extra-long strings (513 characters for `recordSelection`), non-integer and negative versions,
   and a digest of the wrong type.
4. **No widening.** For each guard, a value that today's hand-written server check rejects is
   rejected, and a value it accepts is accepted. Derive the table from the current handler code
   before changing it.
5. The module's compiled output has no `import` or `require` (read the compiled files).

### Extended: `test/architecture-boundaries.test.ts`

1. Client → `src/protocol/index.js` is accepted.
2. Client → `src/lsp/…` and client → `src/base/…` are rejected.
3. `src/protocol/x.ts` importing `../base/json.js` is rejected.
4. `src/protocol/x.ts` importing an npm package or `node:crypto` is rejected.
5. Any engine layer importing `src/protocol` is accepted.

### New: `test/protocol-parity.test.ts`

1. Every client-to-server method in the protocol has a registered server handler (reuse the
   recording connection from Phase 3).
2. Every server handler whose method starts with `bve/` is in the protocol.
3. `extensions/vscode/src/extension.ts` contains no string literal that starts with `bve/` (parse
   the source file with the TypeScript API).

### Existing suites that must stay green

All. The tests that send `bve/…` literals (`lsp-protocol`, `lsp-filesystem-observation`,
`lsp-coverage-observation`, `extension-client`, and others) stay untouched. They are the
independent check of the wire format.

## Risks

- **Bundle contamination.** A stray import from `src/protocol` into an engine module would pull the
  engine into the extension bundle. The import rule and criterion 8 guard this.
- **Coverage threshold.** New guard branches run in the client coverage report. Cover them through
  `test/extension-client.test.ts` additions if the threshold would otherwise drop; adding cases
  there is allowed.
- **JetBrains template.** `scripts/jetbrains-template.mjs` and its test must keep passing.

## Out of scope

Standard LSP methods, new custom methods, and changes to payload shapes.

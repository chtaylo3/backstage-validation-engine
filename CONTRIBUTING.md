# Contributing

Use Node 24.x and npm 11.x. Install dependencies with `npm ci`. Before you submit a change, run
`npm run check`. Include `package-lock.json` with dependency changes. This increment needs no global
TypeScript installation, broker, database, Go installation, or planning repository.

Keep one production engine. Add a module or package when the implementation needs a separate
boundary. Put each module in the lowest [engine layer](docs/architecture.md#engine-layers) that
holds everything it imports; `npm run architecture:check` rejects upward imports and import cycles. Use `.js` extensions in source imports for Node ESM, the ECMAScript module format. Put
public exports in `src/index.ts`, `src/contracts/index.ts`, and `src/lsp/index.ts`. Production
TypeScript uses strict type rules, unchecked-index checks, and exact optional properties.

Change contract definitions in `src/contracts/schemas.ts`. Then regenerate the JSON Schemas with
`npm run schemas:generate`. Include the generated `schemas/` resources in the change. The same
definitions supply the inferred types. If a wire format change breaks compatibility, change the
contract version. If behavior changes, update the examples and tests.

Both structural JSON Schema validation and semantic integrity checks are required. Structural
validation checks data shape. Semantic checks cover meaning and consistency.

Tests use `node:test` and `node:assert/strict`. Test behavior that callers depend on:
classification, source history, resource limits, integrity, cancellation, authority, and
compatibility. Do not relax a fixture expectation to make an implementation pass. Keep the frozen
planning fixtures unchanged. Their use against the production engine remains a future integration
requirement.

Keep source text, tokens, and credentials out of errors and logs. An identity reference, digest, or
bypass receipt does not prove authority. Trusted adapters and the future policy resolver must verify
signatures and authoritative assignments. Do not copy prototype authorization booleans into the
production API.

After a dependency update, run `npm run check`, `npm audit`, and `npm audit --omit=dev`. After a
CEL, RE2, or Backstage update, also run its qualification and frozen integration suites when those
runtimes are present. Record unsupported or unexecuted release requirements in
`docs/implementation-status.md`.

# Contributing

Use Node 24.x and npm 11.x, install with `npm ci`, and run `npm run check` before
submitting a change. Commit `package-lock.json` with dependency changes. No global
TypeScript, broker, database, Go installation, or planning repository is needed
for this increment.

Keep one production engine. Introduce modules and packages when an implementation
boundary needs them. Source imports use `.js` extensions for Node ESM; public
exports live in `src/index.ts` and `src/contracts/index.ts`. Production TypeScript
uses strict checking, unchecked-index checks, and exact optional properties.

Change contracts in `src/contracts/schemas.ts`, regenerate with
`npm run schemas:generate`, and include the generated `schemas/` resources in the
change. Types are inferred from those same definitions. Breaking wire changes
require a contract version change. Add or update examples and tests when semantics
change. Structural JSON Schema validation and semantic/integrity validation are
distinct requirements.

Tests use `node:test` and `node:assert/strict`. Test externally meaningful behavior:
classification, provenance, resource limits, integrity, cancellation, authority,
and compatibility. Do not relax a fixture expectation to make an implementation
pass. The frozen planning fixtures remain unchanged; running them against the
production engine is a future integration gate.

Keep source text, tokens, and credentials out of errors and logs. A typed identity
reference, digest, or bypass receipt is not proof of authority. Cryptographic
verification and authoritative assignment belong to trusted adapters and the
future policy resolver. Do not copy prototype authorization booleans into the
production API.

For dependency updates, rerun `npm run check`, `npm audit`, and
`npm audit --omit=dev`. CEL/RE2/Backstage updates also require their qualified and
frozen integration suites once those runtimes are present. Track unsupported or
unexecuted release gates explicitly in `docs/implementation-status.md`.

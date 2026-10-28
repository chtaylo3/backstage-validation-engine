# Backstage Validation Engine

One TypeScript engine for consistent Backstage catalog validation across CLI/CI,
IDEs, and hosted GitHub execution.

**Status: foundation and managed CEL rules stage implemented.** Contract version
0.2, immutable snapshots, pinned-artifact consistency, supervised CEL/RE2 workers,
and dependency-aware rule execution are available. Entity parsing, Backstage
adapters, schema rules, the CLI, LSP, and hosted controller are the next increments.
This package is private during development.

## Development

Use Node **24.x** and npm **11.x**. `.nvmrc` pins the development runtime.

```bash
nvm install
nvm use
npm ci
npm run check
```

`npm run check` runs strict type checking, ESLint, formatting verification, schema
drift detection, a production build, and the tests. CI schedules the same checks
on Linux, Windows, and macOS; a configured matrix is not evidence that those runs
have passed. Dependency lifecycle scripts are disabled in `.npmrc`.

| Command                    | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `npm run build`            | Compile ESM JavaScript, declarations, and source maps into `dist/`  |
| `npm test`                 | Compile and run the Node test suite                                 |
| `npm run test:coverage`    | Run tests with Node's experimental coverage report                  |
| `npm run lint`             | Run ESLint with TypeScript type information                         |
| `npm run format`           | Format source, examples, and documentation                          |
| `npm run schemas:generate` | Regenerate checked-in JSON Schemas from the contract definitions    |
| `npm run schemas:check`    | Fail if checked-in schemas differ from the definitions              |
| `npm run clean`            | Remove build, test, and coverage output                             |
| `npm run example:cel`      | Execute a normalized-entity fixture through the managed rules stage |
| `npm run benchmark:cel`    | Measure fresh-process, warm, and 100-entity rules-stage latency     |

## Use the foundation

After building, run this from the repository root:

```js
import { createSourceSnapshot, overlaySourceSnapshot, parseContract } from './dist/index.js';

const source = createSourceSnapshot({
  repository: 'https://github.com/example/service',
  revision: 'immutable-source-revision',
  files: [
    {
      uri: 'file:///workspace/catalog-info.yaml',
      text: 'kind: Component\n',
    },
  ],
});

const proposed = overlaySourceSnapshot(source, [
  {
    uri: 'file:///workspace/catalog-info.yaml',
    text: 'kind: API\n',
    origin: 'buffer',
    version: 2,
  },
]);

parseContract('source-snapshot', proposed); // Checks shape, limits, and digests.
console.log(proposed.digest);
```

Snapshots copy and freeze their input. This example demonstrates source
snapshotting; YAML and entity validation have not run.

For managed selectors/expressions, cancellation, and rule reports, see the
[CEL runtime guide](docs/cel-runtime.md) and runnable `npm run example:cel` fixture.

## Structure

```text
src/
  contracts/   Versioned schemas, inferred types, and contract validation
  core/        Canonical JSON, snapshots, bindings, findings, and outcomes
  policy/      Deployment defaults and bounded rule dependency graphs
  runtime/     Shared supervised CEL/RE2 workers and request budgets
schemas/       Generated draft-07 JSON Schemas, checked into Git
examples/      Wire examples for requests, profiles, and result states
test/          Contract, integrity, resource, and enforcement tests
docs/          Architecture, contract semantics, and delivery status
```

Start with [architecture](docs/architecture.md), [contract semantics](docs/contracts.md),
and [implementation status](docs/implementation-status.md). See
[CONTRIBUTING.md](CONTRIBUTING.md) for change and verification conventions.

The local `plan/` directory is a separate, ignored planning repository. Its
prototypes, frozen 0.1 fixtures, and historical evidence remain intact. Production
builds and tests do not depend on that directory.

## License

[Apache License 2.0](LICENSE), following the provisional licensing direction in
the accepted implementation plan.

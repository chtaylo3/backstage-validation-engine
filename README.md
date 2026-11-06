# Backstage Validation Engine

One TypeScript engine for consistent Backstage catalog validation across CLI/CI,
IDEs, and hosted GitHub execution.

**Status: source parsing, declared BC-01 through BC-07, catalog policies and stdio LSP implemented.** Contract version
0.2, immutable snapshots, pinned-artifact consistency, supervised CEL/RE2 workers,
and dependency-aware rule execution are available. YAML parsing includes bounded
normalization, UTF-16 locations and CI/IDE document handling. Pinned Backstage
adapters apply native kinds/policies and field-specific references with source
provenance. Explicit catalog rules feed cancellable, versioned LSP diagnostics.
Snapshot-local substitutions preserve included-file ranges and buffer versions.
Pinned kind/source admission and custom schemas run before rules. Proposed
overlays now qualify local targets and mask removed/invalid identities before
catalog lookup. Required unavailable processing blocks all dependent stages.
Executable processor integrations, organization schema rules, CLI
and hosted control remain.
Bounded catalog HTTP access returns immutable observations with scoped caches,
retry limits and cancellation, tested against pinned multi-version fixtures.
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

| Command                             | Purpose                                                             |
| ----------------------------------- | ------------------------------------------------------------------- |
| `npm run build`                     | Compile ESM JavaScript, declarations, and source maps into `dist/`  |
| `npm test`                          | Compile and run the Node test suite                                 |
| `npm run test:harness`              | Check version selection, pinned artifacts and concurrent fixtures   |
| `npm run test:lsp`                  | Exercise catalog policy rules and real stdio editor lifecycle       |
| `npm run fixtures:serve`            | Start the pinned fake catalog APIs on isolated localhost ports      |
| `npm run fixtures:refresh`          | Capture latest patches and upstream specs for supported minors      |
| `npm run fixtures:check-upstream`   | Detect upstream release, package or contract drift                  |
| `npm run test:coverage`             | Run tests with Node's experimental coverage report                  |
| `npm run lint`                      | Run ESLint with TypeScript type information                         |
| `npm run format`                    | Format source, examples, and documentation                          |
| `npm run schemas:generate`          | Regenerate checked-in JSON Schemas from the contract definitions    |
| `npm run schemas:check`             | Fail if checked-in schemas differ from the definitions              |
| `npm run clean`                     | Remove build, test, and coverage output                             |
| `npm run example:cel`               | Execute a normalized-entity fixture through the managed rules stage |
| `npm run example:parse`             | Parse an immutable catalog fixture and show source locations        |
| `npm run example:backstage`         | Parse a fixture, apply native policies and run CEL rules            |
| `npm run example:custom`            | Validate an admitted custom kind against its pinned schema and CEL  |
| `npm run example:overlay`           | Qualify proposed local additions or baseline-relative deletions     |
| `npm run example:provider -- URL`   | Read observations from a running fake catalog API                   |
| `npm run example:references -- URL` | Prepare source references and pin catalog data for evaluation       |
| `npm run benchmark:cel`             | Measure fresh-process, warm, and 100-entity rules-stage latency     |

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

For YAML parsing, exact source ranges, recovery and budgets, see the
[parsing guide](docs/parsing.md) and `npm run example:parse`.

For versioned native envelopes/kinds, policies and normalization provenance, see
[Backstage compatibility](docs/backstage-compatibility.md) and `npm run example:backstage`.

For the versioned catalog HTTP fake, fixture controls and upstream update process,
see the [testing harness guide](docs/testing-harness.md). Start one minor with
`npm run fixtures:serve -- 1.56`, or omit the minor to start all fixture targets.

For contextual references and source-to-provider data pinning, see
[source references](docs/source-references.md) and `npm run example:references -- URL`.

For catalog-existence policies, trusted launcher setup, and the stdio language
server, see the [LSP guide](docs/lsp.md).

For safe local includes, file Locations, source roots and catalog entrypoints,
see [snapshot-local substitutions](docs/substitutions.md).

For global/source allowances, pinned custom schemas and launcher artifacts, see
[admission and custom kinds](docs/admission-custom-kinds.md).

For local catalog precedence, baseline snapshots, deletions/renames and conflicts,
see [proposed catalog overlays](docs/proposed-overlays.md).

## Structure

```text
src/
  contracts/   Versioned schemas, inferred types, and contract validation
  core/        Canonical JSON, snapshots, bindings, findings, and outcomes
  parsing/     Bounded YAML normalization, diagnostics and source locations
  compatibility/  Versioned native Backstage adapters and normalization provenance
  lsp/         Stdio transport, trusted host configuration and editor lifecycle
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

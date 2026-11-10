# Backstage Validation Engine

One TypeScript engine validates Backstage catalog data in command-line tools, continuous integration
(CI), editors, and hosted GitHub runs.

Source parsing, declared BC-01 through BC-07 compatibility, signed policies, the CLI, and the stdio
language server are implemented. The CLI is the command-line interface. The language server uses the
Language Server Protocol (LSP) for editor features. The current contract version is 0.2. The package
remains private during development.

Snapshots preserve fixed copies of source and data. The engine checks that pinned artifacts match
those copies. It runs CEL expressions and RE2 patterns in supervised workers. CEL is the Common
Expression Language for policy expressions. RE2 provides bounded regular-expression matching. Rules
follow their declared dependencies.

YAML parsing limits resource use and preserves UTF-16 source locations for CI and editors.

Pinned Backstage adapters apply native kind and policy checks. They retain each field's source and
normalization history. Local substitutions preserve included-file ranges and buffer versions.
Admission rules and custom schemas run before policy rules.

Proposed catalog overlays represent local changes. They recognize valid local targets and hide
removed or invalid identities before catalog lookup. If required processing is unavailable, every
dependent stage stops.

Explicit catalog rules produce cancellable LSP diagnostics tied to document versions. With host
approval, filesystem refresh updates saved files and includes through LSP save and watch
notifications. It preserves open buffers and the original request deadline. Signed releases retain
required baseline policies and activate pinned schema, CEL, and catalog policies. The CLI emits
contract JSON or SARIF reports with exit codes 0, 1, or 2. SARIF is a standard format for
code-analysis results.

The VS Code preview packages the engine and Node runtime in a VSIX, an installable extension
package. [GitHub Actions](docs/github-actions.md) runs source, packaged, and installed-editor tests
on Linux, Windows, and macOS and retains the VSIX artifacts. Catalog HTTP access returns immutable
observations. It limits cache scope, retries, and execution time and supports cancellation. Tests
use pinned fixtures for multiple backend versions. Executable processor integrations and hosted
governance control remain open.

## Development

Use Node 24.x and npm 11.x. `.nvmrc` pins the development runtime.

```bash
nvm install
nvm use
npm ci
npm run check
```

`npm run check` checks types, lint, formatting, and generated schemas, then builds the production
package, runs tests, and enforces client coverage. CI runs the same checks on Linux, Windows, and macOS. A configured matrix
does not prove that its runs passed. `.npmrc` disables dependency lifecycle scripts.

| Command                                   | Purpose                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `npm run build`                           | Compile ESM JavaScript, declarations, and source maps into `dist/`  |
| `npm run cli:package`                     | Build a CLI archive with a locked dependency graph and provenance   |
| `npm test`                                | Compile and run the Node test suite                                 |
| `npm run test:harness`                    | Check version selection, pinned artifacts and concurrent fixtures   |
| `npm run test:lsp`                        | Exercise catalog policies, fixes, completion and stdio lifecycle    |
| `npm run fixtures:serve`                  | Start the pinned fake catalog APIs on isolated localhost ports      |
| `npm run fixtures:refresh`                | Capture latest patches and upstream specs for supported minors      |
| `npm run fixtures:check-upstream`         | Detect upstream release, package or contract drift                  |
| `npm run test:coverage`                   | Run tests with the experimental coverage report from Node           |
| `npm run test:client`                     | Check VS Code client behavior and coverage thresholds               |
| `npm run test:extension:ssh-network`      | Check authenticated SSH fixture networking                          |
| `npm run lint`                            | Run ESLint with TypeScript type information                         |
| `npm run format`                          | Format source, examples, and documentation                          |
| `npm run schemas:generate`                | Regenerate checked-in JSON Schemas from the contract definitions    |
| `npm run schemas:check`                   | Fail if checked-in schemas differ from the definitions              |
| `npm run clean`                           | Remove build, test, and coverage output                             |
| `npm run example:cel`                     | Execute a normalized-entity fixture through the managed rules stage |
| `npm run example:parse`                   | Parse an immutable catalog fixture and show source locations        |
| `npm run example:backstage`               | Parse a fixture, apply native policies and run CEL rules            |
| `npm run example:custom`                  | Validate an admitted custom kind against its pinned schema and CEL  |
| `npm run example:cli -- /tmp/bve-example` | Generate a signed local CLI example and separate host trust         |
| `npm run example:overlay`                 | Qualify proposed local additions or baseline-relative deletions     |
| `npm run example:provider -- URL`         | Read observations from a running fake catalog API                   |
| `npm run example:references -- URL`       | Prepare source references and pin catalog data for evaluation       |
| `npm run benchmark:cel`                   | Measure fresh-process, warm, and 100-entity rules-stage latency     |

## Use the foundation

Build the project. Then run this example from the repository root:

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

Snapshots copy and freeze their input. This example creates a source snapshot and overlays a buffer
change. It does not parse YAML or validate entities.

For managed rule selectors and expressions, cancellation, and rule reports, see the
[CEL runtime guide](docs/cel-runtime.md) and runnable `npm run example:cel` fixture.

For YAML parsing, exact source ranges, recovery and budgets, see the
[parsing guide](docs/parsing.md) and `npm run example:parse`.

For versioned native entity and kind checks, policies, and normalization history, see
[Backstage compatibility](docs/backstage-compatibility.md) and `npm run example:backstage`.

For the versioned catalog HTTP fake, fixture controls and upstream update process, see the
[testing harness guide](docs/testing-harness.md). Start one minor with
`npm run fixtures:serve -- 1.56`, or omit the minor to start all fixture targets.

For reference contexts and fixed provider data collected from source references, see
[source references](docs/source-references.md) and `npm run example:references -- URL`.

For optional real Backstage and SQLite tests, see the [environment guide](test/integration/backstage/README.md).
The shared Compose environment runs the packaged CLI and installed VSIX against actual catalog ingestion.
Its full suite runs during release qualification or explicit local tests.

For catalog-existence policies, trusted launcher setup, and the stdio language server, see the
[LSP guide](docs/lsp.md).

For field and value suggestions, hover, definitions, schema repairs, catalog search, discovery,
configuration reload, and JetBrains setup, see [editor features](docs/editor-features.md).

For future CEL, RE2, and plugin contributions, see the
[rule and editor capability plan](docs/plugin-capabilities-plan.md). It defines required interfaces,
execution controls, and conformance tests for each supported function.
The [five-phase editor plan](docs/lsp-editor-improvements-plan.md) defines the implementation sequence and acceptance criteria.
Its client reliability and release qualification phase is deferred.

For safe local includes, file Locations, source roots and catalog entrypoints, see
[snapshot-local substitutions](docs/substitutions.md).

For kind allowances by source, pinned custom schemas, and launcher artifacts, see
[admission and custom kinds](docs/admission-custom-kinds.md).

For local catalog precedence, baseline snapshots, deletions/renames and conflicts, see
[proposed catalog overlays](docs/proposed-overlays.md).

For immutable signed releases, mandatory policy inheritance, schema rules and JSON/SARIF commands,
see the [policy and CLI guide](docs/policy-cli.md).

## Structure

```text
src/
  contracts/   Versioned schemas, inferred types, and contract validation
  core/        Canonical JSON, snapshots, bindings, findings, and outcomes
  parsing/     Bounded YAML normalization, diagnostics and source locations
  compatibility/  Versioned native Backstage adapters and normalization provenance
  lsp/         Stdio transport, trusted host configuration and editor lifecycle
  policy/      Signed releases, mandatory inheritance and bounded rule graphs
  cli/         Snapshot validation command and JSON/SARIF reporting
  runtime/     Shared supervised CEL/RE2 workers and request budgets
schemas/       Generated draft-07 JSON Schemas, checked into Git
examples/      Wire examples for requests, profiles, and result states
test/          Contract, integrity, resource, and enforcement tests
docs/          Architecture, contract semantics, and delivery status
```

Start with [architecture](docs/architecture.md), [contract semantics](docs/contracts.md), and
[implementation status](docs/implementation-status.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for
change and verification conventions.

The local `plan/` directory contains a separate Git repository that the main repository ignores. It
retains the prototypes, frozen 0.1 fixtures, and historical evidence. Production builds and tests do
not depend on it.

## License

[Apache License 2.0](LICENSE), following the provisional licensing direction in the accepted
implementation plan.

# Documentation index

Each document in `docs/` and `docs/history/` appears here once. Reference documents describe the
current system and the work in progress. History holds completed plans, records, and handoffs,
kept as they were written.

## Reference

- [Admission and custom kinds](admission-custom-kinds.md): BC-05 kind allowances and immutable custom-kind schema artifacts.
- [Architecture](architecture.md): runtime boundaries, engine layers, pipeline stages, LSP structure, and fixed decisions.
- [Native Backstage compatibility](backstage-compatibility.md): the pinned catalog-model adapters and BC-01 to BC-06.
- [Backstage and SQLite release tests](backstage-release-test-plan.md): the release test applications, runner, and workflow.
- [Built-in capability interfaces](capability-interfaces.md): the versioned interfaces of the built-in providers.
- [Production catalog provider](catalog-provider.md): the limited HTTP catalog adapter and its caches and retries.
- [Temporary CEL duplicate-key fix](cel-duplicate-key-workaround.md): the local CEL mitigation and its verification.
- [Managed CEL and rules execution](cel-runtime.md): the `bve-cel/1` runtime, its workers, and its limits.
- [Production contracts 0.2](contracts.md): the generated draft-07 contract schemas and their invariants.
- [Editor features](editor-features.md): completion, hover, definitions, repairs, and catalog search in the editor.
- [Hosted qualification and VS Code packages](github-actions.md): the CI workflow, hosted matrices, and packages.
- [Implementation status](implementation-status.md): the implementation increments in order, with their test results.
- [Local setup](local-setup.md): run a Docker Backstage application against a locally installed VS Code extension.
- [Catalog policies and language server](lsp.md): the stdio language server, its configuration, and its handlers.
- [Source-preserving parsing](parsing.md): the YAML parser, source locations, and parse coverage.
- [Rule and editor capability plan](plugin-capabilities-plan.md): the planned capability interfaces and delivery gates.
- [Signed policies, schema rules and CLI](policy-cli.md): signed policy releases, schema rules, and the CLI.
- [Required deployment processing](processors.md): BC-07 and the deployment-processor inventory.
- [Proposed catalog overlays](proposed-overlays.md): BC-06 overlays of proposed local changes on the catalog view.
- [Release evidence checks](release-evidence-contract.md): the host runner's evidence rows and no-Docker controls.
- [CEL and RE2 editor contributions](rule-editor-contributions.md): editor artifacts that declare hints for approved rules.
- [Source references and catalog preparation](source-references.md): BC-03 reference contexts and catalog preparation.
- [Snapshot-local substitutions and Locations](substitutions.md): BC-04 substitutions and Location discovery.
- [Test harness remediation findings](test-harness-remediation-findings.md): the frozen finding register of the harness remediation.
- [Test harness remediation handoff](test-harness-remediation-handoff.md): the agent handoff of the harness remediation.
- [Test harness remediation plan](test-harness-remediation-plan.md): the approved harness remediation plan.
- [Test harness remediation record](test-harness-remediation-record.md): the implementation record of the harness remediation.
- [Versioned Backstage test harness](testing-harness.md): the test groups, the runner, and the versioned Backstage fixtures.
- [VS Code qualification evidence](vscode-qualification.md): the provisional VS Code regression limits and their evidence.
- [Architecture remediation](architecture-remediation/README.md): the phased architecture remediation plans and their shared rules.
- [Evidence](evidence/): measurement captures referenced by the CEL runtime documents.

## History

- [Session handoff before moving the checkout](history/SESSION_HANDOFF.md): the handoff saved before the checkout moved into WSL.
- [LSP editor improvements record](history/lsp-editor-improvements-implementation-record.md): phase decisions and executed checks of the editor plan.
- [LSP editor improvements plan](history/lsp-editor-improvements-plan.md): the five-phase editor improvements plan.
- [LSP separation plan](history/lsp-separation-implementation-plan.md): the plan that separated LSP ownership, merged in PR #2.
- [LSP separation record](history/lsp-separation-implementation-record.md): the qualification record of the LSP separation.
- [WSL development transition plan](history/wsl-development-transition-plan.md): the plan that moved the checkout into the WSL filesystem.

# Real Backstage release tests

This environment runs real Backstage applications with SQLite and generated catalog data.
The CLI is the command-line interface. A VSIX is an installable VS Code extension package.
The packaged CLI and installed VSIX use the real catalog APIs.
The application and test tools run in separate containers on one Compose network. The host Node runner controls Docker.

A digest is a fingerprint of file or data content.
The supported targets are Backstage 1.55.3 and 1.56.3. `targets.json` pins their package versions and source commits.
Each application has its own Yarn 4.13.0 lockfile. The application image uses a pinned Node 24.22.1 base.
The test image pins its Linux libraries, Node runtime, and Xvfb display tools through an immutable image digest.

The first local feasibility checks passed on both applications. They covered nine authored entities, four expected relationships, and authenticated catalog reads.
A development probe passed all 59 cases on Backstage 1.55.3, including both pinned editors and cleanup.
Separate probes passed all 12 editor cases in each pinned editor on Backstage 1.56.3.

These development observations use different package builds. They do not qualify a candidate.
The release profile still requires a clean candidate, a successful local run, and a successful hosted run.
A development run cannot qualify a release.

## Prerequisites

Use the active checkout in the WSL ext4 filesystem. Keep the original Windows checkout as a backup.
Use Node 24.22.1 and Docker with Linux x64 containers. Docker Compose must be available.
Application and test image builds need network access and disk capacity.

From the repository root, run:

```sh
nvm use
npm ci
npm run backstage:test:check
```

The check command compares targets with the support inventory and examines the seed format. It does not invoke Docker.
Normal root installation and tests do not install Backstage dependencies or start this environment.
The CLI package and VSIX exclude the application, seed files, SQLite state, and test credentials.

## Start a local application

Choose one target and a new run ID. A run ID identifies the resources that the runner owns.
The following command builds the shared images, creates isolated volumes, renders the baseline, and starts Backstage:

```sh
npm run backstage:test:up -- --target=1.56.3 --run=local-demo
npm run backstage:test:status -- --run=local-demo
```

Open the printed browser URL. The port accepts connections through host loopback only.
The browser can use the fixture guest sign-in. Automated clients use temporary static credentials.
The test container reaches `http://backstage:7007`. Host `localhost` refers to a different network location.

The host runner keeps credentials in a restricted temporary directory. It records resource ownership under `.artifacts/backstage-private/`.
Neither directory is part of the uploaded reports. The containers do not receive the Docker socket.

The test tools use the host account's numeric Linux user and group IDs. This includes user 1001 on GitHub-hosted runners.
Compose disables automatic image copying for the catalog and work volumes. Otherwise, Docker can replace an empty volume's owner with the image's user 1000.
The initializer assigns the owned directories to the host account before the test tools start.
The home directory, npm cache, and editor downloads stay in the work volume. Backstage reads catalog files through a read-only mount.

The trusted catalog configuration explicitly permits HTTP for this isolated Compose connection with `allowInsecureHttp: true`.
Other connections retain their default transport restrictions. Proposal content and workspace configuration cannot set this flag.

## Change, restart, and reset the catalog

A seed is the catalog data used to initialize a run.
The JSON states under `data/` contain authored entities and expected observations.
`catalog-seed.schema.json` defines the format. Semantic guards also reject duplicate identities, unsafe paths, conflicting expectations, and cycles between Location files.

`entities` supplies the root catalog documents. `entityFiles` supplies named payload files for file Locations.
The loader emits JSON documents as valid YAML 1.2. It installs payloads before the root file and replaces each file atomically.
Backstage creates its own tables and relationships through normal ingestion. The loader never inserts database rows.

Apply the mutation state, then wait for authenticated reads to match its expected bodies, relationships, and absences:

```sh
npm run backstage:test:seed -- --run=local-demo --data=test/integration/backstage/data/mutation.json
npm run backstage:test:down -- --run=local-demo
npm run backstage:test:up -- --run=local-demo
npm run backstage:test:reset -- --run=local-demo
```

The down command removes the containers and network but retains the run volumes.
The next up command uses the same application image and saved state. It does not seed a new database.
The reset command replaces only the owned SQLite volume and restores the baseline.
Each enabled plugin uses a separate file under `/state`.

Remove all resources for this run with:

```sh
npm run backstage:test:clean -- --run=local-demo
```

Cleanup examines the owner and run labels before removing containers, networks, or volumes.
It does not remove another run's resources. Sanitized reports remain available after cleanup.

## Run the packaged clients during development

Build the CLI archive and Linux VSIX from the current sources. The archive includes its production dependency lock.
The VSIX includes the engine and pinned runtime. Use the archive paths printed by the package commands:

```sh
npm run cli:package
npm run extension:package
npm run test:backstage:development -- --target=1.56.3 --run=development-demo --cli=/absolute/path/candidate.tgz --vsix=/absolute/path/candidate.vsix
```

The development command runs the selected target with both pinned editor versions. It records failures and removes its resources.
Use a new run ID for each suite. The runner rejects reuse of earlier results or a persistent environment's run ID.
Development packages can contain uncommitted inputs. Their reports retain development mode and cannot satisfy the release verifier.

For an independent editor investigation, supply the packages when you create the local environment:

```sh
npm run backstage:test:up -- --target=1.56.3 --run=editor-demo --cli=/absolute/path/candidate.tgz --vsix=/absolute/path/candidate.vsix
npm run backstage:test:editor -- --run=editor-demo --editor=1.145.2
npm run backstage:test:clean -- --run=editor-demo
```

The editor command uses the installed candidate. A separate driver extension supplies the tests.
Each case gets a fresh editor process, user profile, launcher configuration, and workspace.
The host stops and starts Backstage when the editor requests an outage phase.

## Use the optional Dev Container

The repository's Dev Container configuration builds the shared test image from its Dockerfile.
In VS Code, run `Dev Containers: Reopen in Container` from the repository checkout.
This gives you the pinned runtime and editor tools for interactive work.
Run the environment commands from the host terminal because Docker control stays on the host.

## Run the release profile

For an isolated permission regression, first build target 1.55.3 and prepare a CLI archive in `.artifacts/cli/package-info.json`.
Then run `node test/integration/backstage/permissions.mjs` from the repository root.
This command uses the shared Compose configuration with user 1001. It installs the CLI, downloads the pinned editor, and tests seed replacement across containers.
It also tests catalog reads as the application's user 1000 and removes its own temporary resources.
Normal project tests do not run this Docker regression.

Use a clean candidate commit and packages built at that exact revision. The release command rejects dirty implementation inputs.
It also rejects a CLI archive or VSIX whose recorded identity differs from the requested candidate.
It always runs both Backstage targets and both pinned editor versions:

```sh
npm run test:backstage:release -- --revision=FULL_CANDIDATE_SHA --run=release-demo --cli=/absolute/path/candidate.tgz --vsix=/absolute/path/candidate.vsix
```

The release workflow uses the same command and containers. It runs only after an explicit release-candidate dispatch.
Pull requests, merges, ordinary pushes, and schedules do not start the full environment.
The workflow revision must match the requested commit. Hosted tests consume the existing candidate packages instead of rebuilding a different VSIX.

The suite checks CLI JSON and SARIF output, exits 0/1/2, native and policy failures, unavailable processors, and malformed input.
It also checks installed-editor diagnostics, completion, guarded fixes, unsaved edits, save events, watchers, stale fixes, and restart.
Mutation cases wait for catalog convergence before they wait for normal client cache refresh.
The clients compare stable finding IDs and source locations on equivalent input.

Authorization cases distinguish missing or invalid credentials from valid credentials denied catalog access.
The denied credential exercises Backstage's actual plugin authorization boundary. It is not a proxy response.
A UID is an entity's stored unique identifier. Restart cases require unchanged entity UIDs. Reset cases require a fresh database and restored baseline.
Deliberate runner failures exercise failed builds, ingestion errors, editor crashes, interrupted work, missing reports, and failed cleanup.

## Read the reports

The root report is `.artifacts/backstage/<run-id>/results.json`. JUnit output is beside it.
Each target has its own `reports/` directory for sanitized logs, client output, editor evidence, and optional failure screenshots.
The root report records versions, package and source digests, case counts, and cleanup status.
Screenshots are OPTIONAL DIAGNOSTICS. They have no integrity or completeness claim.
Required client and native Trust assertions remain independent from screenshot availability.
Each CLI phase retains its own sanitized `reports/authority/<phase>.json`. Processor fixtures use a separate suffix.
Each editor session retains its own `authority.json` with constructor verification and effective expiry.
These reports omit launcher data, keys, signatures, credentials, endpoints, and private paths.
Contract 0.2 bundles have no validity fields. See [authority evidence](../../../docs/backstage-release-test-plan.md#current-proposal-and-authority-evidence).
The most recent suite path is also in `.artifacts/backstage/latest-release.json`.

An active case fails if execution stops before completion. Remaining cases stay unexecuted.
Missing cases, failed assertions, invalid provenance, or failed cleanup block qualification.
The verifier derives expected inventories, seed data, policy, and package identities from the candidate checkout.
It rejects evidence from different inputs.

Upload only the root result, JUnit output, and target `reports/` directories.
Keep raw SQLite files, environment files, signed launcher material, and credentials outside that upload set.
Local evidence and hosted evidence are separate requirements. The existing native OS, remote, and endurance release requirements still apply.

## Focused H4 backend controls

Create a clean CLI candidate with `npm run cli:package`.
Run `node scripts/test-h4-backends.mjs --cli <candidate.tgz>` from the repository root.
The command exercises both supported backends without an installed editor or a release-wide workload.

The focused command derives each test image from its cached pinned application image.
It installs the changed app manifest with immutable Yarn admission and records package, lock, source, configuration, and image identities.
Its deterministic permission service delegates the native `ServerPermissionClient` before it denies `catalog.entity.read` for `bve-filtered`.
Administrator, reader, filtered, and plugin-denied identities remain separate. This does not qualify a remote permission backend or conditional resource policies.

Normal file ingestion must produce all declared baseline and mutation graph tuples.
The graph includes component/resource System relations, their inverse relations, and the existing System-Domain relation.
Mutation convergence also rejects declared obsolete ownership and API relations. Generated location edges need no removal unless a seed declares it.
Catalog convergence and client cache convergence remain separate observations. The focused CLI/provider calls use fresh processes or fresh providers.

The write control sends the same valid `POST /api/catalog/refresh` body with administrator and reader credentials.
The administrator succeeds, the reader receives HTTP 403, and the reader still reads the entity.
The backend decision report attributes that rejection to native token permission restrictions.

Reports remain under `.artifacts/harness-remediation/H4/backends`. Credentials remain in each run's private directory.
The default command removes only its owned container and SQLite volume. It never writes database rows directly.
For independent inspection, add `--target 1.56.3 --keep`. Use that run's private `connection.json` and `backend.env` locally.
Remove the recorded container and volume after inspection. Preserve the existing host-network CI and published-port Docker Desktop/WSL SSH paths.

The declared inventory contains 47 cases: nine environment, 16 CLI, 12 editor, and ten runner cases.
Two pinned editor versions expand it to 59 executions per backend and 118 across both targets.
Run `node scripts/qualification-inventory.mjs` from the repository root for revision-bound counts without execution.
The [H4 record](../../../docs/test-harness-remediation-record.md#h4-catalog-compatibility-and-convergence) qualifies a separate 22-control scope per backend at an older candidate.
No new full-matrix qualification follows from this inventory reconciliation.

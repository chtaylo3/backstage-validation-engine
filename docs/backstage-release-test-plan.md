# Increment 6: Backstage and SQLite release tests

Status: implementation complete. Exact-candidate local and hosted qualification remain open.
The applications, loader, shared runner, client drivers, and release workflow now exist.
The [environment guide](../test/integration/backstage/README.md) describes the commands, reports, and measured development results.
This is increment 6 of the VS Code test remediation plan. The broader product roadmap has a separate phase 6 for enterprise release work.

## 1. Scope and decisions

Run a real Backstage application with fake catalog data and SQLite. Use the packaged CLI and
installed VS Code extension as its clients. Exercise actual catalog ingestion, authentication,
relationships, and persistence. Ingestion is the process that imports entities into the catalog.
Keep the application available for local exploration through its web interface.

Use one Docker Compose definition and one Node runner for local development and GitHub Actions.
Compose defines the application containers and their shared network. A small host runner controls
Docker and container lifecycle. A shared Linux test-runner image contains the data loader and client
test tools.

Backstage runs beside that test container on the same Compose network. GitHub Actions supplies the
machine and uploads reports. It does not contain a second setup or seed implementation.

The complete environment runs during release qualification and explicit local development tests.
Pull requests, merges, ordinary pushes and scheduled checks do not build or start it. Existing
simulated catalog tests continue on their current triggers. Small checks of the JSON files and
runner can run without Docker.

Use SQLite files for the required release profile. These files preserve state across application
restarts. An optional in-memory profile supports disposable local exploration. In-memory results do
not qualify persistence scenarios. PostgreSQL behavior and multiple backend replicas are outside
this increment.

## 2. Development dependency boundary

Treat the Backstage application as an optional development environment. This serves the same purpose
as a separate development dependency group with uv, the Python package manager. The project remains
a Node project and does not acquire a Python dependency.

Keep the application in a separate test directory with its own package manifest, Yarn lockfile and
exact package-manager version. Pin its Node base image by digest. Install its dependencies inside
the Docker build with an immutable lockfile. Use the same build stages for local development and
release qualification.

The normal root `npm ci`, `npm test` and `npm run check` commands must not install the Backstage
application or invoke Docker. Root commands dispatch the optional environment only when explicitly
requested. No install hook downloads images. Docker Engine or Docker Desktop with Compose is an
explicit prerequisite. The host runner uses Node built-ins and does not need Backstage dependencies.
Root npm commands can dispatch it without installing the application on the host.

The released CLI package and VSIX exclude the test application, its dependencies, sample data,
SQLite files and test credentials. Inspect both package inventories to prove this boundary. No test
server becomes a runtime dependency of either client.

### Proposed files

The paths below define the implementation boundaries. The application manifests belong to the test environment, separate from production package manifests.
Generated state belongs under the existing ignored artifact root.

| Path                                                    | Purpose                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `test/integration/backstage/compose.yaml`               | Shared container, ports, mounts and health configuration                       |
| `test/integration/backstage/test-runner.Dockerfile`     | Pinned Linux image with Node, CLI tools, editor libraries and Xvfb             |
| `.devcontainer/devcontainer.json`                       | Optional interactive environment based on the shared test-runner image         |
| `test/integration/backstage/Dockerfile`                 | Locked application build with the native SQLite driver                         |
| `test/integration/backstage/apps/<target>/`             | Application source, manifests and lockfile for each supported target           |
| `test/integration/backstage/targets.json`               | Exact application versions, image inputs and expected installed packages       |
| `test/integration/backstage/app-config.test.yaml`       | Shared catalog, authentication and SQLite configuration                        |
| `test/integration/backstage/catalog-seed.schema.json`   | Schema for the versioned JSON sample format                                    |
| `test/integration/backstage/data/*.json`                | Baseline catalog and complete replacement states for mutation scenarios        |
| `test/integration/backstage/cases.json`                 | Required case IDs, client coverage and expected results                        |
| `test/integration/backstage/lib/clients.mjs`            | Inline `validText` and `invalidText`, rendered into owned `workRoot/proposals` |
| `scripts/backstage-test-env.mjs`                        | Shared build, lifecycle, seed and test entry point                             |
| `test/integration/backstage/lib/`                       | Runner modules and real-backend client test drivers                            |
| `.github/workflows/backstage-release-qualification.yml` | Explicit release qualification entry point                                     |
| `.artifacts/backstage/<run-id>/`                        | Generated files, local connection details and sanitized reports                |

Resolve target names from the existing supported Backstage inventory. At design time it selects
umbrella releases 1.55.3 and 1.56.3. Their catalog backend packages are 4.0.0 and 4.0.2
respectively. Their model packages are 1.10.1 and 1.10.2 respectively.

Derive each application from the corresponding upstream release template. Do not assume that an
umbrella release number is an npm package version. Each target has a complete locked dependency set
and a recorded source revision. Reject disagreement between the support inventory and the resolved
application.

## 3. JSON sample data and database loading

Commit JSON as the authoritative sample data format. Validate each file against a project-owned JSON
Schema before startup. The file describes authored catalog entities and expected observations. The implemented schema also requires `entityFiles` for named Location payloads.
An empty `entityFiles` array is valid when no payload files are needed. The abbreviated example below includes that empty array. It
contains no SQL statements, database rows, stored UIDs or authentication tokens.

Load this data through Backstage catalog ingestion. The loader inside the test-runner container
renders deterministic catalog YAML. It writes generated files into a run-owned shared volume.
Compose mounts that volume into the application as read-only. Backstage reads a configured file
Location and writes its own SQLite records. This preserves actual processing and relationship
creation.

Do not insert rows directly into Backstage tables. Direct SQL loading bypasses ingestion and depends
on private database schemas. Do not commit a prebuilt SQLite database or bake populated databases
into the image. Backstage creates its schema through its normal migrations at startup.

This abbreviated JSON example shows the proposed format:

```json
{
  "schemaVersion": 1,
  "id": "baseline-example",
  "entities": [
    {
      "apiVersion": "backstage.io/v1alpha1",
      "kind": "Group",
      "metadata": { "name": "team-demo", "namespace": "bve-demo" },
      "spec": { "type": "team", "children": [] }
    },
    {
      "apiVersion": "backstage.io/v1alpha1",
      "kind": "Component",
      "metadata": { "name": "demo-service", "namespace": "bve-demo" },
      "spec": {
        "type": "service",
        "lifecycle": "production",
        "owner": "group:bve-demo/team-demo"
      }
    }
  ],
  "entityFiles": [],
  "expected": {
    "entityRefs": ["group:bve-demo/team-demo", "component:bve-demo/demo-service"],
    "relations": [
      {
        "source": "component:bve-demo/demo-service",
        "type": "ownedBy",
        "target": "group:bve-demo/team-demo"
      }
    ],
    "absentEntityRefs": []
  }
}
```

The full baseline includes Groups, Users, Components, APIs, Systems, Domains, Resources and
Locations. Include ownership, membership, API and system relations. Keep API definitions inline
because file Locations do not support substitution placeholders such as `$text`. Use reserved test
namespaces and synthetic identities.

Reject duplicate entity identities, unsupported format versions and invalid expectation references
before loading. Reject unknown loader fields and unsafe file paths. Sort generated output
consistently and record its digest. Use the project's documented canonical JSON convention for the
input digest.

Keep expected observations separate from authored entities. Backstage adds generated metadata and
relationships, so do not compare raw stored entities byte-for-byte with the input. Compare required
fields and expected graph edges. Count generated Location entities separately from authored
entities.

Use complete JSON states for additions, changes and removals. Publish generated files atomically
within the mounted directory. Request processing through supported catalog operations for each
pinned target. Poll for the resulting entity bodies, relationships and absences with deadlines.

Declare orphan removal behavior explicitly and observe its completion. Wait for client observations
under their configured freshness rules afterward. Record catalog convergence and client cache
convergence separately. Convergence means that the observed state matches the expected state.

Initial startup and full reset require a fresh SQLite volume. Applying a replacement state exercises
actual ingestion into the current database. Applying the same state twice must produce the same
observed catalog state. Keep malformed JSON and invalid catalog inputs in separate negative loader
cases.

## 4. Shared lifecycle and local commands

The Node runner implements the following root commands. The release command runs the full process with fresh state, packaged clients, and automatic cleanup.
Use the environment guide for current command examples and qualification limits.

| Proposed command                                          | Behavior                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `npm run backstage:test:build -- --target=<target>`       | Build the locked test application image                          |
| `npm run backstage:test:up -- --target=<target>`          | Build if needed, create isolated state, start and seed Backstage |
| `npm run backstage:test:status -- --run=<id>`             | Show application, catalog and ownership status                   |
| `npm run backstage:test:seed -- --run=<id> --data=<file>` | Apply one validated JSON state and await ingestion               |
| `npm run backstage:test:reset -- --run=<id>`              | Recreate the owned database volume and restore the baseline      |
| `npm run backstage:test:down -- --run=<id>`               | Stop the owned application and preserve local state              |
| `npm run backstage:test:clean -- --run=<id>`              | Remove the owned application, volumes and credentials            |
| `npm run test:backstage:release -- --revision=<sha>`      | Run the full declared matrix and produce release evidence        |

Use one persistent SQLite volume per run and target. Configure a separate database file for each
enabled Backstage plugin. Do not point every plugin at one shared SQLite file. Make sure that each
pinned application supports the selected configuration mechanism.

The common lifecycle follows these steps:

1. Make sure that Docker, Compose, disk capacity and client prerequisites are available.
2. Resolve exact targets, source revision, package inputs and sample data.
3. Build the application with immutable dependency installation and pinned image inputs.
4. Create a unique Compose project, data volumes and temporary credentials.
5. Run the container loader to prepare catalog files from the selected JSON state.
6. Start Backstage and await its schema creation and authenticated catalog observations.
7. Run client, mutation and recovery scenarios inside the test-runner container.
8. Write reports and collect sanitized application and client logs.
9. Remove test-owned resources and record the cleanup result.

The release command builds every selected application target. Docker can reuse matching build
layers, but cached database contents are forbidden. The standalone build command does not populate a
database. The startup command creates and seeds SQLite through the application.

Use the same command on a Linux developer host and the GitHub Ubuntu runner. The host runner builds
both images and executes the same container driver commands. The test image pins its Linux base,
Node, package manager, editor libraries and Xvfb. Record actual Docker, Compose, host kernel and CPU
architecture separately. These host properties can differ even when container inputs match.

### Windows 11 development baseline

Use Docker Desktop with its WSL 2 backend and Ubuntu integration. The current machine already runs
Ubuntu 24.04 on WSL 2. Store the active checkout inside the WSL ext4 filesystem, such as
`/home/developer/code/backstage-validation-engine`. Open it through VS Code Remote WSL or the
optional Dev Container.

The original `/mnt/example-drive/code/backstage-validation-engine` checkout accesses a Windows Dev Drive through
a Windows filesystem mount. Dev Drive does not provide Linux filesystem semantics or the same
benefits for WSL access. Keep that checkout as a migration backup and optional separate Windows test
copy. Follow the [checkout transition plan](wsl-development-transition-plan.md) before switching.

The optional Dev Container uses the shared test image for interactive tools. It is separate from the
automated Linux VS Code instance under Xvfb. Launching the Windows editor through Remote WSL does
not qualify native Windows extension behavior. Existing native and remote test lanes retain their
scope.

Docker Desktop also supports optional local use on macOS. Record each host and CPU combination as
unqualified until an actual run passes. The release profile uses Linux x64 and rejects silent
architecture emulation.

### Container networking and file ownership

The client drivers use `http://backstage:7007` on the Compose network. A published loopback port
serves local browser access and optional manual clients. Do not use host `localhost` as the
automated test container's catalog endpoint. Pass explicit connection details to clients and
generated Backstage configuration.

Keep the test source at the same absolute container path locally and in Actions. The release profile
takes its source from the exact candidate revision. Editable development mounts come from the WSL
Linux filesystem. Keep container dependencies and editor state separate from host `node_modules`.

Use distinct run-owned volumes for SQLite, generated catalog files and temporary client workspaces.
Export sanitized reports to the host artifact directory. Make report ownership compatible with the
invoking Linux user. Reject missing report exports and record cleanup of every owned volume.

The host runner alone controls Docker. Do not mount the Docker socket into Backstage or the
test-runner container. Coordinate outage and restart cases through explicit driver phases. The host
stops the application, runs outage assertions, restarts it and resumes recovery assertions. This
preserves one lifecycle implementation in both environments.

Release execution rejects local overrides of required versions, cases or profiles. Exploratory runs
can select individual targets and cases, but cannot emit a release qualification verdict. Record all
effective configuration in sanitized metadata.

## 5. Authentication, readiness and state recovery

Keep Backstage authentication enabled. Generate temporary credentials for each environment and pass
tokens through environment variables or restricted generated files. Never bake credentials into the
image, JSON data, package artifacts or reports.

Use documented external caller authentication for both clients. Give the catalog reader access to
the catalog plugin. Keep test administration credentials separate from client credentials. Configure
actual Backstage authorization to exercise denied access. Do not manufacture authorization results
with an HTTP proxy.

Distinguish missing or invalid credentials from valid credentials with denied access. Record the
exact supported status codes for each pinned target. During the first application feasibility test,
establish which catalog endpoints enforce the selected permission restrictions. Unsupported denial
scenarios remain open.

An open port or successful health endpoint is only process readiness. Catalog readiness requires
authenticated reads of every expected entity and relationship. Required absences must also hold.
Inspect processing errors and fail startup when required data cannot converge.

Use bounded polling with phase-specific deadlines and cancellation. Record the last catalog
observation when a deadline expires. Do not use fixed sleeps as proof of ingestion or retry a failed
assertion. Set initial build and startup budgets from measured cold runs during implementation.
These budgets do not change existing production request limits.

Restart tests stop and start the same container with its SQLite volume intact. Make a catalog change
first, then prove that the changed state survives restart. Reset tests replace that volume and prove
that the original baseline returns. Outage tests stop Backstage, observe client failure, then
observe client recovery.

## 6. Required client scenarios

Add real-backend drivers beside the current simulated catalog drivers. The current editor tests
create their own fake server and need an explicit connection boundary for this application. Changing
an environment variable alone does not establish real-backend coverage.

Reuse existing assertions where they describe client behavior. Give the real application its own
case inventory and evidence source. Run mutation scenarios sequentially within an isolated target
environment. Restore the baseline before each independent scenario group.

| Case group                   | Required observations                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Environment                  | Cold build, schema creation, JSON ingestion, web access, authenticated reads, repeat seed, reset and cleanup                           |
| CLI valid and invalid inputs | Known valid proposal, native rejection, policy violation, malformed YAML, missing catalog reference and unsupported required processor |
| CLI packaging and reports    | Installed candidate package, JSON and SARIF findings, provenance, redaction and documented 0/1/2 exits                                 |
| Installed VSIX               | Candidate installation, startup, diagnostics, reference completion and guarded fixes                                                   |
| Editor state                 | Unsaved edits, save and watcher refresh, stale fix rejection, restart and local proposal precedence                                    |
| Catalog mutations            | Ingested additions, changed ownership, relationship updates, removals and refreshed client observations                                |
| Access and recovery          | Missing credentials, rejected credentials, actual permission denial, outage and successful recovery                                    |
| Persistence                  | Changed catalog state survives restart and disappears after a complete baseline reset                                                  |
| Client parity                | Equivalent source bytes, catalog state, policy and identity produce equivalent substantive findings                                    |
| Runner failures              | Build failure, ingestion failure, editor crash, interrupted run, missing report and cleanup failure remain visible                     |

Map expected CLI exits to the existing contract. Completed blocking violations return 1. Incomplete
work and invalid invocation inputs return 2. Assert the documented treatment of malformed source
snapshots separately from malformed YAML inside a valid snapshot. Completed allow or advisory
results return 0.

Parity compares rule IDs, entity references, source locations and coverage. Document enforcement
differences between CLI and editor modes. Exclude generated request IDs, observation times and
catalog UIDs from parity. Hold catalog mutations until both clients finish a comparison.

Use the separately installed host trust and a temporary signed policy release. Keep policy and trust
outside the proposal workspace. Record policy digests and validity so expired policy does not
masquerade as a Backstage failure. Renewal cannot change the policy semantics during a comparison.

## 7. Release-only GitHub Actions design

Add a dedicated workflow with `workflow_dispatch` for explicit release-candidate qualification.
Require an exact candidate commit and run the complete matrix. This is a pre-publication release
gate, so do not start it after publication. It has no `push`, `pull_request`, `merge_group` or
`schedule` trigger.

Dispatch at a candidate ref and require the workflow run's `head_sha` to match the requested commit.
Merely checking out an input SHA does not establish that match. Record the workflow definition
revision alongside the tested source revision.

The dedicated workflow supports `workflow_dispatch` and `workflow_call`.
The `ci.yml` manual dispatch exposes `qualify_backstage`, a boolean that defaults to false, and an exact `revision` input.
Its `backstage_release` caller requires that explicit approval and `needs: [cli]`.
The called job requires the requested revision, `GITHUB_SHA`, and checkout HEAD to match exactly.
Ordinary push and pull-request CI runs do not start the real Backstage workload.
Static controls guard the caller, exact revision check, immutable Actions pins, and sanitized upload paths without Docker.
The evidence upload uses `if: always()` so failures retain their reports.

Run on Ubuntu 24.04 x64 with Docker and Compose. Use the same test-runner image as local
development, including its virtual display. Build and test both declared Backstage targets against
both pinned editor versions. At design time those editors are 1.106.3 and 1.145.2. Use a fresh
database for each target and isolate stateful scenario groups.

Run the packaged CLI and automated Linux editor inside the test-runner container. Connect them to
Backstage through the shared Compose network. Use the existing candidate artifact retrieval logic
for the Linux VSIX. Use the candidate CLI package from the same revision and record its archive
digest. Do not rebuild a different VSIX inside this test job.

The workflow performs only these environment-specific steps:

1. Check out the exact candidate revision and provide the pinned host Node version.
2. Obtain candidate packages and make sure that their revision and digests match.
3. Invoke the shared `test:backstage:release` command to build and run both containers.
4. Upload sanitized reports and logs even when the command fails.
5. Invoke the shared cleanup operation if the main runner cannot finish cleanup.

Use immutable action references and read-only repository permissions. Keep matrix execution
independent so one failed target does not hide another. Set a job timeout after measuring cold
application builds and the full case set. Use run ownership labels so cleanup cannot remove another
local environment.

Build caches contain dependency downloads and image layers only. Their keys include target,
lockfiles, Dockerfile, base digest and application source. Never cache SQLite volumes, tokens or
populated test state. Release metadata records both cache use and the resolved image ID.

The new real-backend coverage is Linux x64 initially. The existing Windows, macOS, remote and
endurance lanes retain their declared scope. Do not report these lanes as real-backend coverage
without corresponding runs. This increment does not replace the existing two-hour release workloads.

## 8. Evidence and release gate

Each report identifies the exact candidate commit and both client package digests. Include the
supported target inventory digest, application lockfile digests, image ID, and base image digest.
Record Node, SQLite driver, and actual SQLite versions. Also record the test image digest, tool
versions, host filesystem and mount type. Record the host, editor versions, sample-data digest and
effective policy digest.

Write per-case JSON and JUnit results incrementally. Record discovered, executed, passed, failed and
unexecuted counts. Distinguish environment setup failures from client assertions. An interrupted
active case fails and remaining cases remain unexecuted. No empty suite, missing report, skipped
required case or failed cleanup can pass.

Retain sanitized build logs, Backstage logs, ingestion observations, CLI reports, editor logs,
optional failure screenshots and resource cleanup results. Raw SQLite databases can contain authentication
material and are not uploaded. Keep local credentials outside uploaded artifact paths and redact
tokens before upload.

Extend `scripts/verify-extension-qualification.mjs` to require this workflow's successful evidence
at the exact candidate revision. Make sure that every required target and editor case matches the
declared inventory. Reject evidence from different commits, packages, seed data or policy semantics.
Release publication depends on the combined qualification verdict.

Local release-profile evidence uses the same report schema and acceptance rules. Hosted evidence
additionally records workflow identity, run ID and artifact digests. Local evidence does not
substitute for the required successful GitHub run. Dirty local application or runner sources cannot
produce qualifying release evidence.

## 9. Delivery increments and acceptance

Implement these steps as separate reviewable changes. Do not mark a step qualified merely because
its files exist. Each step records measured results and remaining unavailable cases.

| Step | Work                                                | Acceptance                                                                                                                              |
| ---- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1  | WSL transition, target resolution and shared images | Both repositories retain their changes in ext4, pinned application and test images support authenticated reads and local web access     |
| 6.2  | JSON schema, renderer and ingestion observations    | Eight-kind baseline and relations converge, repeat seed is stable, malformed input fails clearly                                        |
| 6.3  | Shared build and lifecycle runner                   | One command builds both images and loads the environment, restart preserves state, reset restores baseline, cleanup removes owned state |
| 6.4  | Packaged CLI integration                            | Required valid, invalid, policy, catalog, authentication and JSON/SARIF scenarios pass                                                  |
| 6.5  | Installed VSIX integration                          | Both editors pass diagnostics, completion, fixes, edits, mutation and recovery cases against each application                           |
| 6.6  | Parity and runner failure cases                     | Equivalent findings agree and injected runner failures produce accurate failing reports                                                 |
| 6.7  | Release-only workflow and aggregate gate            | Exact candidate passes hosted cases, missing evidence blocks release, ordinary merges perform no Docker build                           |
| 6.8  | Local documentation and final qualification         | A documented clean local run and hosted run pass the same release profile for the same candidate                                        |

Final acceptance requires startup, authenticated ingestion, both clients, catalog mutations,
persistent restart, reset and cleanup on both supported applications. All required editor versions
run against both applications. Inspect the file lists for published packages. Make sure that they
exclude development infrastructure.

Record unavailable environments and unsupported scenarios explicitly. Required setup failures,
denied-access gaps or missing package evidence leave increment 6 open. A changed support matrix
requires a new explicit qualification.

## 10. Design references

Backstage documents application-specific image builds and native SQLite driver requirements in its
[Docker guide](https://backstage.io/docs/deployment/docker/). Its
[database configuration guide](https://backstage.io/docs/tutorials/configuring-plugin-databases/)
describes SQLite support and separate plugin databases.

The
[catalog configuration guide](https://backstage.io/docs/features/software-catalog/configuration/)
describes file Locations, processing intervals and orphan handling. The
[external caller authentication guide](https://backstage.io/docs/auth/service-to-service-auth/)
describes static credentials and access restrictions.

The [WSL checkout transition plan](wsl-development-transition-plan.md) records current paths, Dev
Drive considerations, preservation steps and cutover gates. Docker documents
[WSL filesystem recommendations](https://docs.docker.com/desktop/features/wsl/best-practices/).
Microsoft documents
[Dev Drive behavior with WSL](https://learn.microsoft.com/en-us/windows/dev-drive/#does-dev-drive-work-with-wsl-project-files).

GitHub documents
[workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
and
[reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
These sources support the architecture choices. Exact configuration still needs execution against
the pinned application versions during step 6.1.

## H1 release evidence corrections

The [evidence contract](release-evidence-contract.md) defines the revised failure controls and report admission.
Production target orchestration now also runs the isolated no-Docker subprocess controls.
The host retains failed build, missing report, child interruption, unfinished row, and cleanup outcomes in scratch inventories.
Native editor crash verification routes actual process failure through durable host case accounting and executes a later independent editor case.
CLI scenarios choose explicit result or error variants and bind normal provenance to fixture inputs.
Editor parity observes complete current host coverage through an opt-in read-only projection.
The revised VSIX policy uses the host-approved runtime dependency closure and rejects forbidden content at nested paths.
These controls qualify evidence rejection behavior. H4 retains the required focused real-backend acceptance work.

## Current proposal and authority evidence

`validText` and `invalidText` are inline constants in `test/integration/backstage/lib/clients.mjs`.
The constructor renders proposals into its owned `workRoot/proposals` workspace. There is no checked-in proposals directory.
It keeps signed release, trust, and launcher files outside that proposal workspace and outside upload paths.
The report retains policy/profile digests, activation time/generation, release `issuedAt`/`expiresAt`, and trust `maxAgeMs`.
Contract 0.2 policy bundles contain no validity fields. Internal evidence records `bundleValidity.present: false` for that absence.
The effective expiry is `min(release.expiresAt, release.issuedAt + trust.maxAgeMs)`.
`constructionVerification` records the constructor's actual verification time and effective expiry.
Later CLI invocations verify independently. This timestamp does not describe those later invocations or launcher-based LSP admission.

CLI authority filenames identify each phase under target `reports/authority/`. Processor fixtures use a separate suffix.
Editor reports retain one `authority.json` per session and editor version.
A later fixture cannot overwrite an earlier phase's evidence. Reports omit keys, signatures, tokens, endpoints, launcher data, and private paths.
A no-Docker control calls the actual constructor with the source engine, then inspects its signed files and retained evidence.
It proves narrowed trust age binds expiry and makes sure that later construction preserves the earlier report.
This source control is harness construction evidence. It is not actual-backend or installed-client qualification.

Screenshots are OPTIONAL DIAGNOSTICS. They have no required inventory, integrity, or step-completeness claim.
Native Trust API/state and required UI action assertions remain separate gates. Missing screenshots cannot satisfy or suppress those assertions.
The current full Backstage inventory declares 47 cases, expanded to 59 per backend and 118 across both targets.
The [inventory guide](testing-harness.md#current-evidence-boundaries) distinguishes these declarations from executed H4 and H5 scopes.

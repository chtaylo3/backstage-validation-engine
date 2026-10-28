# Architecture baseline

The accepted planning decisions, dated 2026-10-27, select one TypeScript engine on
Node 24.x. Production development starts with contract 0.2. The evaluation
prototypes use 0.1 and remain historical reference implementations.

## Runtime boundaries

The engine owns source snapshots, provenance, normalization, compatibility,
reference overlays, rule dependencies, and canonical results. A policy resolver
owns authoritative assignments, immutable baseline/additions, activation, and
bypass authority. Managed runtimes and providers own bounded execution, data
access, cancellation, and authorization-aware caching. CLI/LSP/hosted adapters
translate trusted context and presentation. A durable controller owns hosted
dispatch, recovery, activation generations, and authoritative GitHub publication.

These are logical boundaries. Start in one package and split packages when their
build, ownership, or distribution requirements justify it. Developer installation
does not require a broker, database, or central validation service.

## Fixed decisions

- Native Backstage adapters pin catalog-model 1.10.2 and 1.7.5. The initial
  compatibility surface includes Component, API, Group, User, Resource, System,
  Domain, and Location. Compatibility includes explicitly declared native
  policies, reference contexts, local substitutions, admission, custom schemas,
  and proposed-state overlays. Full organization ingestion is not inferred from
  stock schema validation.
- CEL uses `bve-cel/1`: CEL-JS 8.0.0 with RE2JS 2.9.0 in supervised, replaceable
  workers. Two shared workers, 64 outstanding jobs, a 100 ms evaluation deadline,
  and a five-second whole-request deadline are initial ceilings. Both selectors
  and expressions must use the managed path. Go remains reference evidence.
- JSON-compatible YAML preserves missing/null and authored source positions.
  Parsing rejects duplicate keys, unsafe integers, and merge keys; aliases,
  depth, expansion, and source size are bounded. Custom schemas use draft-07,
  bundled refs, no network ref loading, no coercion, and no default mutation.
- Required unsupported processors or unavailable data produce incomplete
  coverage and block CI. A timeout is an incomplete execution. A false rule is a
  violation. An invalid rule is a policy configuration error.
- Centrally mandatory policies and limits cannot be weakened by repository
  additions. Repository metadata is a hint rather than assignment authority.
- Early emergency bypass follows trusted identity resolution and precedes parsing
  and expensive providers. Exactly one verified Git bundle bypass provider is
  planned per installation. Routine exceptions apply after rule execution.
- Hosted run identity binds installation/repository, target SHA, activation
  digest, and generation. Stale completion must not restore approval. The pilot
  targets publication reconciliation within 60 seconds of authoritative changes.
- The small hosted pilot uses persistent SQLite WAL with one controller writer,
  a durable inbox/outbox, deduplication, leases, and restart reconciliation.
  Direct and central Actions backends share the execution contract. Application
  repositories need no workflow file for central Actions.
- Arbitrary untrusted plugins remain disabled until process/container isolation
  passes filesystem, network, credentials, CPU, and memory denial tests. Worker
  threads are not an operating-system sandbox.

## Pipeline

Trusted identity → early emergency bypass → pin activation/source/policy/profile/
data → discover and parse → resolve substitutions → native policies and admission
→ proposed catalog overlay → rules and bounded providers → routine exceptions
→ coverage and enforcement → publication freshness check.

Preserve authored and effective entities with provenance between them. Invalid
replacement entities and deletion tombstones must mask older catalog entries.
Required unavailable transformations block dependent stages; avoid speculative
errors about data that should have been transformed.

## Implemented parsing boundary

The [source parser](parsing.md) consumes verified immutable snapshots and returns
frozen JSON documents, authored/alias location provenance, redacted diagnostics,
and per-file parse coverage. It uses a lazy-loaded YAML 1.2 lexer/parser/composer,
an iterative syntax guard, bounded JSON expansion and cooperative request budgets.
CI excludes an invalid file's entities; IDE mode retains unaffected documents.
Neither mode exposes an invalid document as a validated entity.

This stage precedes native Backstage checks. An excluded invalid source must later
produce an invalid-replacement marker in catalog overlays, preventing fallback to
an older entity. Passing parse coverage does not imply completed compatibility,
substitution, admission, policy, or hosted-authority coverage.

## Release breadth

The pilot prioritizes engine/CLI, VS Code, a GitHub App, direct execution, and
central Actions. Stable release retains JetBrains, Kafka, SQS, governed
programmable plugins, and operational/support matrices. Visual Studio is optional.
Installation access, organization processors, supported IDE/OS/GHES versions,
representative workload sizes, and staffing still need concrete qualification.

# Pinned catalog behavior controls

These tables define independent expected values for H4. The two supported backend targets are Backstage 1.55.3 and 1.56.3.
`sources.json` records source commits, URLs, and SHA-256 digests. The source texts come from the locked backend packages' source maps.
The `.ts.txt` suffix keeps upstream source out of the repository TypeScript build. `LICENSE.upstream` retains the upstream Apache 2.0 license.

`substitutions.json` defines input bytes and separate upstream and local expected results. Both upstream processors reject non-string targets.
The local snapshot profile deliberately rejects mixed mappings, duplicate JSON keys, empty YAML, and unsafe numbers.
It recursively resolves returned placeholders. Upstream leaves mixed mappings and returned placeholders alone.

`references.json` defines complete expected processor relation tuples and separate expected local reference lists.
The upstream processor scopes relations by entity kind and emits inverse edges. The default local profile selects paths across kinds.
For example, a User with `spec.owner` produces a local owner reference but no upstream ownership relation.
This over-approximation remains deliberate. Local references do not promise backend graph parity.

`seed-graphs.json` contains independently authored graph expectations for the baseline and mutation seeds.
It includes ownership, membership, API, component/resource System, and System-Domain edges in both directions.
Seed tests compare complete tuples with this file. Actual backend runs compare the graph after normal catalog ingestion.
Generated location edges remain outside the declared graph. Required absent edges are declared separately in each seed.

Run `node scripts/test-h4-backends.mjs --cli <archive>` after creating a clean candidate archive.
The command compares the upstream tables against both actual pinned processors and exercises both actual catalog backends.
It retains reports under `.artifacts/harness-remediation/H4/backends` and removes only its owned containers and SQLite volumes.
It does not start an editor or perform the deferred release qualification.

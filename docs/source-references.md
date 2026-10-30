# Source references and catalog preparation

Implemented 2026-10-29. BC-03 resolves the deployment profile's declared reference
contexts through both exact native adapters. The source-to-provider API collects
external observations and pins them for later evaluation. Existence enforcement
belongs to explicit organization rules.

## Native contexts and provenance

`validateBackstageSources` runs parsing, native checks and reference extraction.
The default profile declares owner → Group, provides/consumes API → API and system
→ System. Their namespace fallback is the source entity's namespace, matching the
qualified backend's [built-in processor](https://github.com/backstage/backstage/blob/1e85ac7e08f276f49604202fd7245e0ad0aa63af/plugins/catalog-backend/src/processors/BuiltinKindsEntityProcessor.ts).
Explicit kind/namespace components override defaults. A profile namespace value
of `entity` selects entity context; other strings select fixed namespaces. See
[Backstage reference syntax](https://backstage.io/docs/features/software-catalog/references/).

Paths are escaped JSON Pointers with array-only `*` segments. Missing optional
fields and empty arrays are completed work. Present shape/native-reference errors
produce source-attributed findings and withhold the subject from accepted entities.
Overlapping patterns, including scalar ancestors/descendants, are configuration
errors. Defaults and compound identities must serialize without tuple ambiguity.

Initial ceilings are 256 contexts, 64 segments, 4,096 path characters, 1,000
occurrences/shape failures and 100,000 visits per source run. Traversal yields and
shares the original deadline/signal. Exhaustion produces blocked coverage and
resource interruption. Completed invalid checks retain findings/verified coverage.

Canonical targets remain separate from effective field values. `references` retain
context paths, logical entity paths, source digests, buffer versions, UTF-16
locations and alias/inclusion-related locations. Included values retain the actual
payload's provenance; policy IDs use logical entity paths. Defaults retain
nearest-authored locations and native mutation provenance.
`sourceClaims` retain identities even for invalid/blocked documents;
`unresolvedSourceIdentities` records incomplete identity coverage.

## Preparing data

`prepareBackstageReferenceData(request, context, { provider, access, signal? })`:

1. Verifies request/artifact bindings and matches provider adapter, installation,
   permission revision and policy/profile digests before HTTP.
2. Runs source processing from the supplied snapshot's entrypoints (all files when
   omitted), resolves declared local inclusions and deduplicates
   canonical targets while preserving individual authored occurrences.
3. Applies local guards, then collects eligible external targets under the original
   deadline and verifies exact target set, connection, principal and scope provenance.
4. Replaces previous catalog rows for the selected connection, preserving other
   data. Conflicting retained keys are rejected. Blocked targets cannot reuse old
   catalog observations through the input request.
5. Pins `evaluationRequest` with combined data, original source/run/artifact
   identities and the **same original deadline**. Its `startedAt` marks data
   pinning; `collectionStartedAt` preserves the input operation start.

Observations contain `present`, `missing`, `unavailable` data entries or a `blocked`
record/reason. Absence alone creates no compatibility finding. This API prepares
data; consumers propagate interruption and map required dependencies into policy
coverage. A prepared request is a data pin, not a completed validation verdict.

Deadline/cancellation, stale retained data or combined snapshot/request exhaustion
omit the evaluation request and set `pinFailure` plus typed interruption. Pinning
never grants another five-second budget, and input snapshots remain immutable.

## Conservative proposed-state guards

Qualified overlays remain BC-06 work. Current guards:

- Known local identities, including invalid replacements, block external fallback.
  Multiple claims produce `competing_claims`. Locally valid targets also stay
  blocked until admission/overlay qualification.
- Unknown identities, malformed/incomplete sources and unresolved substitutions
  conservatively block fallback. An invalid known identity can be masked while
  unrelated external targets remain eligible.
- Deletions block lookup because current tombstones lack prior identities.
  Baseline-aware deletion/rename handling remains overlay work.

Guards return blocked observations instead of inventing missing-reference violations.
They do not qualify positive local overlays, deletion or conflict behavior. The host
supplies the complete proposed snapshot. [Snapshot-local discovery and
substitutions](substitutions.md) are implemented; additional processor outputs
retain their own qualification gates.

## Development and next work

```bash
npm run fixtures:serve -- 1.56
# In another terminal, replace PORT with the printed numeric port:
npm run example:references -- http://127.0.0.1:PORT/api/catalog
npm run test:harness
```

The example uses synthetic authority and the development fixture token. It prints
source occurrences, one present owner and one missing API, plus original/evaluation
deadlines, without an enforcement verdict.

Tests cover both native pins against both fixtures, namespaces/case, escaped paths,
arrays, aliases/defaults, resource bounds, invalid/unknown/deleted/competing claims,
authorization binding, unavailable data, cancellation, stale retained data and
overlapping buffer versions. [Catalog rules and the LSP](lsp.md) now consume these
pins and suppress superseded editor generations. BC-05/BC-06 and real
backend/IDE qualification remain open.

Local qualification on 2026-10-29: 31 new reference/preparation checks passed;
`npm run check` passed all 387 tests. The source-reference example passed against
the standalone 1.56 fixture with one present and one missing target and an
unchanged deadline. The updated native/CEL example also passed.

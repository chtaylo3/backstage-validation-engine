# Proposed catalog overlays

BC-06 qualifies the proposed catalog view before explicit reference-existence
rules collect external data. Current entities must pass parsing, supported
substitutions, native policies/kind or pinned custom-schema validation, admission
and declared reference checks. Both native model pins and pinned API fixtures are
covered by local acceptance tests.

## Pinning a baseline

Requests accept optional `baseline`, an immutable `source-snapshot` of the previous
repository view. It must have no change records and must use the proposed
snapshot's repository/root. Both snapshots retain their exact bytes, revisions,
catalog entrypoints, digests and buffer versions. The host supplies these snapshots;
no filesystem or Git reader runs during qualification.

```js
const baseline = createSourceSnapshot({
  repository: 'repository',
  revision: 'before',
  files: [{ uri: 'file:///workspace/team.yaml', text: oldTeamText }],
});
const source = overlaySourceSnapshot(baseline, [
  { uri: 'file:///workspace/team.yaml', deleted: true },
  { uri: 'file:///workspace/platform.yaml', text: newTeamText },
]);
const request = parseContract('validation-request', {
  ...pinnedRequest,
  source,
  baseline,
});
```

With a baseline, membership and content differences require coherent explicit
addition/modification/deletion records. A rename is a deletion plus an addition;
an identity rename inside one file is a modification. Missing or contradictory
records and cross-repository/root baselines are contract errors before collection.
Baseline and proposed raw bytes share the assigned request budget. Each source
pass retains parser/entity limits, and both use the original deadline/signal.

The baseline is processed through the same pinned profile to recover previous
identity claims and Location-discovered documents. Its findings describe previous
input and are not added to current findings. Interrupted or unknown baseline
identity/discovery coverage blocks fallback where removals cannot be qualified.
The baseline report is retained in `ReferenceDataPreparation.baseline`.

Results include optional `provenance.baselineDigest`. Catalog rule bindings include
that digest in their request comparison, so a different baseline cannot reuse a
prepared result. Producers using these optional pre-release 0.2 fields require
the updated schemas/consumers.

## Overlay decisions

| Proposed evidence                                                                | Reference observation                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| One qualified current identity                                                   | Source-derived `present`, before any catalog lookup     |
| Multiple current claims for the same canonical identity                          | Conflict findings and blocked observation               |
| A known current identity failing validation/admission                            | Blocked observation; old catalog copies are masked      |
| A known previous identity removed from valid proposed input                      | Source-derived `missing`; old catalog copies are masked |
| A previous identity replaced by invalid input                                    | Blocked observation rather than guessed absence         |
| No local claim/removal and complete relevant coverage                            | Eligible for the pinned catalog provider                |
| Unknown current identity, incomplete required transformation or interrupted work | Incomplete dependency coverage                          |

Local additions work without a configured catalog connection. Missing baselines
still permit qualified current targets; modifications/deletions without previous
identity coverage conservatively block fallback for unclaimed targets. Unknown
current identities can compete with any target and therefore block qualification.

File moves preserving identity keep references valid. Identity renames mask the
old identity and expose the validated new one. Empty-file replacement and removal
of a valid Location target can remove prior identities. Multi-document reordering
is compared by canonical identity rather than document position. Invalid Location
discovery cannot establish that previously discovered entities are absent.

Competing claims include valid/invalid documents and multiple documents in one
file. Comparison uses native canonical identities, preserving namespace
distinctions. Conflicts are reported even when no existence rule references them.
Conflicted entities and children discovered through conflicting Locations are
withheld from accepted artifacts, references and rule subjects. Findings point to
the metadata and representative competing locations. Conflict diagnostics are
bounded to 64, with up to 16 peer locations per finding; exhaustion records
explicit resource interruption and blocked coverage.

## Data and integrity

Qualified local facts are pinned as ordinary data entries with provider ID
`backstage-proposed-catalog`, connection/principal `source-snapshot`, and scope
`catalog:proposed`. They describe repository source qualification rather than
backend visibility. `proposedCatalogEntityKey` supplies their separate key space.
Their revision hashes proposed-source, baseline and profile digests. Present
values are the accepted normalized entities; removed identities have missing
entries. Source-derived facts expire at collection start plus 60 seconds and
participate in publication freshness limits.

Reference preparation replaces previous source-derived entries and observations
for the selected backend connection, preserving unrelated provider data. Provider
calls contain only targets still eligible after overlay decisions. Backend denial,
outage and timeout retain unavailable/incomplete semantics and never manufacture
missing-reference violations.

Policy binding re-derives the proposed view from qualified source reports and
checks local observations against the exact pinned data. A repinned counterfeit
local fact or backend observation cannot override a source tombstone/conflict.
Whole-request run, source, baseline, policy/profile and data bindings still apply.
Use preparation returned by the production API; host signatures and authoritative
snapshot assignment remain separate responsibilities.

## Editor lifecycle

The stdio LSP uses its unchanged launcher snapshot as the default baseline, or an
explicit trusted `baseline` when the launcher source already represents a proposal.
Current open buffers qualify additions and replacements. Closing a buffer restores
the current pinned workspace bytes. Every edit invalidates dependent results;
epochs and cancellation suppress superseded remote lookups.

Standard `workspace/didDeleteFiles` and `workspace/didRenameFiles` notifications
update the pinned workspace view without disk reads. Known file renames preserve
available bytes and explicit entrypoints; deletions create baseline-relative
tombstones. Cleared open documents receive empty diagnostics. Operations are
bounded to 1,000 files and must use canonical file URIs inside a configured root.
Unknown rename bytes, unsynchronized moved buffers, overwrites, directory
operations and malformed/out-of-budget changes invalidate validation until restart
with a refreshed trusted snapshot. Arbitrary saved-file discovery/refresh remains
host work.

## Examples and acceptance

```bash
npm run example:overlay
# Confirmed deletion demonstrates a completed violation and exits with code 1:
npm run example:overlay -- --deleted
```

The [runnable example](../examples/validate-overlay.mjs) uses synthetic authority
and qualifies source facts without a backend. [Overlay acceptance tests](../test/backstage-overlays.test.ts)
cover additions, replacements, admission/custom schemas, delete/rename,
multi-document and Location changes, conflicts, provenance, tampering, resource
bounds and cancellation. [Stdio tests](../test/lsp.test.ts) cover editor operations
on both model/API pins. Actual deployed backend/editor/OS runs, host filesystem
capture/refresh and complete deployment processor qualification remain open.

Local qualification on 2026-11-03: all 32 overlay checks and nine added LSP checks
passed against the pinned model/API fixtures. The full `npm run check` passed
593 tests and required static/schema/build checks. The built example returned
allow/exit 0 for a local addition and completed block/exit 1 for a baseline deletion.

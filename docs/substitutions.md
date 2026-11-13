# Snapshot-local substitutions and Locations

A substitution replaces a marker with content from another file in the snapshot. BC-04 resolves
`$text`, `$json`, `$yaml`, and file Location targets from the exact immutable proposed snapshot
before native validation. Both native catalog-model pins are supported. Resolution reads no live
filesystem, environment, or network data.

## Pinning sources

Supply `rootUri` and `entrypoints` to `createSourceSnapshot`:

```js
const source = createSourceSnapshot({
  repository: 'repository',
  revision: 'immutable-revision',
  rootUri: 'file:///workspace/',
  entrypoints: ['file:///workspace/catalog-info.yaml'],
  files: [
    {
      uri: 'file:///workspace/catalog-info.yaml',
      text: `apiVersion: backstage.io/v1alpha1
kind: Component
metadata: {name: service}
spec: {$yaml: ./parts/spec.yaml}
`,
    },
    {
      uri: 'file:///workspace/parts/spec.yaml',
      text: 'type: service\nlifecycle: production\nowner: team\n',
    },
  ],
});
```

The deployment profile must declare the `snapshot-local` reader. The default profile already does.
`rootUri` is a canonical local file directory URI with a trailing slash. All files and change
records must have canonical contained URIs.

Root and entrypoints contribute to the source digest. Overlays preserve them and remove deleted
entrypoints. Without `entrypoints`, every supplied file remains a catalog input for compatibility
with existing callers. With entrypoints, other files are payloads until reached through a Location
target. The lower-level `validateBackstageSources` option `uris` can explicitly override
entrypoints.

Entrypoints must exist in the effective snapshot. Hosts supply the complete snapshot, including
open-buffer replacements and deletion records. Saved-file refresh and filesystem discovery remain
host work.

## Resolution and provenance

A placeholder is a mapping containing exactly one supported marker and a nonempty path string.
`$text` inserts exact text, including line endings. `$json` requires valid JSON and then applies the
source parser's duplicate-key and safe-value checks. `$yaml` requires exactly one nonempty
JSON-compatible YAML 1.2 document. Structured payloads can contain nested substitutions.
Duplicate/merge keys, unsupported tags, unsafe numbers and malformed or multiple documents are
rejected.

Relative paths resolve from the file containing the marker, including markers inside nested
payloads. Paths can select a parent directory within the pinned root. Absolute paths, drive/UNC
forms, backslashes, percent escapes, queries, fragments and root escapes cannot select a file.
Schemed targets require an unavailable reader and retain incomplete coverage.

Resolution reads pinned bytes. It cannot follow a live disk symlink or silently load an absent file.
Hosts that build snapshots from disk must enforce their filesystem/symlink policy at capture.

Accepted entities retain separate `authored`, `resolved` and `normalized` values. `substitutions`
records each logical entity path, marker, inclusion origin and target URI/digest/version. Artifacts
include substitution and native normalization provenance. Included field locations use the payload's
actual pointer and UTF-16 range, with the use chain in related locations. References retain both
their logical `entityPath` and actual source location/digest/version. Stable policy finding IDs use
logical paths so repeated imports remain distinct.

## File Locations

A validated Location with `spec.type: file` discovers `spec.target`, `spec.targets`, or both,
relative to the containing source. An omitted type uses the local file reader, including nested
Locations. Targets can contain multiple entity documents. The resolver processes shared files once.
It rejects graph cycles and excessive depth. URL types and glob targets retain
unsupported/incomplete coverage.

`spec.presence: optional` permits an absent target. Required missing targets are violations. An
existing malformed target remains invalid even when optional. Included parse findings retain their
Location use chain. Unresolved discovery conservatively blocks catalog fallback.
[BC-06 overlays](proposed-overlays.md) now qualify local entities and mask identities removed
through valid Location changes.

## Bounds and results

Resolution shares the original request deadline and cancellation signal, with cooperative yields.
Profile limits bound raw file/request bytes, expanded entity bytes, aggregate expanded output,
entity documents and inclusion depth. Additional ceilings are 1,000 substitutions, 100,000 traversal
visits and structural depth 64. The resolver caches parsed payloads within one request. Every use
still counts toward the output expansion limit. These are cooperative limits, without process
CPU/RSS confinement.

Malformed placeholders/payloads, unsafe paths, cycles and missing required files produce completed
violation findings, with dependent native checks withheld. Undeclared roots/readers, remote readers
and patterns produce required incomplete coverage. Resource exhaustion, timeout and cancellation
also remain incomplete. CI aggregation distinguishes violations (exit 1) from incomplete work (exit
2). Required unavailable processors still block native work before substitutions.

The [substitution tests](../test/engine/backstage-substitutions.test.ts) cover both native pins, nested
ranges, malformed data, cycles, path escapes, disk/symlink isolation, resource limits, Locations,
catalog rules and cancellation. The [stdio tests](../test/lsp/lsp.test.ts) exercise included-buffer
revalidation, projected diagnostics, repair, close restoration and stale HTTP suppression against
the pinned fake APIs. Actual editor/backend and filesystem-capture qualification remain open.

Local qualification on 2026-10-29: all 56 substitution checks and five added LSP checks passed. The
complete `npm run check` passed all 485 tests and required static, build, and schema checks. These
runs used loopback access for the fake APIs.

## Deliberate upstream differences

The [fixed behavior table](../test/fixtures/backstage-behavior/substitutions.json) separates local and upstream expected results.
Its [source manifest](../test/fixtures/backstage-behavior/sources.json) binds both pinned processor versions and published notices.
Both upstream versions reject non-string resolver targets. Both reject empty or multiple YAML documents.

Upstream leaves mixed mappings and mappings with multiple markers unchanged. The local profile rejects them as `invalid_substitution`.
Upstream does not recursively process placeholders returned by a resolver. The local profile resolves them within the original snapshot budgets.
Upstream JSON parsing keeps the last duplicate key. Upstream YAML parsing permits rounded unsafe numbers.
The local parser rejects duplicate keys and unsafe numbers as `invalid_inclusion`. These are deliberate safe-profile choices.

The focused backend command executes each upstream table case on both locked processor implementations.
Source tests execute the separate local expectations with both native model adapters.
These controls cover the declared table. They do not qualify unrestricted readers or arbitrary deployment processors.

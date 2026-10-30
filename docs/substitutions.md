# Snapshot-local substitutions and Locations

BC-04 resolves `$text`, `$json`, `$yaml` and file Location targets from the exact
immutable proposed snapshot before native validation. Both native catalog-model
pins are supported. No filesystem, environment or network reader runs during
resolution.

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

The deployment profile must declare the `snapshot-local` reader. The default
profile already does. `rootUri` is a canonical local file directory URI with a
trailing slash. All files and change records must have canonical contained URIs.
Root and entrypoints participate in the source digest; overlays preserve them
and remove deleted entrypoints. Without `entrypoints`, every supplied file remains
a catalog input for compatibility with existing callers. With entrypoints, other
files are payloads until reached through a Location target. The lower-level
`validateBackstageSources` option `uris` can explicitly override entrypoints.

Entrypoints must exist in the effective snapshot. Hosts supply the complete
snapshot, including open-buffer replacements and deletion records. Saved-file
refresh and filesystem discovery remain host work.

## Resolution and provenance

A placeholder is a mapping containing exactly one supported marker and a nonempty
path string. `$text` inserts exact text, including line endings. `$json` requires
valid JSON and then applies the source parser's duplicate-key and safe-value
checks. `$yaml` requires exactly one nonempty JSON-compatible YAML 1.2 document.
Structured payloads can contain nested substitutions. Duplicate/merge keys,
unsupported tags, unsafe numbers and malformed or multiple documents are rejected.

Relative paths resolve from the file containing the marker, including markers
inside nested payloads. Paths may move to a parent directory within the pinned
root. Absolute paths, drive/UNC forms, backslashes, percent escapes, queries,
fragments and root escapes cannot select a file. Schemed targets require an
unavailable reader and retain incomplete coverage. Resolution reads pinned bytes;
it cannot follow a live disk symlink or silently load an absent file. Hosts that
build snapshots from disk must enforce their filesystem/symlink policy at capture.

Accepted entities retain separate `authored`, `resolved` and `normalized` values.
`substitutions` records each logical entity path, marker, inclusion origin and
target URI/digest/version. Artifacts include substitution and native normalization
provenance. Included field locations use the payload's actual pointer and UTF-16
range, with the use chain in related locations. References retain both their
logical `entityPath` and actual source location/digest/version. Stable policy
finding IDs use logical paths so repeated imports remain distinct.

## File Locations

A validated Location with `spec.type: file` discovers `spec.target` and/or
`spec.targets` relative to the containing source. An omitted type uses the local
file reader, including nested Locations. Targets can contain multiple entity
documents. Shared files are processed once; graph cycles and excessive depth are
rejected. URL types and glob targets retain unsupported/incomplete coverage.

`spec.presence: optional` permits an absent target. Required missing targets are
violations. An existing malformed target remains invalid even when optional.
Included parse findings retain their Location use chain. Unresolved discovery
conservatively blocks catalog fallback; positive local overlays remain BC-06 work.

## Bounds and results

Resolution shares the original request deadline and cancellation signal, with
cooperative yields. Profile limits bound raw file/request bytes, expanded entity
bytes, aggregate expanded output, entity documents and inclusion depth. Additional
ceilings are 1,000 substitutions, 100,000 traversal visits and structural depth 64.
Parsed payloads are cached within one request; output expansion is still charged
for every use. These are cooperative limits, without process CPU/RSS confinement.

Malformed placeholders/payloads, unsafe paths, cycles and missing required files
produce completed violation findings, with dependent native checks withheld.
Undeclared roots/readers, remote readers and patterns produce required incomplete
coverage. Resource exhaustion, timeout and cancellation also remain incomplete.
CI aggregation distinguishes violations (exit 1) from incomplete work (exit 2).
Required unavailable processors still block native work before substitutions.

The [substitution tests](../test/backstage-substitutions.test.ts) cover both native
pins, nested ranges, malformed data, cycles, path escapes, disk/symlink isolation,
resource limits, Locations, catalog rules and cancellation. The
[stdio tests](../test/lsp.test.ts) exercise included-buffer revalidation, projected
diagnostics, repair, close restoration and stale HTTP suppression against the
pinned fake APIs. Actual editor/backend and filesystem-capture qualification
remain open.

Local qualification on 2026-10-29: all 56 substitution checks and five added LSP
checks passed; the complete `npm run check` passed all 485 tests and required
static/build/schema checks. These runs used loopback access for the fake APIs.

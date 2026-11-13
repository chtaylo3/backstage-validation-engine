# Independent conformance inputs

`upstream-manifest.json` pins each upstream input with its origin, license, and SHA-256.
The tests compare those digests before they execute conformance cases.
The original files remain unformatted. Normal source tests run offline.

The draft-07 inputs come from the official JSON Schema Test Suite at commit
`245a45abc90190c0bff04d97e6d2b541b4bb9f12`. `draft7/LICENSE` retains its MIT license.
The [upstream suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) defines each expected `valid` flag.
The tests retain every case in each curated group. They never compute expected flags from BVE.

The selection uses group zero in each feature file, with two explicit replacements.
`if-then-else.json` uses group five, which contains both branches.
`ref.json` uses group one, which uses a local JSON Pointer.
The first `definitions.json` group requires external metaschema retrieval and receives an exclusion control.
The manifest also records excluded lone `if` and recursive root-reference groups.
The tests separately reject these schemas through normal safe-schema admission.
Full upstream files remain available for provenance. Unselected groups receive no conformance claim.

BVE supports synchronous draft-07 under the existing safe-schema restrictions.
Remote/cyclic references, nested identifier scopes, formats, async/newer reference constructs,
unknown keywords, and unsupported RE2 features remain excluded.
Strict Ajv admission also rejects an ignored `if` without `then` or `else`.
That stricter admission is a configuration rejection, not a changed official expected value.

The OASIS 2.1.0 Errata 01 schema remains unmodified.
`SARIF-NOTICE.txt` retains publication attribution.
`SARIF-PUBLISHED-NOTICES.txt` retains the complete published Notices section, with whitespace normalized only. `SARIF-LICENSE.upstream` retains OASIS IPR links.
Tests use pinned test-only `ajv-draft-04` and `ajv-formats` with full format validation.
The schema contains a legacy regex, so the validator uses `unicodeRegExp: false`.
URI, URI-reference, and date-time failures receive separate negative controls.
Production schema admission remains the existing safe draft-07 engine.

`independent-vectors.json` records YAML/RFC origins, notices, and the RFC 8032 signature bytes.
The YAML inputs in `independent-conformance.test.ts` follow the
[YAML 1.2.2 core table](https://yaml.org/spec/1.2.2/#1032-tag-resolution).
They cover explicit JSON-compatible tags, the directive, alias keys, and deliberate JSON restrictions.
These short authored inputs use the repository Apache-2.0 license. The YAML specification is not copied.
The [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) sorting and numeric strings remain fixed test literals.
Unsafe integral doubles stay excluded by the existing BVE profile.
The [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html#section-7.1) signature uses the published empty-message vector.
The tests also verify release signatures with `node:crypto` over a separately authored canonicalizer.
The RFC metadata retains IETF attribution and BCP 78 license links.

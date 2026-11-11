# Source-preserving parsing

Status: implemented and locally tested, 2026-10-28. This historical increment follows the foundation
and managed CEL increments. It supplies authored documents and source locations for the native
Backstage adapters described in later increments.

## Acceptance register

| ID       | Required behavior                                                                                                                                                    | Status         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| PARSE-01 | Immutable multi-file and multi-document YAML 1.2 with source revision, file digest, buffer version and original document ordinal                                     | Passed locally |
| PARSE-02 | JSON-compatible values. Missing/null distinction, safe integers, finite doubles, string-only map keys. Reject duplicate and merge keys and unsupported tags/versions | Passed locally |
| PARSE-03 | UTF-16 end-exclusive ranges for root, keys, values, arrays and escaped JSON Pointer paths, including CRLF and supplementary Unicode                                  | Passed locally |
| PARSE-04 | Bound source size, syntax depth/nodes/documents, alias count/cycles, expanded values and bytes. Never silently truncate                                              | Passed locally |
| PARSE-05 | Strict CI withholding of invalid files and IDE recovery of unaffected documents, with invalid content explicitly excluded from validation                            | Passed locally |
| PARSE-06 | Propagate request cancellation/deadline, yield between bounded parsing steps, and report mandatory incomplete coverage for interrupted/resource-limited work         | Passed locally |

Passing parsing does not attest native Backstage compatibility, resolve source substitutions,
authorize admission, or execute organization policy. This parsing increment alone does not complete
BC-01 through BC-07. Each case requires its corresponding pipeline stage.

The [48 parser acceptance checks](../test/parsing.test.ts) exercise this register. The parsing
increment brought the local suite to 138 checks, including contracts and managed CEL qualification.
Subsequent totals are tracked in the [implementation status](implementation-status.md). Native
IDE/OS and hosted scale qualification remain release work.

## API and source ownership

`parseSourceSnapshot(snapshot, options)` parses immutable files already supplied by discovery. The
optional `uris` selection must identify existing files exactly, without duplicates. Without a
selection, the parser processes all snapshot files. An empty selection performs no source work. The
parser performs no discovery, filesystem, network, credential, or substitution access. Deletions are
already absent from the effective source snapshot.

Pass the request's original `deadlineAt`, `signal`, and `ci`/`ide` mode. Trusted profile or process
code can lower `PARSING_LIMITS`. File/request byte and document limits can be lowered to match the
assigned deployment profile. Repository policy cannot raise ceilings. Invalid configuration or
snapshot integrity causes a configuration or contract error. Invalid YAML produces diagnostics in
the report.

Reports are deeply frozen and contain the snapshot digest, per-file status, validated JSON
documents, diagnostics, parse-stage coverage, and interruption state. Each document retains URI,
original document ordinal, file digest, optional buffer version, and a JSON Pointer location index.
The source revision and exact authored text remain available through the pinned source snapshot. No
YAML AST or mutable library object escapes this boundary.

The syntax library is loaded lazily on the parsing path. The implementation uses the public Lexer,
Parser, Composer, and AST APIs of pinned `yaml` 2.9.1. An iterative CST guard checks depth and node
counts before recursive AST composition. A linear map pass checks duplicate keys. The library's
quadratic duplicate comparison is disabled. See the
[upstream API reference](https://eemeli.org/yaml/).

## JSON normalization and provenance

Core YAML 1.2 scalars become JSON strings, booleans, null and numbers. Integer tokens are initially
parsed as BigInt so unsafe literals are rejected before rounding. Accepted integers become doubles,
matching the managed CEL input model. Non-finite numbers, unsafe integral doubles, non-string keys,
unknown/non-JSON tags, and YAML 1.1 are rejected. All `<<` keys, including quoted keys, are outside
this initial profile. Dates remain strings unless explicitly tagged, in which case unsupported
timestamp tags are rejected.

Blank/comment-only documents are counted as empty and omitted from the entity document list.
Explicit `null`, scalar, and list documents remain as JSON. The native adapter later determines
whether they are valid entity envelopes. Missing map fields remain absent. Empty mapping values
become explicit null.

Aliases resolve to the last preceding anchor in the same document. Expansion produces detached JSON
values with no cycles or shared mutable objects. Missing anchors and cycles are input violations.
Exceeded expansion limits are resource failures. Alias keys are rejected because mapping keys must
be authored string scalars.

`locateParsedPath(document, pointer, kind)` returns an end-exclusive UTF-16 source location for a
value or key. Keys with a slash or tilde use RFC 6901 escaping. Array indices are path components.
An absent field keeps its requested pointer while its range falls back to the nearest existing
ancestor. CRLF, LF, CR, supplementary Unicode and EOF are indexed directly from authored UTF-16
offsets.

Alias-derived paths point to the alias use and include a related location for the authored anchor
value. `NodeSourceSpan.origin` distinguishes direct and derived data. A derived field range does not
instruct an edit provider to replace an anchor or alias. Future edit providers must consider the
source history and enforce file digest and buffer version preconditions.

## Recovery and enforcement

In CI mode, any input error withholds every document from that file. Other valid files remain
available. In IDE mode, valid documents in the same file remain available with their original
document numbers. Invalid documents never enter validation. This is document-level recovery. Partial
entities from malformed documents and editor completion over recovery ASTs are not exposed yet.

Completed parsing of invalid input has verified parse coverage and blocking input findings in CI.
The parser completed its check and found a violation. The file remains invalid. Resource limits and
cancellation/deadlines produce blocked mandatory coverage and typed incomplete execution.

They stop further source work. Pending documents without a completed conversion are not promoted to
validated entities. Diagnostic quota exhaustion explicitly records a resource failure instead of
silently discarding remaining errors.

`parsingFindings(request, report)` binds diagnostics to the request's source/mode and policy/profile
digests. It creates stable `yaml/*` finding identities and coalesces repeated IDs with related
locations. Diagnostic messages omit parser exception text and source values. The future engine
aggregates these findings and coverage with native compatibility, substitution, admission and rule
stages.

## Resource ceilings

| Resource                                              |   Default ceiling |
| ----------------------------------------------------- | ----------------: |
| Selected files / documents, including empty documents |     1,000 / 1,000 |
| Raw UTF-8 per file / selected source                  |    1 MiB / 16 MiB |
| Syntax/JSON depth                                     |                64 |
| Aggregate syntax nodes / lexical tokens               | 100,000 / 200,000 |
| Aggregate expanded JSON values                        |           100,000 |
| Alias expansion visits per document                   |                50 |
| Expanded canonical JSON per document / request        |    1 MiB / 16 MiB |
| Reported diagnostics                                  |             1,000 |

Budget checks run throughout lexing, syntax checks, and JSON conversion. The parser yields to the
event loop every 128 steps or after eight milliseconds of work. It shares the request deadline
through `RequestBudget`. Library composition and individual bounded lexing or conversion operations
run synchronously between checkpoints.

Cancellation takes effect at checkpoints. It does not preempt an operation through the operating
system. This boundary does not establish hosted CPU or RSS containment or a hard latency guarantee
for each operation.

## Run the example

```bash
npm run example:parse
```

The example emits a parsed catalog fixture, its captured buffer version, a precise `/metadata/name`
location, and parse coverage. It does not claim the complete Backstage validation pipeline ran.

## Independent specification and default boundary controls

The [independent vectors](../test/fixtures/conformance/README.md) cite the YAML 1.2.2 core-schema table.
The tests exercise all seven explicit JSON-compatible tags and the `%YAML 1.2` directive.
Authored alias keys remain excluded. Non-finite scalars and timestamp tags retain their declared failures.

Byte limits count UTF-8 bytes. Depth counts edges from the root at depth zero.
All count and byte ceilings admit equality and reject the first excess unit.
The [default controls](../test/default-boundaries.test.ts) retain multibyte byte fixtures and exact quotas.
Quoted scalar sequences reach 100,000 syntax nodes and 100,000 expanded values at 200,000 lexical tokens.
An extra scalar crosses the token ceiling before syntax admission.
The tests separately cross the expanded-value ceiling with 48 aliases and fewer authored nodes.
Alias expansion reaches exactly one MiB per document and 16 MiB across documents.
A single extra expanded byte fails. These controls retain the default five-second request budget.

Snapshot admission rejects raw files above one MiB and aggregate source above 16 MiB before parsing.
The parser cannot admit a larger raw source by changing its own limit.
The diagnostic quota admits 1,000 errors within one document. The next error produces a terminal resource diagnostic.
A terminal diagnostic replaces the final quota row. It does not silently discard the resource failure.

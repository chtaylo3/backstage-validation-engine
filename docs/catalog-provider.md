# Production catalog provider

Implemented 2026-10-29. `createCatalogProvider` is the production HTTP adapter that collects catalog
observations with resource and time limits. Tests use the pinned Backstage 1.55.3 and 1.56.3
[catalog fixtures](testing-harness.md). The provider supplies data for later reference and rule
processing. Organization rules decide which references must exist.

## Trusted construction and credentials

The host constructs one reusable provider per approved connection, supplying its catalog base URL,
connection ID, exact native adapter ID and async credential resolver. URLs accept HTTPS and loopback
HTTP by default. They reject embedded credentials, queries and fragments. Lookup references cannot
change the destination. Redirects are returned as unavailable instead of followed.

For an approved private HTTP connection, the host can set `allowInsecureHttp: true` when it creates the provider.
This permits service names such as `http://backstage:7007` on the test Compose network.
HTTP sends catalog credentials and data without transport encryption.
Only trusted host configuration can select this option. Lookup inputs and entity content cannot enable it.

The frozen access context includes installation, principal, permission/credential revisions, scope,
policy/profile digests and maximum cache age. IDs have a 128-character limit. Scope permits 16
unique strings of at most 128 characters each. `maxAgeMs` is at most 30,000. A value of zero
requires fresh network observations.

The resolver receives this context and cancellation signal. Its credential binding must match
installation, principal, revisions and scope exactly. Binding mismatches produce unavailable
permission data without HTTP. Tokens are bounded and excluded from reports/diagnostics. A token
fingerprint partitions the cache.

These are trusted-host consistency checks. The resolver must obtain and verify credentials through
the deployment's actual authentication mechanism. The catalog API does not return a verified
principal for this adapter to compare. The host constructs access from verified authority, updates
permission/credential revisions, and performs the checks required before enforcement/publication.

## Lookup behavior

`lookup(refs, access, { deadlineAt, signal? })` returns an immutable report with a contract-0.2
`data` snapshot, typed `failures` and `interrupted`. Duplicate references within a call share one
observation. Each call owns its HTTP tasks and cancellation. The exact native adapter
parses/canonicalizes references, including the default namespace. A kind must be supplied by the
input or preceding source-context stage.

One uncached reference uses `GET /entities/by-name/{kind}/{namespace}/{name}`. Larger sets use
ordered `POST /entities/by-refs` batches. The client checks JSON content type/UTF-8, batch
structure/length, native envelopes and requested identity. Custom-kind envelopes are valid catalog
data. Ingestion policies are not rerun.

| Result                                                                         | Observation                                     |
| ------------------------------------------------------------------------------ | ----------------------------------------------- |
| Entity matching the requested reference                                        | `present`                                       |
| Single lookup 404 with valid error envelope, or batch `null`                   | `missing` from the authorized view              |
| 401/403 or mismatched credential binding                                       | `unavailable: permission_denied`                |
| Deadline, attempt timeout, cancellation or expired observation                 | `unavailable: timeout`, with typed interruption |
| Network failure                                                                | `unavailable: offline`                          |
| Invalid response, redirect, unsupported endpoint or exhausted retry/rate limit | `unavailable: provider_error`                   |

A batch endpoint's 404 never makes all its references missing. Upstream error messages are not
copied into diagnostics. `interrupted: none` means that execution was not interrupted. Callers must
still inspect failures and availability for required coverage. Cancellation remains distinct in the
report, while the existing data-entry contract uses the timeout reason for both cancellation and
timeouts.

## Resource and lifecycle limits

`CATALOG_LIMITS` exports the initial ceilings. Trusted configuration can lower them.

| Resource                                       | Ceiling                                         |
| ---------------------------------------------- | ----------------------------------------------- |
| Active / active-plus-queued calls per provider | 4 / 64                                          |
| Input references / batch size                  | 1,000 / 100                                     |
| HTTP attempt / whole operation                 | 1,000 ms / original deadline, at most 5 seconds |
| Retries / default delay / maximum retry wait   | 1 / 50 ms / 1,000 ms                            |
| Decoded response / aggregate response bytes    | 1 MiB / 8 MiB                                   |
| Aggregate response JSON values                 | 40,000                                          |
| Cache entries / serialized entry bytes         | 512 / 8 MiB                                     |
| Positive / negative observation expiry         | 30,000 / 5,000 ms                               |

FIFO admission and retry waits consume the original deadline. Admission, response and combined
snapshot exhaustion produce resource-limit interruption. A shared connection cooldown honors
Retry-After. New callers cannot bypass it.

Waits above the allowed ceiling or remaining budget return unavailable without an early retry.
Authentication, invalid responses and redirects are not retried. Closing cancels active/queued work,
awaits managed calls, clears cache and rejects new work. Trusted credential/transport callbacks
receive signals and must release any external resources they acquire when cancelled.

## Caches and provenance

Partitions include connection/endpoint, native adapter, installation, principal,
permission/credential revisions, sorted scope, policy/profile digests, required freshness and token
fingerprint. LRU eviction bounds entry count and bytes. Failures are not cached. Known
permission/binding failures clear cached observations and prevent older in-flight calls from
repopulating them. Only the newest call can populate the cache. This prevents delayed old data from
replacing new data.

Cache hits retain original timestamps. Fetch time is the successful attempt's start, so a delayed
response cannot gain a freshness window on arrival. Entries expiring while other reads wait become
unavailable before delivery. Cached/network observations together must fit the shared snapshot
limits. Observation revisions are content fingerprints, not global catalog revisions or evidence of
an atomic cross-entity read.

Before evaluation, pin the data:

1. Establish the original operation deadline.
2. Collect data within that deadline.
3. Construct the validation request with `startedAt` at pinning and the same original deadline.

Request validation rechecks freshness, identity, and permission bindings. Callers must include
interruptions and unavailable required coverage in results. In source integration, local and
pull-request overlays must precede external reads.

## Examples and remaining integration

```bash
npm run fixtures:serve -- 1.56
# In another terminal, replace PORT with the printed numeric port:
npm run example:provider -- http://127.0.0.1:PORT/api/catalog
npm run test:harness
```

The example uses the development fixture token and prints scoped observations, including a missing
entity, without an enforcement verdict. `npm run check` runs the full checks. Tests cover both pinned
fixture targets and both native helper pins. They exercise binding and cache isolation, expiry,
stale arrival, retries, cooldowns, redirects, invalid responses, aggregate budgets, deadlines,
queued cancellation, and shutdown.

The [reference preparer](source-references.md) now collects data from source contexts, verifies
provenance and pins an evaluation request under the original deadline.
[Explicit catalog rules and the stdio LSP](lsp.md) consume those pins without changing the frozen
CEL environment. H4 adds focused actual-backend authentication and ingestion controls.
The package record states their exact scope. The adapter does not negotiate a backend API version. Wire fixtures and native
validation package support remain separate. Full pipeline performance qualification is open.

Local qualification on 2026-10-29: all 31 provider checks passed within the full 356-test
`npm run check`. The built example also passed against the standalone 1.56 fixture server. It
returned two present observations and one missing observation, then completed shutdown. Hosted CI
and real Backstage deployment runs remain open.

## Safe failure evidence

`CatalogLookupReport.failures[].evidence` adds fixed `stage` and `cause` values, monotonic
`elapsedMs`, signed `wallElapsedMs`, and `deadlineRemainingMs`. Timings are integer milliseconds
bounded to 60 seconds in either direction (elapsed time is nonnegative). Each timer starts at its
component's entry. Remaining time always uses the original request deadline. Successful lookups add
no failure rows.

The existing failure codes and unavailable/outcome behavior are preserved. Evidence separates
catalog admission/credentials, transport, response validation, freshness and snapshot construction.
In particular:

- `attempt_timeout` differs from `request_timeout` and `cancelled`.
- `offline` identifies transport failure. `invalid_response` identifies rejected response data.
  Upstream error messages and bodies remain excluded.
- `future_observation` identifies a fetch timestamp later than delivery time. `observation_expired`
  identifies expiry before delivery. Both retain the existing unavailable/timeout behavior. A
  backward wall-clock change can produce the first case. The cause label records the condition, not
  why the host clock changed.
- `aggregate_limit` identifies combined snapshot rejection, including cache hits. It differs from
  wire response exhaustion, which remains `resource_limit`.

`validatePolicySources` returns up to 64 allowlisted `failureEvidence` rows and accepts a trusted
`onFailure` observer for unexpected exceptions. Observer failures cannot replace the original error.
Reference preparation retains provider-admission and snapshot-pinning evidence. Artifact bodies,
source text, tokens, endpoints, identity fields and arbitrary exception messages are excluded from
evidence.

The aggregate cache-budget test uses a controlled clock and in-memory responses. Six individually
admissible 20,000-value entities exceed the combined 100,000-value snapshot ceiling without
additional transport. A separate real-HTTP check proves large observations are cached and reused.
Injected backward-clock, transport/response failure, attempt/request deadline and cancellation
coverage preserves existing protections. This work improves diagnosis and test isolation. The cause
of the initial 2026-11-05 intermittent failure remains unconfirmed.

Local qualification on 2026-11-07: the full suite passed 672 tests. Final targeted provider,
reference, and failure-evidence checks passed 71 cases after stage-label refinement. Required
type/lint/format/schema/build checks also passed.

## Advisory identity search

`createCatalogProvider` also implements the optional `CatalogProvider.suggest` method for
completion. Inputs are a validated lowercase kind, namespace and 2–63 character name prefix, the
same trusted `CatalogAccessContext`, and an execution deadline/signal. No caller selects a URL,
projection or cursor.

The GET `/entities/by-query` subset fixes kind/namespace filters, name text search, identity-only
projection and name ordering. Cursor requests retain projection and limit, without resending
mutually exclusive filters/order/text-search parameters. At most four 100-item pages and 200 prefix
matches are retained. Identity, kind/namespace, page shape, cursor cycles/size,
UTF-8/JSON/value/byte bounds and expiry are checked. Redirects are rejected. Search performs no
retries, and shares lookup admission, credential binding, cooldown and shutdown ownership.

A ready report contains only canonical `refs`, `truncated`, `fetchedAt` and `expiresAt`. A failed
report has `status: unavailable`, a fixed failure code and no candidates. Partial pages are
discarded on failure. These reports are advisory and do not enter validation `DataSnapshot`s or
establish absence/compliance.

The provider does not cache search results. The LSP host owns a bounded completion cache scoped to
its authority. See [freshness and client behavior](lsp.md#responsive-reference-completion).

Both pinned OpenAPI fixtures cover this exact search subset. Arbitrary predicates, general
projection APIs and backend indexing semantics/performance remain outside this fixture evidence.
H4 separately proves actual authentication and permission-filtered query absence.

Local qualification on 2026-11-07: the full 813-test check passed with all required
static/schema/build checks. New search cases cover both pinned contracts, projected pagination,
scoped visibility, result, page, and byte limits, and cursor cycles. They also cover fixed failure
codes, shared queue admission, credential bindings, deadlines, cancellation, and shutdown. Existing
lookup/provider regressions also passed.

## H4 catalog boundary controls

Raw backend by-refs requests preserve the supplied strings. Canonical references find stored entities.
Shorthand, malformed, whitespace, and case variants return `null` when their strings do not match stored canonical keys.
The production client canonicalizes references before transport. That client normalization differs from raw endpoint parsing.

A permission-service DENY can hide an existing entity through by-name 404, batch `null`, or an empty query result.
These results describe the authorized view. They cannot prove global deletion.
An explicit plugin restriction produces HTTP 403 and remains `permission_denied`, as does HTTP 401.
The test policy delegates native token restrictions before it denies reads for its separate filtered identity.

Single-entity 404 admission requires JSON content type, valid JSON, error name/message strings, and matching `response.statusCode: 404`.
Empty, HTML, and mismatched envelopes remain unavailable. They never create authoritative missing entries.
Controlled retry cases cover GET, POST, date and delta Retry-After, 503, disconnects, exhausted attempts, and cancellation during backoff.
A retry begins at its admitted delay. Cancellation prevents another attempt.

Search projects identities even when a response contains full metadata and spec.
An independently unprojected response proves that stripping behavior. A wrong-kind identity remains unavailable.
These fixture controls are separate from the [actual H4 backend controls](test-harness-remediation-record.md#h4-catalog-compatibility-and-convergence).

CLI contract 0.2 projects unavailable catalog observations into `owner-exists` dependency findings and `dependency_unavailable` rule states.
Its required rules coverage becomes unavailable with the declared coverage reason.
CLI JSON does not expose the provider's `permission_denied` or `offline` transport causes.
H4 observes those causes separately through the actual provider against the same credential and outage inputs.

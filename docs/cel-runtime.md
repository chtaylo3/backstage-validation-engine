# Managed CEL and rules execution

The production `bve-cel/1` runtime uses CEL-JS 8.0.0 and RE2JS 2.9.0. CEL is the Common Expression
Language for policy expressions. RE2 provides bounded regular-expression matching. The interpreter
is loaded and evaluated only inside managed Node workers. The parent owns admission, input
snapshots, scheduling, cancellation, deadlines, and worker replacement. It has no synchronous
expression-evaluation fallback.

## Runtime lifecycle

`getSharedCelRuntime()` returns one lazily initialized pool per application process, with two fixed
execution slots. `warm()` starts both workers. Ordinary evaluation starts them when a request needs
them. All adapters in a process share that pool.

At application shutdown, call `closeSharedCelRuntime()`. Individual requests must not close the
shared runtime. Closing rejects queued work, interrupts active/startup work, awaits worker
termination, and refuses new work. Calling close again is safe. A successfully closed shared runtime
can be recreated for a later application lifecycle.

```js
import { RequestBudget, closeSharedCelRuntime, getSharedCelRuntime } from '../dist/index.js';

const runtime = getSharedCelRuntime();
const budget = new RequestBudget(Date.now() + 5000);
try {
  const allowed = await runtime.evaluate(
    'has(entity.spec.owner)',
    { spec: {} },
    {
      requestId: 'one-logical-validation-request',
      deadlineAt: budget.deadlineAt,
      signal: budget.signal,
    },
  );
  console.log(allowed); // false, a completed policy decision
} finally {
  budget.dispose();
  await closeSharedCelRuntime();
}
```

Reuse the request's original deadline and signal across every rule/provider. `RequestBudget`
supports `using` in TypeScript. The runtime replaces external abort reasons with redacted
cancellation errors. Timers and reply handlers check elapsed time. A late reply cannot turn an
expired deadline into success.

## Bounds and scheduling

| Resource                                         | Ceiling                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Worker slots / total outstanding jobs            | 2 / 64, including active and startup work                               |
| Worker execution                                 | One evaluation per worker. No queue inside a worker                     |
| Global waiting queue                             | Round-robin between admitted request IDs. 1,000 ms maximum dispatch age |
| Expression execution, including compilation      | 100 ms, or the centrally assigned lower limit                           |
| Worker startup                                   | 3,000 ms                                                                |
| Whole validation request                         | 5,000 ms from the original request start, including startup/waiting     |
| Expression / regex pattern                       | 4,096 / 512 UTF-16 units                                                |
| Entity input                                     | 256 KiB canonical JSON, 10,000 values, depth 64                         |
| Input string/key                                 | 65,536 UTF-16 units                                                     |
| AST nodes/depth, literal entries, call arguments | 4,096/64, 1,000, 32                                                     |
| Per-worker program / pattern caches              | 256 / 256 entries                                                       |
| Worker V8 old/young heap and stack settings      | 64 MiB / 16 MiB / 2 MiB                                                 |

The shared queue replaces independent queues in the reference host. Workers receive only their
current evaluation. Cancelled queued work releases admission immediately. Active interruption
terminates the worker and awaits termination before the slot is reused. Startup failure, process
error, malformed/wrong-ID reply, execution timeout, and shutdown cannot restore an obsolete result.
A termination failure closes admission rather than allocating a replacement whose predecessor can
still be active.

Round-robin fairness applies to admitted jobs. A full queue refuses new jobs with `queue_limit`. It
does not displace another request's active work. The rules executor admits at most two evaluations
per request concurrently, lowered by the assigned profile's worker/outstanding limits. Each entity's
rules follow bounded topological order, and result arrays retain deterministic subject/rule
ordering.

## CEL profile

The copied [qualification corpus](../test/fixtures/cel-qualification.json) retains its original
SHA-256: `5dbcd903f3caaff62067c4c99e0f04e21d980c53827825536fba4176a74d4fc1`. All 43
semantic/rejection cases run through the production workers. Additional tests exercise real
expensive CEL, resource-error masking, RE2 long nonmatches, admission, input snapshotting, fairness,
cancellation, crash recovery, protocol failures, startup/shutdown, and rules-stage integration.

The profile supports JSON maps, lists, and scalars, double-valued JSON numbers, explicit CEL numeric
conversions, and distinct missing and null values. It also supports presence, arithmetic,
comparisons, logical error masking, conditionals, approved collection macros, tested timestamps, and
RE2 substring matching. Rules and selectors must return a boolean. Global functions and receiver
methods use the accepted profile allowlists. Unqualified extensions and reserved host names are
rejected. Full CEL conformance, protobuf/optional types, async/custom host functions, and
deterministic CEL-Go instruction-cost accounting are not claimed.

The regex adapter renames only AST-identified method tokens to the reserved RE2 host function. It
preserves comments, string contents, grouping, and decimal precision. Dynamic patterns also use RE2.
A pattern-length resource failure is fatal even when CEL logical operators can mask an ordinary
expression error. Dependency upgrades must requalify this boundary and the frozen corpus.

## Rules-stage integration

`executeCelRules(request, { profile, policy, activation }, subjects, options)` accepts normalized
JSON entities with source locations. It checks pinned bindings and limits, copies the subject input,
and validates the resolved rule graph. That graph is a DAG: a directed graph with no cycles. The
executor then runs selectors and expressions through `CelRuntime`.

By default, it uses the shared managed pool. Runtime injection is available only to trusted
embedding code and tests. Repository plugin configuration cannot select it.

The returned immutable report contains findings, rule states, per-rule/subject coverage, redacted
typed failures, and interruption state. It can be passed to `createValidationResult` with the
adapter's other stage coverage and timestamps. Findings identify false rules. Bad
expressions/profile functions/regexes and nonboolean results are invalid policy.

Evaluation errors remain execution errors. Resource failures and unavailable runtime work remain
incomplete. Failed, inapplicable, or incomplete prerequisites block dependent rules.

Schema rules use the shared bounded draft-07 artifact engine and honor CEL selectors and
prerequisites. Missing artifacts retain incomplete dependency coverage. Schema failures are policy
violations. See [policy loading and CLI](policy-cli.md).

Unresolved inherited bundles are rejected. The signed policy resolver must produce a verified
resolved bundle. The executor does not authenticate identities, verify governance signatures, apply
bypasses/exceptions, parse YAML, perform native Backstage validation, or claim other pipeline stages
completed.

Run the complete normalized-fixture example:

```bash
npm run example:cel
```

The example uses synthetic authority fixtures and constructs normalized JSON explicitly. It
demonstrates runtime integration rather than deployment approval.

## Measurement and release boundaries

```bash
npm run benchmark:cel -- --samples 20 --output docs/evidence/cel-runtime-benchmark.json
```

The benchmark measures five fresh-process cold samples and alternating warm single-/100-entity
samples. Each entity has a managed selector and RE2 expression. The warm path includes request
validation, pinned bindings, subject snapshots, scheduling, aggregation of findings and coverage,
and result validation. It excludes YAML parsing, native Backstage, network providers, CLI/LSP
transport, and authority verification. Output includes raw samples, environment, dependency pins,
source hashes, pool counts, and end-of-run process RSS. Run it after source changes before
presenting retained measurements as current evidence.

The [initial measurements](evidence/cel-runtime-benchmark.md) retain the observed warm throughput
and the open cold-start performance gap. The
[post-parser capture](evidence/cel-runtime-after-parsing.md) refreshes those measurements after the
dependency and module changes. YAML execution remains outside the measured rules stage.

Worker threads and V8 heap settings are not an operating-system sandbox or a total RSS cap. Actual
OOM confinement, hosted CPU/RSS/network/filesystem/credential denial, native IDE/OS qualification,
and representative-scale qualification remain release gates. Arbitrary untrusted plugins remain
disabled.

`executePolicyRules` also supports explicit catalog-existence rules. `executeCelRules` remains a
compatible alias. Catalog bindings are evaluated outside the interpreter. The `bve-cel/1` variables,
semantics and frozen corpus remain unchanged. See the [catalog policy/LSP guide](lsp.md).

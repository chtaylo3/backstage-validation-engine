# Signed policies, schema rules and CLI

The local command-line interface (CLI) accepts immutable contract-0.2 source snapshots and a signed
policy release. The calling host captures source from its filesystem or Git checkout. The CLI
verifies snapshot bytes, optional baselines, roots, entrypoints, versions, and changes before it
runs source, native, and rule checks.

## Trust and inheritance

`policy-trust` is installed separately by the host. It pins Ed25519 public keys, the expected
activation generation, installation/repository/authority identity, permission revision, maximum
release age (up to seven days), and at least one mandatory baseline digest. Repository policy cannot
select these values. A local user who controls the launcher and trust file controls their own local
validation. The command does not establish hosted GitHub authorization.

`policy-release` carries a root bundle digest, its complete inheritance closure, deployment profile,
schema artifacts, activation, issue/expiry timestamps and an Ed25519 signature. The signature covers
project canonical JSON of every field except `signature`. Canonicalization uses the existing
sorted-key project format, which does not implement RFC 8785. Node's Ed25519 signing/verification
uses the null algorithm parameter
([Node crypto documentation](https://nodejs.org/docs/latest-v24.x/api/crypto.html)). No network
resolver, embedded trust keys or executable plugins are accepted.

`verifyPolicyRelease` checks the signature and trusted time window and resolves the hierarchy by
content digest. It binds activation to the resolved policy and profile digests and the exact
expected generation and scope. All host-required baseline digests must occur in the root inheritance
closure. Missing parents, detached bundles and conflicting declarations fail.

Diamond inheritance and identical rule declarations deduplicate. Any changed declaration with an
existing rule ID is rejected, including attempts to weaken severity, mandatory status, selectors,
prerequisites, expressions or versions. New IDs add rules. The complete rule DAG, a directed graph
with no cycles, must be valid. The root ID/revision identify the flattened policy, and execution
pins that policy's digest rather than the unresolved root.

Release/bundle input is limited to 2 MiB, 64 bundles and inheritance depth 16. Resolved rules retain
the 256-rule ceiling and assigned profile graph/count limits. Schema ID/version pins cannot disagree
across parents. All declared policy and custom-kind artifacts must be present, hash-correct and
inside the safe schema profile. The verification context is detached and deeply frozen.

The loader returns release/root/closure digests, signer ID, verification time and effective expiry
for host audit. Hosts must refresh their trusted generation and keys when authority changes. Signed
Git authority fields are issuer assertions. They do not verify Git history or installation
permissions. Hosted hierarchy resolution, revocation/controller recovery and authoritative
publication remain pilot work.

## Schema policies

Schema rules use the same bounded synchronous draft-07 engine as custom kinds. It supports local
acyclic references and RE2 patterns. It excludes formats, remote loaders, asynchronous keywords,
coercion, default insertion, and mutation. The existing custom-schema limits and CPU/confinement
qualification apply. Rules validate normalized entities and respect CEL selectors and the shared
prerequisite DAG.

They produce fixed policy messages at the failing field, including included-file ranges and
inclusion sites. A missing artifact in the lower-level trusted-context API produces incomplete
dependency coverage. A false selector makes the rule not applicable. Signed releases require
complete artifacts at load time. Required processors still block execution first.

## Run locally

Build and generate a fresh development package with a one-hour validity window:

```sh
npm run build
node examples/create-cli-release.mjs /tmp/bve-cli-example
node dist/cli/main.js validate \
  --source /tmp/bve-cli-example/source.json \
  --release /tmp/bve-cli-example/release.json \
  --trust /tmp/bve-cli-example/trust.json
```

The generator writes new files only and discards its ephemeral private key. These files demonstrate
local trust. An installation must supply its own host keys, baseline pins and verified activation
process. Change the snapshot's lifecycle through `createSourceSnapshot` to observe an exit-1 schema
violation. Editing text without updating its digest fails input integrity with exit 2.

After package installation the command is `bve validate`. Flags:

| Flag                   | Input/behavior                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--release`            | Required signed release JSON                                                                                                            |
| `--trust`              | Required separately installed host trust JSON                                                                                           |
| `--source`             | Source snapshot. Starts a CI budget after trusted startup                                                                               |
| `--baseline`           | Optional unchanged prior source snapshot with explicit relative changes                                                                 |
| `--data`               | Optional fresh contract data snapshot                                                                                                   |
| `--request`            | Advanced alternative to source/baseline/data. Preserves the supplied original deadline and requires the exact host identity and CI mode |
| `--catalog-config`     | Optional host catalog configuration (below)                                                                                             |
| `--format json\|sarif` | JSON contract result by default, or SARIF 2.1.0                                                                                         |
| `--output`             | Atomically replace a report file. Otherwise emit to stdout                                                                              |
| `--help`               | Usage without loading artifacts                                                                                                         |

The original five-second or lower profile budget covers parsing, source/native validation,
collection and all rule work. SIGINT/SIGTERM cancel that work. The owned provider and shared worker
runtime are awaited on shutdown. A release that expires during execution adds blocked required
policy coverage. Publication freshness is capped by effective release expiry, provider expiry and
the existing 60-second authority window. A local report does not authorize later publication.

The catalog configuration uses the existing host provider settings:

```json
{
  "connectionId": "primary",
  "baseUrl": "https://backstage.example.com/api/catalog/",
  "principalId": "validation-reader",
  "credentialRevision": "credentials-1",
  "scope": ["catalog:read"],
  "maxAgeMs": 30000,
  "tokenEnv": "BVE_CATALOG_TOKEN"
}
```

Tokens come from the host environment. Source files and policy expressions cannot choose endpoints
or credentials. Without configured catalog access, required catalog work remains incomplete.
Existing local overlays, permission-denied data, retry budgets, freshness and original-deadline
behavior are preserved.

The trusted catalog configuration also accepts optional `allowInsecureHttp`, which defaults to false.
Set it to true only for a host-approved private HTTP connection, such as the Compose test service.
HTTP sends credentials and data without transport encryption.
Proposal content cannot select this transport option.

## Output and exits

| Exit | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| 0    | Completed allow/advisory                                                        |
| 1    | Completed blocking input/native/policy violation                                |
| 2    | Incomplete work, runtime error, invalid policy, rejected trust or invalid input |

JSON output for a validation run is `validation-result`. Invalid input or configuration produces a
fixed redacted error envelope with `outcome: error` and exit 2. That envelope cannot invent valid
request history. Output-file failures also return exit 2.

SARIF contains rule descriptors, one-based UTF-16 locations, related locations, stable finding
fingerprints and result provenance/coverage. It follows the
[OASIS SARIF 2.1.0 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html).
Incomplete/error runs set `executionSuccessful: false` with an execution notification, even if they
have no findings. Completed violations retain a successful invocation and exit 1. Normalized entity
bodies and source contents are omitted from SARIF. The JSON contract retains normal validation
artifacts.

## Local qualification

On 2026-11-05, 44 new checks passed: inheritance/activation/signature/expiry cases, normalized
schema execution, real CLI subprocesses and versioned stdio schema repair. The final full
`npm run check` passed all 661 tests and the required strict type, lint, formatting,
generated-schema and build checks. Provider CLI integration exercised both pinned fake API
contracts. Schema execution and LSP repair exercised both native model pins. The built example
generated a fresh signed package and returned a completed allow result.

The formatter's pass, violation, unsupported-processor, timeout, bypass and configuration-error
outputs passed shape validation against the official OASIS SARIF schema. That local check used Ajv
with legacy regular-expression handling (`unicodeRegExp: false`, required by a pattern in that
schema) and format checking disabled. Production contracts still validate source URIs.

The first complete run passed 659/661. The existing cache aggregate-budget test received an
unavailable observation as it populated the cache. The existing LSP buffer-limit test observed no
initial catalog HTTP request. The isolated cache case, complete 31-test provider file, isolated LSP
case and full repeat all passed.

Those two tests now retain seed failure details and explicitly require successful initial
validation. No runtime fix or root cause is claimed for these intermittent observations. Hosted CI,
real backends/editors, host clock/resource stability and the existing performance/confinement gates
still need release qualification.

The 2026-11-07 follow-up adds [safe failure evidence](catalog-provider.md#safe-failure-evidence) and
separates deterministic budget/buffer proofs from HTTP integration. Explicit clock-regression tests
preserve the current deadline and freshness behavior. The historical cause remains unconfirmed.

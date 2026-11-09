# Initial managed CEL rules-stage measurements

These measurements were captured on 2026-10-28 with Node 24.20.0 on Linux x64 under WSL2. See the
[raw samples, environment, dependency pins, and source hashes](cel-runtime-benchmark.json).

| Workload                                             | Samples |      Median | Nearest-rank p95 |
| ---------------------------------------------------- | ------: | ----------: | ---------------: |
| Fresh Node process, one entity, startup and shutdown |       5 | 2,603.60 ms |      2,649.13 ms |
| Warm one entity                                      |      20 |     0.79 ms |          1.67 ms |
| Warm 100 entities                                    |      20 |    10.38 ms |         14.89 ms |

Each entity runs a managed CEL selector and RE2 expression. Warm measurements include
request/binding validation, subject snapshots, scheduling, and canonical result aggregation. Cold
measurements also include module loading, synthetic fixture setup, a completion receipt, and worker
shutdown. Warm workloads alternate order and reuse exactly two workers. Neither worker needed
replacement during measurement.

The fresh-process p95 exceeds the historical provisional 2,500 ms startup target by approximately
149 ms. Startup performance remains an open pilot requirement. Profile module loading and packaging
before adding a release performance claim. These five cold samples are preliminary observations.
They do not establish a startup service-level objective (SLO), a measured performance commitment.

YAML parsing, native Backstage, live data providers, CLI/LSP transport, governance verification, and
representative hosted concurrency are outside this measurement. RSS, the memory resident in physical
RAM, is an end-of-run process observation. It does not measure peak memory or a containment limit.
This evidence does not qualify the complete validation pipeline or native OS/IDE support. Rerun the
benchmark after relevant source/dependency changes.

```bash
npm run benchmark:cel -- --samples 20 --output docs/evidence/cel-runtime-benchmark.json
```

# Rules-stage measurement after the parser increment

Captured 2026-10-28 on Node 24.20.0, Linux x64/WSL2. The
[raw capture](cel-runtime-after-parsing.json) includes environment, samples,
dependency pins, and source hashes covering the new parsing module boundary.
The [original capture](cel-runtime-benchmark.md) remains historical evidence.

| Workload                                      | Samples |      Median | Nearest-rank p95 |
| --------------------------------------------- | ------: | ----------: | ---------------: |
| Fresh Node process and one rules-stage entity |       5 | 2,739.10 ms |      2,788.98 ms |
| Warm rules stage, one entity                  |      20 |     0.82 ms |          1.69 ms |
| Warm rules stage, 100 entities                |      20 |    11.85 ms |         16.47 ms |

These measurements execute managed selectors/RE2 rules, pinned bindings and
canonical result aggregation. They do not execute YAML parsing, native Backstage,
providers, or CLI/LSP transport. The parser is lazily loaded and is exercised by
its separate acceptance tests and runnable example.

Cold p95 remains above the provisional 2,500 ms target. Startup profiling and
packaging remain open before a pilot performance claim. Five cold samples and
one local environment do not establish a release SLO or supported-platform matrix.
End-of-run RSS is not a measured peak or a containment limit.

# Rules-stage measurement after the parser increment

These measurements were captured on 2026-10-28 with Node 24.20.0 on Linux x64 under WSL2. The
[raw capture](cel-runtime-after-parsing.json) includes environment, samples, dependency pins, and
source hashes covering the new parsing module boundary. The
[original capture](cel-runtime-benchmark.md) remains historical evidence.

| Workload                                      | Samples |      Median | Nearest-rank p95 |
| --------------------------------------------- | ------: | ----------: | ---------------: |
| Fresh Node process and one rules-stage entity |       5 | 2,739.10 ms |      2,788.98 ms |
| Warm rules stage, one entity                  |      20 |     0.82 ms |          1.69 ms |
| Warm rules stage, 100 entities                |      20 |    11.85 ms |         16.47 ms |

These measurements execute managed selectors/RE2 rules, pinned bindings and canonical result
aggregation. They do not execute YAML parsing, native Backstage, providers, or CLI/LSP transport.
The parser loads only when called. Separate acceptance tests and a runnable example exercise it.

Cold p95 remains above the provisional 2,500 ms target. Startup profiling and packaging remain open
before a pilot performance claim. Five cold samples from one local environment do not establish a
release performance commitment or support for other platforms. RSS measures memory resident in
physical RAM. Its end-of-run value does not measure peak memory or a containment limit.

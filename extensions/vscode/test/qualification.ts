import assert from 'node:assert/strict';
import type { Report } from './reporting.js';
import { verifyResourceGrowth } from './resources.js';
import type { ResourceSample } from './resources.js';

/** Host-approved current policy. H5 owns any later budget revision. */
export const METRIC_BUDGETS = Object.freeze({
  coldMs: 20_000,
  editP95Ms: 20_000,
  completionP95Ms: 20_000,
  restartP95Ms: 20_000,
  warmupOperations: 10,
  clientGrowthMiB: 128,
  serverGrowthMiB: 128,
  handleGrowth: 64,
  growthMiBPerOperation: 0.15,
});
export const metricPercentile = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
export function verifyReport(
  report: Report,
  revision: string,
  checksum: string,
  ids: string[],
): void {
  assert.equal(report.metadata.revision, revision);
  assert.equal(report.metadata.vsixSha256, checksum);
  assert.equal(report.conclusion, 'success');
  assert.equal(report.metadata.focused, null);
  const expected = ['1.106.3', '1.145.2']
    .flatMap((version) => ids.map((id) => version + '/' + id))
    .sort();
  assert(expected.length > 0);
  assert.deepEqual(report.cases.map((row) => row.version + '/' + row.id).sort(), expected);
  assert(
    report.cases.every((row) => row.status === 'passed' && row.phase === 'complete' && !row.error),
  );
  assert.deepEqual(report.counts, {
    discovered: expected.length,
    executed: expected.length,
    passed: expected.length,
    failed: 0,
    unexecuted: 0,
  });
}
export interface ResourceMetrics {
  complete: boolean;
  size: number;
  durationSeconds: number;
  elapsedMs: number;
  workloadElapsedMs: number;
  operation: number;
  interruptions: number;
  catalogVersionsObserved: string[];
  coldMs: number;
  budgets: typeof METRIC_BUDGETS;
  latencies: { edits: number[]; completions: number[]; restarts: number[] };
  percentiles: { editP95Ms: number; completionP95Ms: number; restartP95Ms: number };
  samples: ResourceSample[];
}
export function verifyMetrics(metrics: ResourceMetrics, duration: number, size = 1000): void {
  assert.equal(metrics.complete, true);
  assert([100, 1000].includes(size));
  assert(Number.isFinite(metrics.elapsedMs) && Number.isFinite(metrics.workloadElapsedMs));
  assert(metrics.workloadElapsedMs <= metrics.elapsedMs);
  assert(Number.isSafeInteger(metrics.interruptions) && metrics.interruptions >= 0);
  assert.deepEqual(metrics.budgets, METRIC_BUDGETS, 'Use the host-approved budget policy.');
  assert(
    Number.isFinite(metrics.coldMs) &&
      metrics.coldMs >= 0 &&
      metrics.coldMs <= METRIC_BUDGETS.coldMs,
  );
  for (const [raw, summary] of [
    ['edits', 'editP95Ms'],
    ['completions', 'completionP95Ms'],
    ['restarts', 'restartP95Ms'],
  ] as const) {
    const values = metrics.latencies[raw];
    assert(Array.isArray(values) && values.length > 0, 'Require raw latency observations.');
    assert(values.every((value) => Number.isFinite(value) && value >= 0));
    const actual = metricPercentile(values);
    assert.equal(
      metrics.percentiles[summary],
      actual,
      'Latency summary must match raw observations.',
    );
    assert(actual <= METRIC_BUDGETS[summary], summary + ' exceeds the host budget');
  }
  assert.equal(metrics.latencies.edits.length, metrics.operation);
  assert.equal(metrics.latencies.completions.length, metrics.operation);
  assert.equal(metrics.durationSeconds, duration);
  assert.equal(metrics.size, size);
  assert(metrics.elapsedMs >= duration * 1000);
  assert(metrics.workloadElapsedMs >= duration * 1000);
  assert(
    Number.isSafeInteger(metrics.operation) && metrics.operation >= (duration === 0 ? 60 : 100),
  );
  if (duration > 0) {
    assert(metrics.interruptions >= 2);
    assert.deepEqual([...metrics.catalogVersionsObserved].sort(), ['1.55.3', '1.56.3']);
  }
  assert(metrics.samples.length >= 8);
  let previousOperation = -1,
    previousElapsed = -1;
  for (const sample of metrics.samples) {
    assert(
      Number.isSafeInteger(sample.operation) &&
        sample.operation > previousOperation &&
        sample.operation < metrics.operation,
    );
    assert(
      Number.isFinite(sample.elapsedMs) &&
        sample.elapsedMs > previousElapsed &&
        sample.elapsedMs <= metrics.elapsedMs,
    );
    previousOperation = sample.operation;
    previousElapsed = sample.elapsedMs;
    assert(sample.pid > 1);
    for (const side of [sample.client, sample.server])
      assert(
        Number.isFinite(side.rssMiB) &&
          side.rssMiB > 0 &&
          Number.isInteger(side.handles) &&
          side.handles > 0,
      );
  }
  verifyResourceGrowth(metrics.samples, METRIC_BUDGETS, true, duration > 0);
}
export function verifyRepetitions(
  repetitions: { iteration: number; conclusion: string; counts: Report['counts'] }[],
): void {
  assert.equal(repetitions.length, 20);
  assert.deepEqual(
    repetitions.map((row) => row.iteration),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert(
    repetitions.every(
      (row) =>
        row.conclusion === 'success' &&
        row.counts.failed === 0 &&
        row.counts.unexecuted === 0 &&
        row.counts.discovered > 0 &&
        row.counts.executed === row.counts.discovered &&
        row.counts.passed === row.counts.discovered,
    ),
  );
}

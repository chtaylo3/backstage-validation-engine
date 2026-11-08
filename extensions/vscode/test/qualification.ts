import assert from 'node:assert/strict';
import type { Report } from './reporting.js';
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
  samples: {
    pid: number;
    client: { rssMiB: number; handles: number };
    server: { rssMiB: number; handles: number };
  }[];
}
export function verifyMetrics(metrics: ResourceMetrics, duration: number): void {
  assert.equal(metrics.complete, true);
  assert.equal(metrics.durationSeconds, duration);
  assert.equal(metrics.size, 1000);
  assert(metrics.elapsedMs >= duration * 1000);
  assert(metrics.workloadElapsedMs >= duration * 1000);
  assert(metrics.operation >= 100);
  assert(metrics.interruptions >= 2);
  assert.deepEqual([...metrics.catalogVersionsObserved].sort(), ['1.55.3', '1.56.3']);
  assert(metrics.samples.length >= 8);
  for (const sample of metrics.samples) {
    assert(sample.pid > 1);
    for (const side of [sample.client, sample.server])
      assert(
        Number.isFinite(side.rssMiB) &&
          side.rssMiB > 0 &&
          Number.isInteger(side.handles) &&
          side.handles > 0,
      );
  }
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

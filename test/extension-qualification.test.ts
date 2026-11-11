import assert from 'node:assert/strict';
import test from 'node:test';
import {
  METRIC_BUDGETS,
  metricPercentile,
  verifyMetrics,
  verifyReport,
  verifyRepetitions,
} from '../extensions/vscode/test/qualification.js';
import type { ResourceMetrics } from '../extensions/vscode/test/qualification.js';
import type { Report } from '../extensions/vscode/test/reporting.js';
const report = (): Report => ({
  metadata: { revision: 'candidate', vsixSha256: 'artifact', focused: null },
  conclusion: 'success',
  counts: { discovered: 2, executed: 2, passed: 2, failed: 0, unexecuted: 0 },
  cases: ['1.106.3', '1.145.2'].map((version) => ({
    version,
    id: 'case',
    status: 'passed',
    phase: 'complete',
    durationMs: 1,
  })),
});
void test('qualification accepts only complete inventories for the exact candidate artifact', () => {
  verifyReport(report(), 'candidate', 'artifact', ['case']);
  assert.throws(() => verifyReport(report(), 'different', 'artifact', ['case']));
  assert.throws(() => verifyReport(report(), 'candidate', 'rebuilt', ['case']));
  const missing = report();
  missing.cases.pop();
  assert.throws(() => verifyReport(missing, 'candidate', 'artifact', ['case']));
  const duplicate = report();
  duplicate.cases[1] = duplicate.cases[0]!;
  assert.throws(() => verifyReport(duplicate, 'candidate', 'artifact', ['case']));
});
void test('focused, unfinished and failed cases cannot qualify a release', () => {
  for (const mutate of [
    (r: Report) => {
      r.metadata.focused = 'case';
    },
    (r: Report) => {
      r.cases[0]!.phase = 'cleanup';
    },
    (r: Report) => {
      r.cases[0]!.status = 'failed';
    },
    (r: Report) => {
      r.counts.unexecuted = 1;
    },
  ]) {
    const r = report();
    mutate(r);
    assert.throws(() => verifyReport(r, 'candidate', 'artifact', ['case']));
  }
});
void test('soak qualification rejects short, interrupted and empty resource reports', () => {
  const metrics: ResourceMetrics = {
    complete: true,
    size: 1000,
    durationSeconds: 7200,
    elapsedMs: 7200001,
    workloadElapsedMs: 7200001,
    operation: 500,
    interruptions: 10,
    catalogVersionsObserved: ['1.55.3', '1.56.3'],
    budgets: METRIC_BUDGETS,
    coldMs: 100,
    latencies: {
      edits: Array<number>(500).fill(100),
      completions: Array<number>(500).fill(20),
      restarts: [200, 300],
    },
    percentiles: { editP95Ms: 100, completionP95Ms: 20, restartP95Ms: 300 },
    samples: Array.from({ length: 8 }, (_, index) => ({
      elapsedMs: index * 900000,
      operation: index * 60,
      pid: 42,
      client: { rssMiB: 200, handles: 30 },
      server: { rssMiB: 500, handles: 40 },
    })),
  };
  verifyMetrics(metrics, 7200);
  for (const mutate of [
    (m: ResourceMetrics) => {
      m.latencies.edits.fill(1_000_000);
      m.percentiles.editP95Ms = metricPercentile(m.latencies.edits);
    },
    (m: ResourceMetrics) => {
      m.percentiles.editP95Ms = 1;
    },
    (m: ResourceMetrics) => {
      m.samples.at(-1)!.server.rssMiB = 10_000;
    },
    (m: ResourceMetrics) => {
      m.samples.forEach((row, index) => {
        row.server.rssMiB += index * 60 * 0.16;
      });
    },
    (m: ResourceMetrics) => {
      m.samples.forEach((row, index) => {
        row.operation = index * 3;
      });
    },
    (m: ResourceMetrics) => {
      m.budgets = { ...METRIC_BUDGETS, editP95Ms: 1_000_000 } as unknown as typeof METRIC_BUDGETS;
    },
    (m: ResourceMetrics) => {
      m.samples[0]!.pid = 42.5;
    },
    (m: ResourceMetrics) => {
      Object.assign(m.samples[0]!, { pid: '42' });
    },
    (m: ResourceMetrics) => {
      m.complete = false;
    },
    (m: ResourceMetrics) => {
      m.elapsedMs = 1000;
    },
    (m: ResourceMetrics) => {
      m.durationSeconds = 1800;
    },
    (m: ResourceMetrics) => {
      m.samples = [];
    },
    (m: ResourceMetrics) => {
      m.samples[0]!.server.rssMiB = NaN;
    },
    (m: ResourceMetrics) => {
      m.interruptions = 0;
    },
    (m: ResourceMetrics) => {
      m.catalogVersionsObserved = ['1.55.3'];
    },
  ]) {
    const m = structuredClone(metrics);
    mutate(m);
    assert.throws(() => verifyMetrics(m, 7200));
  }
});
void test('twenty independent race repetitions are required without hiding an earlier failure', () => {
  const repetitions = Array.from({ length: 20 }, (_, index) => ({
    iteration: index + 1,
    conclusion: 'success',
    counts: report().counts,
  }));
  verifyRepetitions(repetitions);
  assert.throws(() => verifyRepetitions(repetitions.slice(1)));
  repetitions[0]!.conclusion = 'failure';
  assert.throws(() => verifyRepetitions(repetitions));
});
void test('load verdict checks raw latencies and retained growth without claiming a required soak slope', () => {
  const load: ResourceMetrics = {
    complete: true,
    size: 100,
    durationSeconds: 0,
    elapsedMs: 100000,
    workloadElapsedMs: 90000,
    operation: 60,
    interruptions: 0,
    catalogVersionsObserved: [],
    coldMs: 100,
    budgets: METRIC_BUDGETS,
    latencies: {
      edits: Array<number>(60).fill(100),
      completions: Array<number>(60).fill(20),
      restarts: [200, 300],
    },
    percentiles: { editP95Ms: 100, completionP95Ms: 20, restartP95Ms: 300 },
    samples: Array.from({ length: 20 }, (_, index) => ({
      elapsedMs: index * 3000,
      operation: index * 3,
      pid: 42,
      client: { rssMiB: 200, handles: 30 },
      server: { rssMiB: 500, handles: 40 },
    })),
  };
  verifyMetrics(load, 0, 100);
  for (const mutate of [
    (row: ResourceMetrics) => {
      row.latencies.edits.fill(1_000_000);
      row.percentiles.editP95Ms = 1_000_000;
    },
    (row: ResourceMetrics) => {
      row.samples.at(-1)!.server.rssMiB = 10_000;
    },
    (row: ResourceMetrics) => {
      row.samples.at(-1)!.client.handles += 65;
    },
    (row: ResourceMetrics) => {
      row.elapsedMs = Infinity;
    },
    (row: ResourceMetrics) => {
      row.latencies.restarts = [];
    },
    (row: ResourceMetrics) => {
      delete (row as Partial<ResourceMetrics>).budgets;
    },
  ]) {
    const invalid = structuredClone(load);
    mutate(invalid);
    assert.throws(() => verifyMetrics(invalid, 0, 100));
  }
  assert.throws(() => verifyMetrics(load, 0, 1000));
});
void test('p95 admits exactly 25 high observations of 500 and rejects the twenty-sixth', () => {
  const metrics: ResourceMetrics = {
    complete: true,
    size: 1000,
    durationSeconds: 7200,
    elapsedMs: 7200001,
    workloadElapsedMs: 7200001,
    operation: 500,
    interruptions: 2,
    catalogVersionsObserved: ['1.55.3', '1.56.3'],
    coldMs: 100,
    budgets: METRIC_BUDGETS,
    latencies: {
      edits: [...Array<number>(475).fill(100), ...Array<number>(25).fill(20001)],
      completions: Array<number>(500).fill(20),
      restarts: [200, 200],
    },
    percentiles: { editP95Ms: 100, completionP95Ms: 20, restartP95Ms: 200 },
    samples: Array.from({ length: 8 }, (_, index) => ({
      elapsedMs: index * 900000,
      operation: index * 60,
      pid: 42,
      client: { rssMiB: 200, handles: 30 },
      server: { rssMiB: 500, handles: 40 },
    })),
  };
  verifyMetrics(metrics, 7200);
  metrics.latencies.edits[474] = 20001;
  metrics.percentiles.editP95Ms = 20001;
  assert.throws(() => verifyMetrics(metrics, 7200), /editP95Ms exceeds/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
    samples: Array.from({ length: 8 }, () => ({
      pid: 42,
      client: { rssMiB: 200, handles: 30 },
      server: { rssMiB: 500, handles: 40 },
    })),
  };
  verifyMetrics(metrics, 7200);
  for (const mutate of [
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

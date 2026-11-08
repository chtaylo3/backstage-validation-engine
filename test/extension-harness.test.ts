import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, junit, runCases } from '../extensions/vscode/test/reporting.js';
import type { CaseSpec, Outcome, Progress, Report } from '../extensions/vscode/test/reporting.js';

const first = { id: 'startup', version: '1.106.3' };
const later = { id: 'diagnostics', version: '1.145.2' };
const passed = (spec: CaseSpec): Outcome => ({
  exitCode: 0,
  progress: { id: spec.id, phase: 'complete', status: 'passed', serverPids: [] },
});

void test('editor runner continues later cases and versions after an assertion or provisioning failure', async () => {
  const executed: string[] = [];
  const report = await runCases(
    [first, { id: 'save', version: first.version }, later],
    {},
    (spec) => {
      executed.push(`${spec.version}/${spec.id}`);
      if (spec.id === 'startup')
        return {
          exitCode: 1,
          progress: {
            id: spec.id,
            phase: 'run',
            status: 'failed',
            error: 'bad diagnostic',
            serverPids: [],
          },
        };
      if (spec.id === 'save') throw new Error('download failed');
      return passed(spec);
    },
    () => {},
  );
  assert.deepEqual(executed, ['1.106.3/startup', '1.106.3/save', '1.145.2/diagnostics']);
  assert.equal(report.conclusion, 'failure');
  assert.deepEqual(report.counts, {
    discovered: 3,
    executed: 3,
    passed: 1,
    failed: 2,
    unexecuted: 0,
  });
  assert.match(report.cases[1]!.error!, /download failed/u);
});

void test('editor crash fails the active phase and preserves earlier outcomes and later execution', async () => {
  const snapshots: Report[] = [];
  const report = await runCases(
    [first, later],
    { revision: 'fixture' },
    (spec) =>
      spec.id === first.id
        ? {
            exitCode: 137,
            progress: { id: spec.id, phase: 'run', status: 'running', serverPids: [123] },
          }
        : passed(spec),
    (value) => {
      snapshots.push(structuredClone(value));
    },
  );
  assert.equal(report.cases[0]!.status, 'failed');
  assert.equal(report.cases[0]!.phase, 'run');
  assert.equal(report.cases[1]!.status, 'passed');
  assert(
    snapshots.some(
      (value) => value.cases[0]!.status === 'running' && value.cases[1]!.status === 'unexecuted',
    ),
  );
  assert(
    snapshots.some(
      (value) => value.cases[0]!.status === 'failed' && value.cases[1]!.status === 'running',
    ),
  );
});

void test('zero exit code cannot conceal missing reports, interrupted cleanup or a skipped case', () => {
  const progress: Progress = { id: first.id, phase: 'cleanup', status: 'running', serverPids: [] };
  assert.equal(classify(first, { exitCode: 0 }).status, 'failed');
  assert.equal(classify(first, { exitCode: 0, progress }).status, 'failed');
  assert.equal(
    classify(first, {
      exitCode: 0,
      progress: { ...progress, status: 'skipped' as Progress['status'] },
    }).status,
    'failed',
  );
  assert.equal(
    classify(first, { ...passed(first), error: 'cleanup could not remove profile' }).status,
    'failed',
  );
});

void test('a report for a different scenario cannot qualify a discovered editor case', () => {
  assert.equal(classify(first, passed(later)).status, 'failed');
});

void test('cleanup failures remain failures even after successful assertions', async () => {
  const report = await runCases(
    [first, later],
    {},
    (spec) =>
      spec.id === first.id
        ? {
            exitCode: 1,
            progress: {
              id: spec.id,
              phase: 'cleanup',
              status: 'failed',
              error: 'server remains alive',
              serverPids: [123],
            },
          }
        : passed(spec),
    () => {},
  );
  assert.equal(report.cases[0]!.phase, 'cleanup');
  assert.match(report.cases[0]!.error!, /server remains alive/u);
  assert.equal(report.cases[1]!.status, 'passed');
  assert.equal(report.conclusion, 'failure');
});

void test('editor runner refuses empty and duplicate inventories before executing', async () => {
  let executed = false;
  const execute = (spec: CaseSpec) => {
    executed = true;
    return passed(spec);
  };
  await assert.rejects(
    runCases([], {}, execute, () => {}),
    /No installed-extension cases/u,
  );
  await assert.rejects(
    runCases([first, first], {}, execute, () => {}),
    /Duplicate/u,
  );
  assert.equal(executed, false);
});

void test('successful editor runs report measured executions and retain artifact provenance', async () => {
  const metadata = { vsixSha256: 'fixture-hash', target: 'linux-x64', revision: 'fixture-commit' };
  const report = await runCases(
    [first, later],
    metadata,
    (spec) => passed(spec),
    () => {},
  );
  assert.equal(report.conclusion, 'success');
  assert.deepEqual(report.counts, {
    discovered: 2,
    executed: 2,
    passed: 2,
    failed: 0,
    unexecuted: 0,
  });
  assert.deepEqual(report.metadata, metadata);
  assert(report.cases.every((row) => row.durationMs >= 0));
});

void test('JUnit escapes failure evidence and represents interrupted cases as failures, not skips', async () => {
  let initial: Report | undefined;
  await runCases(
    [first, later],
    {},
    (spec) => ({
      exitCode: 1,
      progress: {
        id: spec.id,
        phase: 'run',
        status: 'failed',
        error: '<unsafe> & "quoted"',
        serverPids: [],
      },
    }),
    (value) => {
      initial ??= structuredClone(value);
    },
  );
  const incomplete = junit(initial!);
  assert.match(incomplete, /tests="2" failures="2" skipped="0"/u);
  assert.match(incomplete, /unexecuted: launch/u);
  const report = await runCases(
    [first],
    {},
    () => ({
      exitCode: 1,
      progress: {
        id: first.id,
        phase: 'run',
        status: 'failed',
        error: '<unsafe> & "quoted"',
        serverPids: [],
      },
    }),
    () => {},
  );
  assert.match(junit(report), /&lt;unsafe&gt; &amp; &quot;quoted&quot;/u);
  assert.doesNotMatch(junit(report), /<unsafe>/u);
});

void test('a report write failure aborts qualification rather than producing an unreported pass', async () => {
  await assert.rejects(
    runCases(
      [first],
      {},
      (spec) => passed(spec),
      () => {
        throw new Error('disk full');
      },
    ),
    /disk full/u,
  );
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const faults = [
  'none',
  'missing-report',
  'build-failure',
  'cleanup-failure',
  'interrupted-child',
  'failed-child',
  'unfinished-report',
];
for (const fault of faults)
  void test(
    'host subprocess accounts for ' + fault + ' through production orchestration',
    async (t) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'bve-host-control-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      let code = 0;
      try {
        await exec(process.execPath, ['scripts/backstage-runner-controls.mjs', fault, directory]);
      } catch (error) {
        code = (error as { code: number }).code;
      }
      assert.equal(code, fault === 'none' ? 0 : 1);
      const report = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8')) as {
        status: string;
        exitCode: number;
        cleanupEntered: boolean;
        cleanup: { status: string };
        targets: {
          hostFailure?: { code?: string; phase?: string; name?: string };
          cases: { id: string; status: string; phase: string }[];
        }[];
        counts: {
          discovered: number;
          executed: number;
          passed: number;
          failed: number;
          unexecuted: number;
        };
      };
      assert.equal(report.exitCode, code);
      assert.equal(report.status, fault === 'none' ? 'passed' : 'failed');
      assert.equal(report.cleanupEntered, true);
      assert.equal(report.counts.discovered, 4);
      const row = (id: string) => report.targets[0]!.cases.find((entry) => entry.id === id)!;
      assert.equal(
        row('environment.cleanup').status,
        fault === 'cleanup-failure' ? 'failed' : 'passed',
      );
      if (fault === 'none')
        assert.deepEqual(report.counts, {
          discovered: 4,
          executed: 4,
          passed: 4,
          failed: 0,
          unexecuted: 0,
        });
      if (fault === 'missing-report') {
        assert.equal(report.targets[0]!.hostFailure?.code, 'missing-report');
        assert.equal(row('driver.case').status, 'unexecuted');
      }
      if (fault !== 'none' && fault !== 'unfinished-report')
        assert(report.targets[0]!.hostFailure?.name);
      if (fault === 'build-failure') {
        assert.equal(report.targets[0]!.hostFailure?.phase, 'build');
        assert.equal(row('environment.build').status, 'failed');
        assert.equal(row('environment.build').phase, 'build');
        assert.equal(row('driver.case').status, 'unexecuted');
      }
      if (['failed-child', 'interrupted-child'].includes(fault)) {
        assert.equal(row('driver.case').status, 'failed');
        assert.equal(row('driver.case').phase, 'execution');
        assert.equal(row('following.case').status, 'unexecuted');
      }
      if (fault === 'unfinished-report') assert.equal(row('following.case').status, 'unexecuted');
      if (fault === 'cleanup-failure') assert.equal(report.cleanup.status, 'failed');
    },
  );
void test('host orchestration refuses empty or duplicate declarations and incomplete aggregates', async () => {
  const { concludeHostReport, runHostTarget } = (await import(
    (await import('node:url')).pathToFileURL(
      path.resolve('test/integration/backstage/lib/host-runner.mjs'),
    ).href
  )) as {
    concludeHostReport: (report: unknown, failure: unknown, expected: string[]) => number;
    runHostTarget: (options: { inventory: { id: string }[] }) => Promise<unknown>;
  };
  await assert.rejects(runHostTarget({ inventory: [] }), /nonempty unique/);
  await assert.rejects(runHostTarget({ inventory: [{ id: 'a' }, { id: 'a' }] }), /nonempty unique/);
  const report = () => ({
    targets: [
      {
        target: 'target',
        cleanup: { status: 'passed' },
        cases: [{ id: 'case', status: 'passed', phase: 'complete', durationMs: 1 }],
      },
    ],
    cleanup: { status: 'passed' },
  });
  assert.throws(() => concludeHostReport(report(), undefined, []), /nonempty unique/);
  assert.throws(
    () => concludeHostReport(report(), undefined, ['target', 'target']),
    /nonempty unique/,
  );
  assert.equal(concludeHostReport(report(), undefined, ['target', 'missing']), 1);
  const empty = report();
  empty.targets[0]!.cases = [];
  assert.equal(concludeHostReport(empty, undefined, ['target']), 1);
  const duplicate = report();
  duplicate.targets[0]!.cases.push({ ...duplicate.targets[0]!.cases[0]! });
  assert.equal(concludeHostReport(duplicate, undefined, ['target']), 1);
});

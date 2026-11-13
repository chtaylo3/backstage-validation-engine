import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './process.mjs';
import { runHostTarget, concludeHostReport } from './host-runner.mjs';
import { writeJson } from './evidence.mjs';

export async function executeHostControl(directory, fault = 'none') {
  assert(
    [
      'none',
      'missing-report',
      'build-failure',
      'cleanup-failure',
      'interrupted-child',
      'failed-child',
      'unfinished-report',
    ].includes(fault),
  );
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'target-report.json');
  await rm(file, { force: true });
  const inventory = [
    'environment.build',
    'driver.case',
    'following.case',
    'environment.cleanup',
  ].map((id) => ({ id, scope: 'runner' }));
  let cleanupEntered = false;
  const child = fileURLToPath(new URL('./host-control-child.mjs', import.meta.url));
  const result = await runHostTarget({
    file,
    inventory,
    initial: { target: 'control', cleanup: { status: 'failed' } },
    build: () =>
      runCommand(process.execPath, [
        '-e',
        fault === 'build-failure' ? 'process.exit(23)' : 'process.exit(0)',
      ]),
    execute: async () => {
      if (fault === 'missing-report') await rm(file);
      await runCommand(process.execPath, [child, file, fault]);
    },
    cleanup: async () => {
      cleanupEntered = true;
      await runCommand(process.execPath, [
        '-e',
        fault === 'cleanup-failure' ? 'process.exit(24)' : 'process.exit(0)',
      ]);
    },
  });
  const report = {
    fixtureOnly: true,
    status: 'failed',
    targets: [result.report],
    cleanup: { status: 'failed' },
  };
  const exitCode = concludeHostReport(report, result.failure, ['control']);
  await writeJson(path.join(directory, 'results.json'), { ...report, exitCode, cleanupEntered });
  return { report, exitCode, cleanupEntered };
}
export async function verifyHostControl(directory, fault) {
  const { report, exitCode, cleanupEntered } = await executeHostControl(directory, fault);
  assert.equal(exitCode, 1);
  assert.equal(report.status, 'failed');
  assert.equal(cleanupEntered, true);
  const rows = report.targets[0].cases;
  const row = (id) => rows.find((item) => item.id === id);
  if (fault === 'build-failure') {
    assert.equal(row('environment.build').status, 'failed');
    assert.equal(row('driver.case').status, 'unexecuted');
  }
  if (fault === 'missing-report') {
    assert.equal(report.targets[0].hostFailure.code, 'missing-report');
    assert.equal(row('driver.case').status, 'unexecuted');
  }
  if (['failed-child', 'interrupted-child'].includes(fault)) {
    assert.equal(row('driver.case').status, 'failed');
    assert.equal(row('following.case').status, 'unexecuted');
  }
  if (fault === 'unfinished-report') assert.equal(row('following.case').status, 'unexecuted');
  if (fault === 'cleanup-failure') assert.equal(report.cleanup.status, 'failed');
  assert.equal(
    JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8')).exitCode,
    1,
  );
  return report;
}

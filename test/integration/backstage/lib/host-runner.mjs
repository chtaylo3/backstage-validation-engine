import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openEvidence, counts, expectedCases, caseKey, writeJson } from './evidence.mjs';

/** Production orchestration. Only environment/process operations are injected. */
export async function runHostTarget({
  file,
  inventory,
  initial,
  build,
  execute,
  cleanup,
  cleanupPreparation = async () => {},
  saveState = async () => {},
}) {
  assert(
    inventory.length > 0 && new Set(inventory.map((row) => row.id)).size === inventory.length,
    'Require a nonempty unique target inventory.',
  );
  let failure;
  let failurePhase;
  let phase = 'build';
  let evidence = await openEvidence(file, inventory, initial);
  await evidence.save();
  const reload = async () => {
    // A successful child without its report is a host failure, never a fresh inventory.
    const observed = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(
      observed.cases.map(caseKey).sort(),
      expectedCases(inventory).map(caseKey).sort(),
      'Child report must retain the exact target inventory.',
    );
    evidence = await openEvidence(file, inventory);
  };
  try {
    await evidence.run('environment.build', 'build', build);
    phase = 'execution';
    await execute({
      reload,
      get evidence() {
        return evidence;
      },
    });
    phase = 'report';
    await reload();
  } catch (error) {
    failure = error;
    failurePhase = phase;
  } finally {
    try {
      await reload();
    } catch (error) {
      if (!failure) failurePhase = 'report';
      failure ??= error;
    }
    try {
      await cleanupPreparation();
    } catch (error) {
      if (!failure) failurePhase = 'logs';
      failure ??= error;
    }
    try {
      await evidence.run('environment.cleanup', 'cleanup', cleanup);
      evidence.report.cleanup = { status: 'passed' };
    } catch (error) {
      if (!failure) failurePhase = 'cleanup';
      failure ??= error;
      evidence.report.cleanup = { status: 'failed' };
    }
    try {
      await saveState(evidence.report.cleanup.status);
    } catch (error) {
      if (!failure) failurePhase = 'state';
      failure ??= error;
    }
    if (failure)
      evidence.report.hostFailure = {
        phase: failurePhase,
        name: failure.name,
        ...(failure.code === 'ENOENT' ? { code: 'missing-report' } : {}),
      };
    await evidence.save();
  }
  return { report: evidence.report, failure };
}

export function concludeHostReport(report, failure, expectedTargets) {
  assert(
    expectedTargets.length > 0 && new Set(expectedTargets).size === expectedTargets.length,
    'Require nonempty unique declared targets.',
  );
  report.counts = counts(report.targets.flatMap((target) => target.cases));
  report.cleanup.status =
    report.targets.length === expectedTargets.length &&
    report.targets.every((target) => target.cleanup.status === 'passed')
      ? 'passed'
      : 'failed';
  const complete =
    report.targets.length === expectedTargets.length &&
    new Set(report.targets.map((target) => target.target)).size === expectedTargets.length &&
    expectedTargets.every((id) => report.targets.some((target) => target.target === id)) &&
    report.targets.every(
      (target) =>
        target.cases.length > 0 &&
        new Set(target.cases.map(caseKey)).size === target.cases.length &&
        target.cases.every(
          (row) =>
            row.status === 'passed' &&
            row.phase === 'complete' &&
            Number.isFinite(row.durationMs) &&
            row.durationMs >= 0,
        ),
    );
  report.status =
    !failure &&
    complete &&
    report.cleanup.status === 'passed' &&
    report.counts.unexecuted === 0 &&
    report.counts.failed === 0
      ? 'passed'
      : 'failed';
  return report.status === 'passed' ? 0 : 1;
}

/** Crash proof uses the same durable row classification as normal host execution. */
export async function runEditorCrashControl(file, crash, following) {
  const evidence = await openEvidence(file, [
    { id: 'entered-editor-crash', scope: 'runner' },
    { id: 'following-editor', scope: 'runner' },
  ]);
  let failure;
  try {
    await evidence.run('entered-editor-crash', 'editor', crash);
  } catch (error) {
    failure = error;
  }
  assert(failure, 'The actual entered editor must fail the evidence.run operation.');
  await evidence.run('following-editor', 'editor', following);
  assert.deepEqual(evidence.report.counts, {
    discovered: 2,
    executed: 2,
    passed: 1,
    failed: 1,
    unexecuted: 0,
  });
  await writeJson(file, { ...evidence.report, fixtureOnly: true });
  return { report: evidence.report, failure };
}

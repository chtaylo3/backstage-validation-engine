import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const EDITORS = Object.freeze(['1.106.3', '1.145.2']);
export function expectedCases(cases) {
  return cases.flatMap((entry) =>
    entry.scope === 'editor'
      ? EDITORS.map((editorVersion) => ({ ...entry, editorVersion }))
      : [{ ...entry }],
  );
}
export const caseKey = (row) => row.id + (row.editorVersion ? '/' + row.editorVersion : '');
export function counts(rows) {
  return {
    discovered: rows.length,
    executed: rows.filter((r) => r.status !== 'unexecuted').length,
    passed: rows.filter((r) => r.status === 'passed').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    unexecuted: rows.filter((r) => r.status === 'unexecuted').length,
  };
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file + '.next', JSON.stringify(value, null, 2) + '\n', { mode: 0o644 });
  await rename(file + '.next', file);
}
export async function openEvidence(file, inventory, initial = {}) {
  const report = await readFile(file, 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return {
        ...initial,
        cases: expectedCases(inventory).map((row) => ({
          ...row,
          status: 'unexecuted',
          phase: 'not-started',
          durationMs: 0,
        })),
      };
    });
  const save = async () => {
    report.counts = counts(report.cases);
    await writeJson(file, report);
  };
  return {
    report,
    save,
    async run(id, phase, fn, editorVersion) {
      const row = report.cases.find(
        (value) => value.id === id && value.editorVersion === editorVersion,
      );
      assert(row, 'Use a declared case.');
      assert.equal(row.status, 'unexecuted', 'Run each case once.');
      const started = performance.now();
      row.phase = phase;
      row.stage = phase;
      row.status = 'failed';
      await save();
      try {
        const result = await fn();
        row.status = 'passed';
        row.phase = 'complete';
        return result;
      } catch (error) {
        row.failure = { name: error.name, message: 'Required assertion or operation failed.' };
        throw error;
      } finally {
        row.durationMs = Math.max(0, Math.round(performance.now() - started));
        await save();
      }
    },
  };
}
export function verifyReleaseReport(report, expected) {
  assert(Array.isArray(expected.targets) && expected.targets.length > 0);
  assert(Array.isArray(expected.cases) && expected.cases.length > 0);
  assert.equal(new Set(expected.targets).size, expected.targets.length);
  assert.equal(new Set(expected.cases.map((r) => r.id)).size, expected.cases.length);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.mode, 'release');
  assert.equal(report.status, 'passed');
  assert.equal(report.revision, expected.revision);
  assert.equal(report.candidates.cli.revision, expected.revision);
  assert.equal(report.candidates.vsix.revision, expected.revision);
  assert.equal(report.candidates.cli.sha256, expected.cliSha256);
  assert.equal(report.candidates.vsix.sha256, expected.vsixSha256);
  assert.equal(report.inventoryDigest, expected.inventoryDigest);
  assert.deepEqual(report.seedDigests, expected.seedDigests);
  assert.equal(report.policyDigest, expected.policyDigest);
  assert.deepEqual(report.targets.map((t) => t.target).sort(), [...expected.targets].sort());
  assert.equal(report.cleanup.status, 'passed');
  const wanted = expectedCases(expected.cases).map(caseKey).sort();
  for (const target of report.targets) {
    assert.equal(target.policyDigest, expected.policyDigest);
    assert.equal(target.cleanup.status, 'passed');
    assert.deepEqual(target.editorVersions, EDITORS);
    assert.deepEqual(
      target.cases.map(caseKey).sort(),
      wanted,
      'Require each target/editor case exactly once.',
    );
    assert(
      target.cases.every(
        (r) =>
          r.status === 'passed' &&
          r.phase === 'complete' &&
          Number.isFinite(r.durationMs) &&
          r.durationMs >= 0,
      ),
    );
    assert.deepEqual(target.counts, counts(target.cases));
    assert.match(target.imageId, /^sha256:[a-f0-9]{64}$/u);
    assert.match(target.testImageId, /^sha256:[a-f0-9]{64}$/u);
    assert.match(target.lockfileDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(target.sqliteVersion, /^\d+\.\d+\.\d+/u);
    assert.equal(target.sqliteDriverVersion, '12.4.1');
  }
  assert.deepEqual(report.counts, counts(report.targets.flatMap((t) => t.cases)));
  return true;
}
const xml = (value) =>
  String(value).replace(
    /[&<>"']/gu,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );
export function junit(report) {
  const rows = report.targets.flatMap((t) => t.cases.map((r) => ({ ...r, target: t.target })));
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="backstage-release" tests="${rows.length}" failures="${rows.filter((r) => r.status !== 'passed').length}">\n` +
    rows
      .map(
        (r) =>
          `<testcase classname="${xml(r.target)}" name="${xml(caseKey(r))}" time="${r.durationMs / 1000}">${r.status === 'passed' ? '' : `<failure message="${xml(r.status)}">${xml(r.phase)}</failure>`}</testcase>`,
      )
      .join('\n') +
    '\n</testsuite>\n'
  );
}

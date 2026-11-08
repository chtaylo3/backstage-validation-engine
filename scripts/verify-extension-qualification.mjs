import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  verifyMetrics,
  verifyReport,
  verifyRepetitions,
} from '../.artifacts/vscode/test/qualification.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = process.env.GITHUB_REPOSITORY,
  revision = process.env.GITHUB_SHA;
assert(repository && revision && process.env.GITHUB_RUN_ID);
const exec = promisify(execFile);
const api = async (route) =>
  JSON.parse(
    (await exec('gh', ['api', `repos/${repository}/${route}`], { maxBuffer: 8 * 1024 * 1024 }))
      .stdout,
  );
const output = path.join(root, '.artifacts/vscode/qualification-results.json');
const temporary = await mkdtemp(path.join(tmpdir(), 'bve-release-evidence-'));
const result = {
  revision,
  status: 'running',
  ciRun: null,
  raceRun: null,
  compatibilityRun: Number(process.env.GITHUB_RUN_ID),
  operatingSystems: [],
  remote: [],
  historicalReleaseUpgrade: 'unqualified: fixture predecessor only',
};
const inventory = JSON.parse(
  await readFile(path.join(root, '.artifacts/vscode/test/inventory.json'), 'utf8'),
).map((name) => name.replace(/\.case\.cjs$/u, ''));
const portable = inventory.filter((id) => !/^(compat-|endurance-|remote-)/u.test(id));
const races = inventory.filter((id) => /^(race-|workspace-)/u.test(id));
async function latest(workflow) {
  const runs = await api(`actions/workflows/${workflow}/runs?head_sha=${revision}&per_page=10`);
  const run = runs.workflow_runs.find((value) => value.head_sha === revision);
  assert(
    run && run.conclusion === 'success',
    `Require a successful ${workflow} run at the candidate revision.`,
  );
  return run.id;
}
async function download(id, name) {
  const directory = path.join(temporary, String(id), name);
  await mkdir(directory, { recursive: true });
  await exec(
    'gh',
    ['run', 'download', String(id), '--repo', repository, '--name', name, '--dir', directory],
    { maxBuffer: 8 * 1024 * 1024, timeout: 300_000 },
  );
  return directory;
}
async function files(directory) {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? files(path.join(directory, entry.name))
          : [path.join(directory, entry.name)],
      ),
    )
  ).flat();
}
async function json(directory, suffix) {
  const matches = (await files(directory)).filter((file) =>
    file.replaceAll('\\', '/').endsWith(suffix),
  );
  assert.equal(matches.length, 1, 'One required report: ' + suffix);
  return JSON.parse(await readFile(matches[0], 'utf8'));
}
try {
  result.ciRun = await latest('ci.yml');
  result.raceRun = await latest('vscode-races.yml');
  let linuxChecksum;
  for (const os of ['ubuntu-24.04', 'windows-2025', 'macos-15']) {
    const ci = await download(result.ciRun, 'vscode-' + os);
    const baseline = await json(ci, '/editor-results/results.json');
    const checksum = baseline.metadata.vsixSha256;
    verifyReport(baseline, revision, checksum, portable);
    if (os === 'ubuntu-24.04') linuxChecksum = checksum;
    const failureProof = await json(ci, '/verification-summary.json');
    assert.equal(failureProof.metadata.revision, revision);
    assert.equal(failureProof.metadata.vsixSha256, checksum);
    assert.deepEqual(failureProof.checks.map((row) => row.fault).sort(), [
      'assertion',
      'cleanup',
      'crash',
    ]);
    assert(failureProof.checks.every((row) => row.passed));
    const repeated = await download(result.raceRun, 'vscode-races-' + os);
    const summary = await json(repeated, '/race-summary.json');
    assert.equal(summary.metadata.revision, revision);
    assert.equal(summary.metadata.vsixSha256, checksum);
    verifyRepetitions(summary.repetitions);
    for (let iteration = 1; iteration <= 20; iteration++)
      verifyReport(
        await json(repeated, `/race-results-${iteration}/results.json`),
        revision,
        checksum,
        races,
      );
    const compatibility = await download(result.compatibilityRun, 'vscode-compatibility-' + os);
    verifyReport(
      await json(compatibility, '/compatibility-results/results.json'),
      revision,
      checksum,
      inventory.filter((id) => id.startsWith('compat-')),
    );
    verifyReport(await json(compatibility, '/load-results/results.json'), revision, checksum, [
      'endurance-100',
      'endurance-1000',
      'endurance-saturation',
    ]);
    const soak = await download(result.compatibilityRun, 'vscode-soak-' + os);
    verifyReport(await json(soak, '/soak-results/results.json'), revision, checksum, [
      'endurance-soak',
    ]);
    for (const version of ['1.106.3', '1.145.2'])
      verifyMetrics(await json(soak, `/${version}/endurance-soak/resource-metrics.json`), 7200);
    result.operatingSystems.push({ os, vsixSha256: checksum, status: 'passed' });
  }
  for (const mode of ['ssh-remote', 'dev-container', 'wsl']) {
    const directory = await download(result.compatibilityRun, 'vscode-remote-' + mode);
    const remote = await json(directory, `/${mode}/results.json`);
    assert.equal(remote.status, 'passed');
    assert.equal(remote.revision, revision);
    assert.equal(remote.vsixSha256, linuxChecksum);
    assert.equal(remote.sessions.length, 4);
    assert(
      remote.sessions.every(
        (row) =>
          row.result.exitCode === 0 && !row.result.error && row.progress?.status === 'passed',
      ),
    );
    assert.deepEqual(remote.sessions.map((row) => row.version + '/' + row.stage).sort(), [
      '1.106.3/0',
      '1.106.3/1',
      '1.145.2/0',
      '1.145.2/1',
    ]);
    result.remote.push({ mode, status: 'passed', remoteExtension: remote.remoteExtension });
  }
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = error.stack ?? String(error);
  throw error;
} finally {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

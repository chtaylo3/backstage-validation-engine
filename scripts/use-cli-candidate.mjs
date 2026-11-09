import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyCliArchive } from './cli-candidate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = process.env.GITHUB_REPOSITORY;
const revision = process.env.GITHUB_SHA;
assert(
  repository && /^[0-9a-f]{40}$/u.test(revision ?? ''),
  'Consume an exact GitHub Actions revision.',
);
const exec = promisify(execFile);
const api = async (route) =>
  JSON.parse(
    (
      await exec('gh', ['api', `repos/${repository}/${route}`], {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
      })
    ).stdout,
  );
const deadline = Date.now() + 25 * 60_000;
let selected, run;
while (Date.now() < deadline) {
  const runs = await api(`actions/workflows/ci.yml/runs?head_sha=${revision}&per_page=10`);
  run = runs.workflow_runs.find((value) => value.head_sha === revision);
  if (run) {
    const artifacts = await api(`actions/runs/${run.id}/artifacts?per_page=100`);
    selected = artifacts.artifacts.find(
      (value) => value.name === 'cli-candidate' && !value.expired,
    );
    if (selected?.digest && selected.size_in_bytes > 0) break;
    assert(run.status !== 'completed', 'Candidate CI finished without its CLI archive.');
  }
  await pause(15_000);
}
assert(selected && run, 'The exact-revision CLI artifact did not become available.');
const download = await mkdtemp(path.join(tmpdir(), 'bve-cli-candidate-'));
try {
  await exec(
    'gh',
    [
      'run',
      'download',
      String(run.id),
      '--repo',
      repository,
      '--name',
      selected.name,
      '--dir',
      download,
    ],
    {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 300_000,
      windowsHide: true,
    },
  );
  const files = await readdir(download, { withFileTypes: true });
  const archives = files.filter((file) => file.isFile() && file.name.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'Consume exactly one CLI archive.');
  const source = path.join(download, archives[0].name);
  const metadata = await verifyCliArchive(source, revision);
  assert.equal(
    metadata.packageLockSha256,
    createHash('sha256')
      .update(await readFile(path.join(root, 'package-lock.json')))
      .digest('hex'),
    'The CLI candidate must use the checked-in dependency lock.',
  );
  assert.equal(
    metadata.nodeVersion,
    'v' + (await readFile(path.join(root, '.nvmrc'), 'utf8')).trim(),
  );
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.name, manifest.name);
  assert.equal(metadata.version, manifest.version);
  const directory = path.join(root, '.artifacts/cli');
  await mkdir(directory, { recursive: true });
  const archive = path.join(directory, metadata.filename);
  for (const suffix of ['', '.metadata.json', '.sha256'])
    await cp(source + suffix, archive + suffix);
  await writeFile(
    path.join(directory, 'package-info.json'),
    JSON.stringify(
      {
        archive,
        metadata: archive + '.metadata.json',
        revision,
        sha256: metadata.sha256,
        runId: run.id,
        artifactId: selected.id,
        artifactName: selected.name,
        ciConclusionAtDownload: run.conclusion,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Using CI CLI candidate ${run.id} / ${metadata.sha256}`);
} finally {
  await rm(download, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

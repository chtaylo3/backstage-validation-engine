import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import yauzl from 'yauzl';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const repository = process.env.GITHUB_REPOSITORY;
const revision = process.env.GITHUB_SHA;
assert(repository && revision, 'Consume an exact GitHub Actions revision.');
const os = process.argv.find((value) => value.startsWith('--os='))?.slice(5);
assert(['ubuntu-24.04', 'windows-2025', 'macos-15'].includes(os));
const api = async (route) =>
  JSON.parse(
    (
      await exec('gh', ['api', `repos/${repository}/${route}`], {
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      })
    ).stdout,
  );
const deadline = Date.now() + 25 * 60_000;
let selected, run;
while (Date.now() < deadline) {
  const runs = await api('actions/workflows/ci.yml/runs?head_sha=' + revision + '&per_page=10');
  run = runs.workflow_runs.find((value) => value.head_sha === revision);
  if (run) {
    const artifacts = await api(`actions/runs/${run.id}/artifacts?per_page=100`);
    selected = artifacts.artifacts.find(
      (value) => value.name === 'vscode-candidate-' + os && !value.expired,
    );
    if (selected?.digest && selected.size_in_bytes > 0) break;
    assert(run.status !== 'completed', 'Candidate CI finished without the required OS artifact.');
  }
  await pause(15_000);
}
assert(selected && run, 'The exact-revision candidate artifact did not become available.');
const download = await mkdtemp(path.join(tmpdir(), 'bve-candidate-'));
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
    { maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 300_000 },
  );
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
  const vsixes = (await files(download)).filter((value) => value.endsWith('.vsix'));
  assert.equal(vsixes.length, 1, 'Consume exactly one OS-target product.');
  const source = vsixes[0];
  const digest = createHash('sha256')
    .update(await readFile(source))
    .digest('hex');
  assert.equal(
    (await readFile(source + '.sha256', 'utf8')).split(' ')[0],
    digest,
    'Verify the recorded VSIX checksum.',
  );
  const artifactRoot = path.join(root, '.artifacts/vscode');
  const stage = path.join(artifactRoot, 'stage');
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const archive = await new Promise((resolve, reject) =>
    yauzl.open(source, { lazyEntries: true, validateEntrySizes: true }, (error, zip) =>
      error ? reject(error) : resolve(zip),
    ),
  );
  let count = 0,
    bytes = 0;
  await new Promise((resolve, reject) => {
    archive.on('error', reject);
    archive.on('end', resolve);
    archive.on('entry', (entry) => {
      void (async () => {
        assert(
          ++count <= 20_000 && (bytes += entry.uncompressedSize) <= 1024 * 1024 * 1024,
          'Bound candidate extraction.',
        );
        if (!entry.fileName.startsWith('extension/')) {
          archive.readEntry();
          return;
        }
        const relative = entry.fileName.slice('extension/'.length);
        assert(
          !relative.includes('\\') &&
            !relative.includes('\0') &&
            !relative.split('/').includes('..'),
        );
        assert.notEqual(
          (entry.externalFileAttributes >>> 16) & 0o170000,
          0o120000,
          'No archive symlinks.',
        );
        const destination = path.resolve(stage, relative);
        assert(destination === stage || destination.startsWith(stage + path.sep));
        if (entry.fileName.endsWith('/')) await mkdir(destination, { recursive: true });
        else {
          await mkdir(path.dirname(destination), { recursive: true });
          const stream = await new Promise((accept, fail) =>
            archive.openReadStream(entry, (error, value) => (error ? fail(error) : accept(value))),
          );
          await pipeline(stream, createWriteStream(destination));
        }
        archive.readEntry();
      })().catch((error) => {
        archive.close();
        reject(error);
      });
    });
    archive.readEntry();
  });
  const build = JSON.parse(await readFile(path.join(stage, 'build-info.json'), 'utf8'));
  assert.equal(build.revision, revision);
  assert.equal(build.target, `${process.platform}-${process.arch}`);
  const runtime = path.join(stage, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  assert.equal(
    createHash('sha256')
      .update(await readFile(runtime))
      .digest('hex'),
    build.nodeSha256,
  );
  if (process.platform !== 'win32') await chmod(runtime, 0o755);
  const vsix = path.join(artifactRoot, path.basename(source));
  await cp(source, vsix);
  await cp(source + '.sha256', vsix + '.sha256');
  const manifest = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'));
  await writeFile(
    path.join(artifactRoot, 'package-info.json'),
    JSON.stringify(
      {
        vsix,
        stage,
        target: build.target,
        version: manifest.version,
        bytes: (await readFile(vsix)).length,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    path.join(artifactRoot, 'candidate-provenance.json'),
    JSON.stringify(
      {
        revision,
        runId: run.id,
        artifactId: selected.id,
        artifactName: selected.name,
        vsixSha256: digest,
        ciConclusionAtDownload: run.conclusion,
        build,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Using CI candidate ${run.id} / ${selected.name} / ${digest}`);
} finally {
  await rm(download, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

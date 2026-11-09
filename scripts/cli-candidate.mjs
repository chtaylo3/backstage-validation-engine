import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = /^[0-9a-f]{40}$/u;
const checksum = /^[0-9a-f]{64}$/u;
const packageFile =
  /^(?:package\.json|npm-shrinkwrap\.json|README\.md|LICENSE|(?:dist|src|schemas)\/.+)$/u;

export function verifyCliMetadata(metadata, revision, { allowDirty = false } = {}) {
  assert.equal(metadata.schemaVersion, 1, 'Use the supported CLI candidate metadata format.');
  assert(sha.test(revision), 'Use an exact candidate commit.');
  assert.equal(metadata.revision, revision, 'The CLI candidate must match the requested revision.');
  assert(checksum.test(metadata.sha256), 'The CLI candidate must record a SHA-256 digest.');
  assert(
    checksum.test(metadata.packageLockSha256),
    'The CLI candidate must record its dependency lock.',
  );
  assert.equal(typeof metadata.sourceDirty, 'boolean');
  if (!allowDirty)
    assert.equal(
      metadata.sourceDirty,
      false,
      'A release candidate cannot contain uncommitted inputs.',
    );
  assert(/^v24\.\d+\.\d+$/u.test(metadata.nodeVersion), 'Record the pinned Node 24 runtime.');
  assert.equal(typeof metadata.filename, 'string');
  assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u.test(metadata.filename), 'Use one archive basename.');
  assert(Array.isArray(metadata.files) && metadata.files.length > 0);
  assert.equal(
    new Set(metadata.files).size,
    metadata.files.length,
    'Package entries cannot repeat.',
  );
  for (const file of metadata.files) {
    assert.equal(typeof file, 'string');
    assert(packageFile.test(file), 'The CLI candidate cannot contain development infrastructure.');
    assert(
      !file.includes('\\') &&
        !file.split('/').some((part) => !part || part === '..' || part === '.'),
    );
  }
  for (const required of ['package.json', 'npm-shrinkwrap.json', 'dist/cli/main.js'])
    assert(
      metadata.files.includes(required),
      'The CLI candidate is missing a required package entry.',
    );
  return metadata;
}

export async function verifyCliArchive(archive, revision, options) {
  const metadata = verifyCliMetadata(
    JSON.parse(await readFile(archive + '.metadata.json', 'utf8')),
    revision,
    options,
  );
  assert.equal(path.basename(archive), metadata.filename);
  assert.equal(
    digest(await readFile(archive)),
    metadata.sha256,
    'The CLI archive digest must match.',
  );
  const sidecar = (await readFile(archive + '.sha256', 'utf8')).trim();
  assert.equal(
    sidecar,
    `${metadata.sha256}  ${metadata.filename}`,
    'Verify the CLI checksum sidecar.',
  );
  return metadata;
}

export async function packageCliCandidate(
  root,
  output = path.join(root, '.artifacts/cli'),
  environment = process.env,
) {
  const npm = environment.npm_execpath;
  assert(npm, 'Package through npm run cli:package so the pinned npm CLI is available.');
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  assert(sha.test(revision), 'Package from a Git checkout with an exact revision.');
  if (environment.GITHUB_SHA)
    assert.equal(
      environment.GITHUB_SHA,
      revision,
      'The workflow and checkout revisions must match.',
    );
  const nodeVersion = (await readFile(path.join(root, '.nvmrc'), 'utf8')).trim();
  assert.equal(process.version, `v${nodeVersion}`, 'Package with the pinned Node runtime.');
  const inputPaths = [
    'package.json',
    'package-lock.json',
    '.nvmrc',
    '.npmrc',
    '.dockerignore',
    '.gitattributes',
    'tsconfig.json',
    'tsconfig.build.json',
    'tsconfig.test.json',
    'src',
    'schemas',
    'README.md',
    'LICENSE',
    'scripts',
    'test/integration/backstage',
    'extensions',
    '.github/workflows',
  ];
  const status = (
    await exec('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...inputPaths], {
      cwd: root,
    })
  ).stdout;
  const sourceDirty = status.trim().length > 0;
  if (environment.GITHUB_ACTIONS)
    assert.equal(sourceDirty, false, 'Hosted CLI candidates require clean source inputs.');
  const lock = await readFile(path.join(root, 'package-lock.json'));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const stage = await mkdtemp(path.join(tmpdir(), 'bve-cli-package-'));
  await mkdir(output, { recursive: true });
  try {
    for (const name of ['package.json', 'README.md', 'LICENSE', 'dist', 'src', 'schemas'])
      await cp(path.join(root, name), path.join(stage, name), { recursive: true });
    assert(Array.isArray(manifest.files), 'Use the explicit production package inventory.');
    await writeFile(
      path.join(stage, 'package.json'),
      JSON.stringify(
        { ...manifest, files: [...new Set([...manifest.files, 'npm-shrinkwrap.json'])] },
        null,
        2,
      ) + '\n',
    );
    // npm publishes shrinkwrap files and honors them when installing a tarball dependency.
    // Keep the exact checked-in graph, including platform and optional dependency metadata.
    await writeFile(path.join(stage, 'npm-shrinkwrap.json'), lock);
    const packed = JSON.parse(
      (
        await exec(
          process.execPath,
          [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', output],
          { cwd: stage, env: environment, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
        )
      ).stdout,
    );
    assert.equal(packed.length, 1, 'Produce one CLI archive.');
    const pack = packed[0];
    assert.equal(pack.name, manifest.name);
    assert.equal(pack.version, manifest.version);
    assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u.test(pack.filename));
    const archive = path.join(output, pack.filename);
    const metadata = {
      schemaVersion: 1,
      revision,
      sha256: digest(await readFile(archive)),
      nodeVersion: process.version,
      files: pack.files.map((file) => file.path).sort(),
      name: manifest.name,
      version: manifest.version,
      filename: pack.filename,
      sourceDirty,
      packageLockSha256: digest(lock),
    };
    // Dirty local packages are useful for development, but never qualify as release candidates.
    verifyCliMetadata(metadata, revision, { allowDirty: true });
    await writeFile(archive + '.metadata.json', JSON.stringify(metadata, null, 2) + '\n');
    await writeFile(archive + '.sha256', `${metadata.sha256}  ${metadata.filename}\n`);
    await writeFile(
      path.join(output, 'package-info.json'),
      JSON.stringify({ archive, metadata: archive + '.metadata.json', ...metadata }, null, 2) +
        '\n',
    );
    return { archive, metadata };
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

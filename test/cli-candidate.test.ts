import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

interface Metadata {
  schemaVersion: number;
  revision: string;
  sha256: string;
  nodeVersion: string;
  files: string[];
  filename: string;
  sourceDirty: boolean;
  packageLockSha256: string;
}
const { packageCliCandidate, verifyCliArchive, verifyCliMetadata } = (await import(
  pathToFileURL(path.resolve('scripts/cli-candidate.mjs')).href
)) as {
  packageCliCandidate: (
    root: string,
    output: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<{ archive: string; metadata: Metadata }>;
  verifyCliArchive: (
    archive: string,
    revision: string,
    options?: { allowDirty: boolean },
  ) => Promise<Metadata>;
  verifyCliMetadata: (metadata: Metadata, revision: string) => Metadata;
};
const revision = 'a'.repeat(40);
const metadata = (): Metadata => ({
  schemaVersion: 1,
  revision,
  sha256: 'b'.repeat(64),
  packageLockSha256: 'c'.repeat(64),
  nodeVersion: 'v24.22.1',
  filename: 'fixture-1.0.0.tgz',
  sourceDirty: false,
  files: ['package.json', 'npm-shrinkwrap.json', 'dist/cli/main.js'],
});

void test('CLI candidates require exact revision, clean inputs, dependency lock and production inventory', () => {
  verifyCliMetadata(metadata(), revision);
  const changes: ((row: Metadata) => void)[] = [
    (row) => {
      row.schemaVersion = 2;
    },
    (row) => {
      row.revision = 'd'.repeat(40);
    },
    (row) => {
      row.sourceDirty = true;
    },
    (row) => {
      row.sha256 = 'unverified';
    },
    (row) => {
      row.packageLockSha256 = '';
    },
    (row) => {
      row.filename = '../fixture.tgz';
    },
    (row) => {
      row.files.push('test/integration/backstage/app-config.yaml');
    },
    (row) => {
      row.files.push('dist/../secret');
    },
    (row) => {
      row.files.push('dist//secret');
    },
    (row) => {
      row.files.push('dist/cli/main.js');
    },
    (row) => {
      row.files = row.files.filter((file) => file !== 'npm-shrinkwrap.json');
    },
  ];
  for (const change of changes) {
    const row = metadata();
    change(row);
    assert.throws(() => verifyCliMetadata(row, revision));
  }
});

function tarFile(bytes: Buffer, name: string): Buffer {
  const tar = gunzipSync(bytes);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const entry = header.subarray(0, 100).toString().split('\0')[0];
    const size = parseInt(
      header.subarray(124, 136).toString().replace(/\0/gu, '').trim() || '0',
      8,
    );
    if (entry === name) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Missing tar entry: ' + name);
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'bve CLI candidate é '));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const directory of ['dist/cli', 'src', 'schemas', 'test/integration/backstage'])
    await mkdir(path.join(root, directory), { recursive: true });
  const manifest = {
    name: 'bve-cli-fixture',
    version: '1.0.0',
    private: true,
    files: ['dist', 'src', 'schemas', 'README.md', 'LICENSE'],
    bin: { 'bve-fixture': './dist/cli/main.js' },
  };
  const lock =
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages: { '': { name: manifest.name, version: manifest.version, bin: manifest.bin } },
    }) + '\n';
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify(manifest),
    'package-lock.json': lock,
    '.nvmrc': process.version.slice(1),
    '.npmrc': 'ignore-scripts=true\n',
    '.dockerignore': 'node_modules\n',
    '.gitattributes': '* text=auto\n',
    'tsconfig.json': '{}\n',
    'tsconfig.build.json': '{}\n',
    'tsconfig.test.json': '{}\n',
    'README.md': 'Fixture\n',
    LICENSE: 'Fixture license\n',
    'dist/cli/main.js': '#!/usr/bin/env node\nconsole.log("fixture CLI");\n',
    'src/index.ts': 'export {};\n',
    'schemas/fixture.json': '{}\n',
    'test/integration/backstage/secret.json': '{"token":"must-not-ship"}\n',
  }))
    await writeFile(path.join(root, name), content);
  const exec = promisify(execFile);
  await exec('git', ['init', '--quiet'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=' + path.join(root, '.git/hooks-disabled'),
      'commit',
      '--quiet',
      '-m',
      'Fixture',
    ],
    { cwd: root },
  );
  const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.GITHUB_ACTIONS;
  delete environment.GITHUB_SHA;
  if (!environment.npm_execpath) {
    for (const candidate of [
      path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    ]) {
      if (
        await access(candidate).then(
          () => true,
          () => false,
        )
      ) {
        environment.npm_execpath = candidate;
        break;
      }
    }
  }
  environment.npm_config_cache = path.join(root, '.npm-cache');
  return { root, lock, commit, environment, exec };
}

void test('real CLI packaging embeds the unchanged transitive lock, excludes test infrastructure and installs offline', async (t) => {
  const { root, lock, commit, environment, exec } = await fixture(t);
  const { archive, metadata: row } = await packageCliCandidate(
    root,
    path.join(root, '.artifacts/cli'),
    environment,
  );
  assert.equal(row.sourceDirty, false);
  assert.equal(row.revision, commit);
  assert.equal(row.packageLockSha256, createHash('sha256').update(lock).digest('hex'));
  assert.equal(tarFile(await readFile(archive), 'package/npm-shrinkwrap.json').toString(), lock);
  assert(row.files.every((file) => !file.startsWith('test/')));
  assert.deepEqual(await verifyCliArchive(archive, commit), row);
  const install = path.join(root, 'consumer');
  await mkdir(install);
  await writeFile(path.join(install, 'package.json'), '{"private":true}\n');
  const npm = environment.npm_execpath;
  assert(npm);
  await exec(
    process.execPath,
    [
      npm,
      'install',
      '--offline',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      archive,
    ],
    { cwd: install, env: environment, timeout: 20_000 },
  );
  const result = await exec(process.execPath, [
    path.join(install, 'node_modules/bve-cli-fixture/dist/cli/main.js'),
  ]);
  assert.equal(result.stdout.trim(), 'fixture CLI');
  await writeFile(archive, 'corrupt archive');
  await assert.rejects(verifyCliArchive(archive, commit), /digest/u);
});

void test('hosted packaging rejects changed sources and a workflow revision different from checkout', async (t) => {
  const { root, commit, environment } = await fixture(t);
  const output = path.join(root, '.artifacts/cli');
  await assert.rejects(
    packageCliCandidate(root, output, { ...environment, GITHUB_SHA: revision }),
    /revisions/u,
  );
  for (const name of [
    'tsconfig.json',
    'tsconfig.build.json',
    'tsconfig.test.json',
    '.dockerignore',
    '.npmrc',
    '.gitattributes',
  ]) {
    const file = path.join(root, name);
    const original = await readFile(file);
    await writeFile(file, 'changed build configuration\n');
    await assert.rejects(
      packageCliCandidate(root, output, {
        ...environment,
        GITHUB_SHA: commit,
        GITHUB_ACTIONS: 'true',
      }),
      /clean/u,
    );
    await writeFile(file, original);
  }
  await writeFile(path.join(root, 'src/index.ts'), 'export const changed = true;\n');
  await assert.rejects(
    packageCliCandidate(root, output, {
      ...environment,
      GITHUB_SHA: commit,
      GITHUB_ACTIONS: 'true',
    }),
    /clean/u,
  );
  const local = await packageCliCandidate(root, output, environment);
  assert.equal(local.metadata.sourceDirty, true);
  await assert.rejects(verifyCliArchive(local.archive, commit), /uncommitted/u);
  assert.equal(
    (await verifyCliArchive(local.archive, commit, { allowDirty: true })).sourceDirty,
    true,
  );
});

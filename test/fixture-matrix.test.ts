import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { loadContractArtifact } from './harness/contract-artifact.js';
import type { ContractArtifact } from './harness/contract-artifact.js';
import { startFixtureMatrix } from './harness/fixture-matrix.js';
import { createFixtureMatrix } from './harness/version-matrix.js';
import type { BackstageRelease } from './harness/version-matrix.js';

// Deliberately synthetic: these numbers do not declare real Backstage support.
const SPEC = 'openapi: 3.1.0\ninfo: { title: synthetic, version: "1" }\npaths: {}\n';
const specFor = (version: string) => `${SPEC}# Synthetic release ${version}\n`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function release(version: string, text = specFor(version)): BackstageRelease {
  return {
    backstageVersion: version,
    catalogBackendVersion: '7.8.9',
    catalogModelVersion: '3.2.1',
    sourceCommit: 'a'.repeat(40),
    openApi: { path: `${version}/openapi.yaml`, sha256: sha256(text) },
  };
}

async function prepare(t: TestContext, releases: readonly BackstageRelease[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'bve-matrix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const entry of releases) {
    const destination = path.join(root, entry.openApi.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, specFor(entry.backstageVersion));
  }
  return root;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

void test('matrix selects latest numeric patch in each explicit minor across concurrent majors', () => {
  const matrix = createFixtureMatrix({
    supportedMinors: ['2.10', '1.10', '2.4', '1.2'],
    releases: ['2.4.1', '1.2.9', '1.10.2', '2.10.0', '1.2.10', '1.10.10', '2.4.0', '3.0.99'].map(
      (version) => release(version),
    ),
  });
  assert.deepEqual(
    matrix.map((entry) => entry.backstageVersion),
    ['1.2.10', '1.10.10', '2.4.1', '2.10.0'],
  );
  assert.deepEqual(
    matrix.map((entry) => entry.minorLine),
    ['1.2', '1.10', '2.4', '2.10'],
  );
  // Package major/minor versions are independent of the umbrella release.
  assert(matrix.every((entry) => entry.catalogBackendVersion === '7.8.9'));
});

void test('inventory refresh advances only the affected minor and never fills a missing line', () => {
  const input = { supportedMinors: ['1.2', '2.3'], releases: [release('1.2.1'), release('2.3.4')] };
  const initial = createFixtureMatrix(input);
  const refreshed = createFixtureMatrix({
    ...input,
    releases: [...input.releases, release('1.2.12')],
  });
  assert.deepEqual(
    initial.map((entry) => entry.backstageVersion),
    ['1.2.1', '2.3.4'],
  );
  assert.deepEqual(
    refreshed.map((entry) => entry.backstageVersion),
    ['1.2.12', '2.3.4'],
  );
  assert.throws(
    () => createFixtureMatrix({ ...input, supportedMinors: ['1.3'] }),
    /No stable release/,
  );
});

void test('matrix copies and freezes selected metadata without modifying caller inventory', () => {
  const entry = { ...release('1.2.3'), openApi: { ...release('1.2.3').openApi } };
  const matrix = createFixtureMatrix({ supportedMinors: ['1.2'], releases: [entry] });
  entry.openApi.path = 'changed.yaml';
  assert.equal(matrix[0]?.openApi.path, '1.2.3/openapi.yaml');
  assert(Object.isFrozen(matrix));
  assert(Object.isFrozen(matrix[0]));
  assert(Object.isFrozen(matrix[0]?.openApi));
});

void test('matrix rejects ambiguous, unstable, malformed and incomplete inventories', async (t) => {
  const valid = { supportedMinors: ['1.2'], releases: [release('1.2.3')] };
  const cases = [
    { ...valid, supportedMinors: [] },
    { ...valid, supportedMinors: ['1.2', '1.2'] },
    { ...valid, supportedMinors: ['1.02'] },
    { ...valid, supportedMinors: ['1'] },
    { ...valid, releases: [release('1.2.3'), release('1.2.3')] },
    { ...valid, releases: [release('1.2.4-rc.1')] },
    { ...valid, releases: [release('1.2.3+build')] },
    { ...valid, releases: [release('v1.2.3')] },
    { ...valid, releases: [release('1.2.03')] },
    { ...valid, releases: [release('1.2.9007199254740992')] },
    { ...valid, releases: [{ ...release('1.2.3'), catalogBackendVersion: 'latest' }] },
    { ...valid, releases: [{ ...release('1.2.3'), catalogModelVersion: '3.2' }] },
    { ...valid, releases: [{ ...release('1.2.3'), sourceCommit: 'master' }] },
    {
      ...valid,
      releases: [{ ...release('1.2.3'), openApi: { path: '', sha256: 'b'.repeat(64) } }],
    },
    {
      ...valid,
      releases: [{ ...release('1.2.3'), openApi: { path: 'api.yaml', sha256: 'wrong' } }],
    },
  ];
  for (const [index, input] of cases.entries()) {
    await t.test(`invalid inventory ${index + 1}`, () => {
      assert.throws(() => createFixtureMatrix(input));
    });
  }
});

void test('artifact verification uses exact bytes and fails after contract drift', async (t) => {
  const entries = [release('1.2.3')];
  const root = await prepare(t, entries);
  const [target] = createFixtureMatrix({ supportedMinors: ['1.2'], releases: entries });
  assert(target);
  const artifact = await loadContractArtifact(target, root);
  assert.equal(artifact.text, specFor('1.2.3'));
  assert(Object.isFrozen(artifact));
  await writeFile(path.join(root, target.openApi.path), specFor('1.2.3').replaceAll('\n', '\r\n'));
  await assert.rejects(loadContractArtifact(target, root), /checksum mismatch/);
});

void test('artifact loading rejects traversal and absolute paths on either OS convention', async (t) => {
  const root = await prepare(t, []);
  const [base] = createFixtureMatrix({ supportedMinors: ['1.2'], releases: [release('1.2.3')] });
  assert(base);
  for (const artifactPath of ['../api.yaml', '/api.yaml', 'C:\\api.yaml', '..\\api.yaml']) {
    await assert.rejects(
      loadContractArtifact({ ...base, openApi: { ...base.openApi, path: artifactPath } }, root),
      /relative/,
    );
  }
});

void test(
  'artifact loading rejects a symlink outside the artifact root',
  { skip: process.platform === 'win32' },
  async (t) => {
    const outer = await prepare(t, []);
    const root = path.join(outer, 'artifacts');
    await mkdir(root);
    await writeFile(path.join(outer, 'outside.yaml'), SPEC);
    await symlink(path.join(outer, 'outside.yaml'), path.join(root, 'link.yaml'));
    const [base] = createFixtureMatrix({ supportedMinors: ['1.2'], releases: [release('1.2.3')] });
    assert(base);
    await assert.rejects(
      loadContractArtifact({ ...base, openApi: { ...base.openApi, path: 'link.yaml' } }, root),
      /inside/,
    );
  },
);

// An HTTP lifecycle probe, not an implementation of the Backstage API.
async function startProbe(artifact: ContractArtifact) {
  let value = 'initial';
  let closeCount = 0;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: artifact.target.backstageVersion, value }));
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setValue(next: string) {
      value = next;
    },
    get closeCount() {
      return closeCount;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        closeCount++;
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

void test('concurrent minor/major fixtures have isolated HTTP ports/state and idempotent cleanup', async (t) => {
  const entries = [release('1.2.3'), release('1.4.5'), release('2.1.0')];
  const root = await prepare(t, entries);
  const targets = createFixtureMatrix({
    supportedMinors: ['1.2', '1.4', '2.1'],
    releases: entries,
  });
  const allEntered = gate();
  let entered = 0;
  const matrix = await startFixtureMatrix(targets, root, async (artifact) => {
    assert.equal(artifact.text, specFor(artifact.target.backstageVersion));
    if (++entered === targets.length) allEntered.release();
    await allEntered.promise; // Serial startup would deadlock and fail the test timeout.
    return startProbe(artifact);
  });
  t.after(() => matrix.close());
  assert.equal(new Set(matrix.fixtures.map(({ fixture }) => fixture.baseUrl)).size, targets.length);
  matrix.fixtures[0]!.fixture.setValue('changed');
  const results: unknown[] = await Promise.all(
    matrix.fixtures.map(async ({ fixture }) => {
      const response = await fetch(fixture.baseUrl);
      return response.json();
    }),
  );
  assert.deepEqual(results, [
    { version: '1.2.3', value: 'changed' },
    { version: '1.4.5', value: 'initial' },
    { version: '2.1.0', value: 'initial' },
  ]);
  await Promise.all([matrix.close(), matrix.close()]);
  assert(matrix.fixtures.every(({ fixture }) => fixture.closeCount === 1));
});

void test('invalid contracts prevent startup for the entire matrix', async (t) => {
  const entries = [release('1.2.3'), release('2.1.0')];
  const root = await prepare(t, entries);
  await writeFile(path.join(root, entries[1]!.openApi.path), 'tampered');
  const targets = createFixtureMatrix({ supportedMinors: ['1.2', '2.1'], releases: entries });
  let started = 0;
  await assert.rejects(
    startFixtureMatrix(targets, root, () => {
      started++;
      return Promise.resolve({ close: () => Promise.resolve() });
    }),
    /contract loading failed/,
  );
  assert.equal(started, 0);
});

void test('a missing latest-patch artifact never falls back to an older available patch', async (t) => {
  const older = release('1.2.9');
  const latest = release('1.2.10');
  const root = await prepare(t, [older]);
  const targets = createFixtureMatrix({ supportedMinors: ['1.2'], releases: [older, latest] });
  assert.equal(targets[0]?.backstageVersion, '1.2.10');
  let started = false;
  await assert.rejects(
    startFixtureMatrix(targets, root, () => {
      started = true;
      return Promise.resolve({ close: () => Promise.resolve() });
    }),
    /contract loading failed/,
  );
  assert.equal(started, false);
});

void test('partial startup waits for in-flight successes and cleans every successful fixture', async (t) => {
  const entries = [release('1.2.3'), release('2.1.0')];
  const root = await prepare(t, entries);
  const targets = createFixtureMatrix({ supportedMinors: ['1.2', '2.1'], releases: entries });
  const failureReached = gate();
  let closed = 0;
  await assert.rejects(
    startFixtureMatrix(targets, root, async (artifact) => {
      if (artifact.target.minorLine === '2.1') {
        failureReached.release();
        throw new Error('startup fault');
      }
      await failureReached.promise;
      return {
        close: () => {
          closed++;
          return Promise.resolve();
        },
      };
    }),
    (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      return true;
    },
  );
  assert.equal(closed, 1);
});

void test('cleanup attempts all fixtures and reports failures without closing twice', async (t) => {
  const entries = [release('1.2.3'), release('2.1.0')];
  const root = await prepare(t, entries);
  const targets = createFixtureMatrix({ supportedMinors: ['1.2', '2.1'], releases: entries });
  const closed: string[] = [];
  const matrix = await startFixtureMatrix(targets, root, (artifact) =>
    Promise.resolve({
      close: () => {
        closed.push(artifact.target.minorLine);
        if (artifact.target.minorLine === '1.2') throw new Error('cleanup fault');
        return Promise.resolve();
      },
    }),
  );
  await assert.rejects(matrix.close(), /cleanup failed/);
  await assert.rejects(matrix.close(), /cleanup failed/);
  assert.deepEqual(closed.sort(), ['1.2', '2.1']);
});

void test('empty and duplicate minor fixture matrices fail before starting servers', async () => {
  const targets = createFixtureMatrix({ supportedMinors: ['1.2'], releases: [release('1.2.3')] });
  const start = () => Promise.resolve({ close: () => Promise.resolve() });
  await assert.rejects(startFixtureMatrix([], '.', start), /empty/);
  await assert.rejects(startFixtureMatrix([...targets, ...targets], '.', start), /one target/);
});

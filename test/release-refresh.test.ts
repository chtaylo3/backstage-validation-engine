import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadContractArtifact } from './harness/contract-artifact.js';
import {
  loadPinnedMatrix,
  parsePinnedInventory,
  parseSupportConfiguration,
} from './harness/pinned-matrix.js';
import {
  RELEASE_INDEX,
  refreshReleaseInventory,
  sameReleaseInventory,
  saveReleaseInventory,
} from './harness/release-refresh.js';

const commit = 'c'.repeat(40);
const spec = 'openapi: 3.1.0\ninfo: { title: synthetic, version: "1" }\npaths: {}\n';
const entry = (tag_name: string, prerelease = false) => ({ tag_name, prerelease, draft: false });
function upstream(options: { failSpec?: boolean; badCommit?: boolean; tagDepth?: number } = {}) {
  const requested: string[] = [];
  const fetcher = (url: string): Promise<Response> => {
    requested.push(url);
    let data: unknown;
    if (url === `${RELEASE_INDEX}?per_page=100&page=1`) {
      data = [
        entry('v1.2.9'),
        entry('v2.3.1'),
        entry('v1.2.99', true),
        entry('v2.3.99-next.0'),
        ...Array.from({ length: 96 }, () => entry('ignored', true)),
      ];
    } else if (url === `${RELEASE_INDEX}?per_page=100&page=2`) {
      data = [entry('v1.2.10'), entry('v2.3.0'), entry('v3.0.1')];
    } else if (url.includes('/git/ref/tags/')) {
      data = {
        object: {
          type: options.tagDepth === 0 ? 'commit' : 'tag',
          sha: options.tagDepth === 0 ? commit : 'a'.repeat(40),
        },
      };
    } else if (url.includes('/git/tags/')) {
      const depth = requested.filter((value) => value.includes('/git/tags/')).length;
      data = {
        object:
          depth < (options.tagDepth ?? 1)
            ? { type: 'tag', sha: String(depth).repeat(40) }
            : { type: 'commit', sha: options.badCommit ? '../bad' : commit },
      };
    } else if (url.endsWith('/package.json')) {
      data = { version: url.includes('catalog-backend') ? '4.0.2' : '1.10.2' };
    } else if (url.endsWith('/openapi.yaml')) {
      return Promise.resolve(new Response(spec, { status: options.failSpec ? 503 : 200 }));
    } else if (url.endsWith('/LICENSE')) {
      return Promise.resolve(new Response('Synthetic test license\n'));
    } else throw new Error(`Unexpected test URL: ${url}`);
    return Promise.resolve(Response.json(data));
  };
  return { fetcher, requested };
}

void test('release refresh paginates completely, excludes previews, resolves annotated tags and selects latest patches', async () => {
  const remote = upstream();
  const result = await refreshReleaseInventory(
    ['2.3', '1.2'],
    remote.fetcher,
    '2026-10-28T12:00:00Z',
  );
  assert.deepEqual(result.inventory.observedVersions, ['1.2.9', '1.2.10', '2.3.0', '2.3.1']);
  assert.deepEqual(
    result.inventory.releases.map((release) => release.backstageVersion),
    ['1.2.10', '2.3.1'],
  );
  assert(
    result.inventory.releases.every(
      (release) => release.sourceCommit === commit && release.catalogBackendVersion === '4.0.2',
    ),
  );
  assert.equal(result.artifacts.length, 4);
  assert(remote.requested.some((url) => url.endsWith('page=2')));
  assert(!remote.requested.some((url) => url.includes('/git/ref/tags/v1.2.9')));
});

void test('drift comparison ignores capture time and ordering but detects package and source changes', async () => {
  const { inventory } = await refreshReleaseInventory(['1.2', '2.3'], upstream().fetcher);
  assert(
    sameReleaseInventory(inventory, {
      ...inventory,
      refreshedAt: '2026-10-28T23:59:59Z',
      supportedMinors: [...inventory.supportedMinors].reverse(),
      releases: [...inventory.releases].reverse(),
    }),
  );
  assert(
    !sameReleaseInventory(inventory, {
      ...inventory,
      releases: inventory.releases.map((release, index) =>
        index === 0 ? { ...release, catalogBackendVersion: '4.0.3' } : release,
      ),
    }),
  );
  assert(
    !sameReleaseInventory(inventory, {
      ...inventory,
      releases: inventory.releases.map((release, index) =>
        index === 0 ? { ...release, sourceCommit: 'd'.repeat(40) } : release,
      ),
    }),
  );
});

void test('refresh materializes verified offline artifacts and detects support-policy drift', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'bve-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await refreshReleaseInventory(['1.2', '2.3'], upstream().fetcher);
  await writeFile(
    path.join(root, 'support.json'),
    JSON.stringify({ supportedMinors: ['1.2', '2.3'] }),
  );
  await saveReleaseInventory(root, result);
  await saveReleaseInventory(root, result);
  const targets = await loadPinnedMatrix(root);
  assert.deepEqual(
    targets.map((target) => target.backstageVersion),
    ['1.2.10', '2.3.1'],
  );
  for (const target of targets) assert.equal((await loadContractArtifact(target, root)).text, spec);
  const original = await readFile(path.join(root, 'inventory.json'), 'utf8');
  await assert.rejects(
    saveReleaseInventory(root, { ...result, artifacts: result.artifacts.slice(1) }),
    /Incomplete/,
  );
  await assert.rejects(
    saveReleaseInventory(root, {
      ...result,
      artifacts: result.artifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, bytes: Buffer.from('tampered') } : artifact,
      ),
    }),
    /checksum/,
  );
  await writeFile(path.join(root, targets[0]!.openApi.path), 'changed existing artifact');
  await assert.rejects(saveReleaseInventory(root, result), /refusing to overwrite/);
  assert.equal(await readFile(path.join(root, 'inventory.json'), 'utf8'), original);
  await writeFile(path.join(root, 'support.json'), JSON.stringify({ supportedMinors: ['1.2'] }));
  await assert.rejects(loadPinnedMatrix(root), /differs/);
});

void test('upstream failures leave the existing pinned inventory unchanged', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'bve-refresh-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'inventory.json');
  await writeFile(manifest, 'existing inventory');
  await assert.rejects(
    refreshReleaseInventory(['1.2'], upstream({ failSpec: true }).fetcher),
    /503/,
  );
  assert.equal(await readFile(manifest, 'utf8'), 'existing inventory');
  await assert.rejects(
    refreshReleaseInventory(['1.2'], upstream({ badCommit: true }).fetcher),
    /commit/,
  );
});

void test('pinned inventory cannot hide a newer observed patch, retain older patches, or omit a supported minor', async () => {
  const { inventory } = await refreshReleaseInventory(['1.2', '2.3'], upstream().fetcher);
  assert.throws(
    () =>
      parsePinnedInventory({
        ...inventory,
        observedVersions: [...inventory.observedVersions, '1.2.11'],
      }),
    /latest observed/,
  );
  assert.throws(
    () =>
      parsePinnedInventory({
        ...inventory,
        releases: [...inventory.releases, { ...inventory.releases[0]!, backstageVersion: '1.2.9' }],
      }),
    /latest observed/,
  );
  assert.throws(
    () =>
      parsePinnedInventory({
        ...inventory,
        supportedMinors: [...inventory.supportedMinors, '3.1'],
      }),
    /No stable release/,
  );
  assert.throws(() => parsePinnedInventory({ ...inventory, schemaVersion: 2 }), /Invalid/);
  assert.throws(
    () => parsePinnedInventory({ ...inventory, refreshedAt: 'invalid' }),
    /refresh time/,
  );
  assert.throws(() => parseSupportConfiguration({ supportedMinors: ['1.2', '1.2'] }), /Invalid/);
});

void test('release refresh accepts lightweight tags and four annotated links but rejects a fifth link', async () => {
  for (const depth of [0, 2, 4]) {
    const remote = upstream({ tagDepth: depth });
    const result = await refreshReleaseInventory(['1.2'], remote.fetcher);
    assert.equal(result.inventory.releases[0]?.sourceCommit, commit);
    assert.equal(remote.requested.filter((url) => url.includes('/git/tags/')).length, depth);
  }
  const remote = upstream({ tagDepth: 5 });
  await assert.rejects(
    refreshReleaseInventory(['1.2'], remote.fetcher),
    /Release tag did not resolve to a commit/,
  );
  assert.equal(remote.requested.filter((url) => url.includes('/git/tags/')).length, 4);
  assert(!remote.requested.some((url) => url.endsWith('/openapi.yaml')));
});

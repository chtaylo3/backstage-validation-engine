import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ContractError,
  createDataSnapshot,
  createSourceSnapshot,
  overlaySourceSnapshot,
  parseContract,
} from '../../src/index.js';
import { NOW, URI } from '../helpers.js';

const baseInput = {
  repository: 'https://github.com/example/application',
  revision: 'revision-1',
  files: [{ uri: URI, text: 'kind: Component\n' }],
};

void test('source identity is independent of input file order and includes document version', () => {
  const second = { uri: 'file:///workspace/group.yaml', text: 'kind: Group\n' };
  const a = createSourceSnapshot({ ...baseInput, files: [...baseInput.files, second] });
  const b = createSourceSnapshot({ ...baseInput, files: [second, ...baseInput.files] });
  assert.equal(a.digest, b.digest);
  const buffer = createSourceSnapshot({
    ...baseInput,
    files: [{ ...baseInput.files[0]!, origin: 'buffer', version: 2 }],
  });
  assert.notEqual(buffer.digest, a.digest);
  assert(Object.isFrozen(buffer.files[0]));
  assert.throws(
    () =>
      createSourceSnapshot({ ...baseInput, files: [{ ...baseInput.files[0]!, origin: 'buffer' }] }),
    /document version/,
  );
});

void test('rejects duplicate sources, invalid change sets and altered digests', () => {
  assert.throws(
    () => createSourceSnapshot({ ...baseInput, files: [...baseInput.files, ...baseInput.files] }),
    /duplicate identities/,
  );
  assert.throws(
    () => createSourceSnapshot({ ...baseInput, changes: [{ uri: URI, kind: 'deleted' }] }),
    /conflicts/,
  );
  assert.throws(
    () =>
      createSourceSnapshot({ ...baseInput, changes: [{ uri: 'file:///missing', kind: 'added' }] }),
    /conflicts/,
  );
  const snapshot = createSourceSnapshot(baseInput);
  assert.throws(
    () =>
      parseContract('source-snapshot', {
        ...snapshot,
        files: [{ ...snapshot.files[0], text: 'tampered' }],
      }),
    /file digest mismatch/,
  );
  assert.throws(
    () => parseContract('source-snapshot', { ...snapshot, revision: 'tampered' }),
    /snapshot digest mismatch/,
  );
});

void test('byte limits count UTF-8 and aggregate files', () => {
  assert.throws(
    () => createSourceSnapshot({ ...baseInput, files: [{ uri: URI, text: 'é'.repeat(524_289) }] }),
    /file exceeds/,
  );
  const files = Array.from({ length: 17 }, (_, index) => ({
    uri: `file:///workspace/${index}.yaml`,
    text: 'x'.repeat(1024 * 1024),
  }));
  assert.throws(() => createSourceSnapshot({ ...baseInput, files }), /request source exceeds/);
});

void test('overlays replace buffers and preserve deletion tombstones without changing the base', () => {
  const base = createSourceSnapshot(baseInput);
  const overlay = overlaySourceSnapshot(base, [
    { uri: URI, deleted: true },
    { uri: 'file:///workspace/new.yaml', text: 'kind: API\n', origin: 'buffer', version: 4 },
  ]);
  assert.equal(base.files.length, 1);
  assert.equal(base.changes.length, 0);
  assert.equal(overlay.files.length, 1);
  assert.deepEqual(overlay.changes, [
    { uri: URI, kind: 'deleted' },
    { uri: 'file:///workspace/new.yaml', kind: 'added' },
  ]);
  const restored = overlaySourceSnapshot(overlay, [{ uri: URI, text: 'kind: Component\n' }]);
  assert.equal(restored.changes.find((change) => change.uri === URI)?.kind, 'modified');
  const removedAddition = overlaySourceSnapshot(overlay, [
    { uri: 'file:///workspace/new.yaml', deleted: true },
  ]);
  assert.deepEqual(removedAddition.changes, [{ uri: URI, kind: 'deleted' }]);
  assert.throws(
    () =>
      overlaySourceSnapshot(base, [
        { uri: URI, deleted: true },
        { uri: URI, text: 'x' },
      ]),
    /competing overlay/,
  );
});

void test('data snapshots retain distinct present, missing and unavailable states', () => {
  const provenance = {
    providerId: 'catalog',
    connectionId: 'primary',
    installationId: 'installation-1',
    principalId: 'principal-1',
    permissionRevision: 'permissions-1',
    scope: ['catalog:read'],
    revision: 'catalog-42',
    fetchedAt: NOW,
    expiresAt: NOW + 60_000,
  };
  const value = { owner: 'original' };
  const snapshot = createDataSnapshot([
    { key: 'present', status: 'present', value, provenance },
    { key: 'missing', status: 'missing', provenance },
    { key: 'outage', status: 'unavailable', reason: 'provider_error', provenance },
  ]);
  value.owner = 'changed';
  const present = snapshot.entries.find((entry) => entry.status === 'present');
  assert(present?.status === 'present');
  assert.deepEqual(present.value, { owner: 'original' });
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.status),
    ['missing', 'unavailable', 'present'],
  );
  assert.throws(
    () => parseContract('data-snapshot', { ...snapshot, entries: [] }),
    /digest mismatch/,
  );
  assert.throws(
    () =>
      createDataSnapshot([
        { key: 'bad', status: 'missing', provenance: { ...provenance, expiresAt: NOW } },
      ]),
    /expiry/,
  );
  assert.throws(
    () => createDataSnapshot([snapshot.entries[0]!, snapshot.entries[0]!]),
    /duplicate identities/,
  );
  assert.throws(
    () => parseContract('data-snapshot', { ...snapshot, authorized: true }),
    ContractError,
  );
});

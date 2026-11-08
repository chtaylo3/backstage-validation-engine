import assert from 'node:assert/strict';
import { link, mkdir, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  createFilesystemSource,
  FilesystemSnapshotError,
  reconcileFilesystemSource,
} from '../src/lsp/filesystem.js';
import { parseLspConfig } from '../src/lsp/config.js';
import {
  createSourceSnapshot,
  overlaySourceSnapshot,
  DEFAULT_DEPLOYMENT_PROFILE,
} from '../src/index.js';
import { filesystemFixture } from './harness/filesystem-fixture.js';

const capture = (
  reader: Awaited<ReturnType<typeof createFilesystemSource>>,
  f: Awaited<ReturnType<typeof filesystemFixture>>,
) => reader.capture(f.source, { deadlineAt: Date.now() + 5000 });

void test('filesystem capture pins fresh UTF-8 bytes, additions and baseline-relative removals immutably', async (t) => {
  const f = await filesystemFixture(t, {
    files: { 'catalog.yaml': 'old', 'payload.txt': 'payload' },
    approved: ['catalog.yaml', 'payload.txt', 'new.txt'],
  });
  const reader = await createFilesystemSource(f.config);
  t.after(() => reader.close());
  await writeFile(join(f.root, 'catalog.yaml'), '\ufefffresh 😃\r\n');
  await rm(join(f.root, 'payload.txt'));
  await writeFile(join(f.root, 'new.txt'), 'new');
  const result = await capture(reader, f);
  assert.equal(
    result.files.find((file) => file.uri === f.uri('catalog.yaml'))?.text,
    '\ufefffresh 😃\r\n',
  );
  assert.deepEqual(
    result.changes.map((row) => [row.uri, row.kind]).sort(),
    [
      [f.uri('catalog.yaml'), 'modified'],
      [f.uri('payload.txt'), 'deleted'],
      [f.uri('new.txt'), 'added'],
    ].sort(),
  );
  assert(result.files.every((file) => file.origin === 'repository' && file.version === undefined));
  assert.equal(f.source.files.find((file) => file.uri === f.uri('catalog.yaml'))?.text, 'old');
  assert(Object.isFrozen(result.files));
  await writeFile(join(f.root, 'catalog.yaml'), 'old');
  await writeFile(join(f.root, 'payload.txt'), 'payload');
  await rm(join(f.root, 'new.txt'));
  const reverted = await reader.capture(result, { deadlineAt: Date.now() + 5000 });
  assert.deepEqual(reverted.changes, []);
});

void test('trusted filesystem configuration requires canonical contained paths and complete approved membership', async (t) => {
  const f = await filesystemFixture(t);
  for (const files of [
    [pathToFileURL(join(f.directory, 'outside.yaml')).href],
    [f.uri('../outside.yaml')],
    ['https://example.com/catalog.yaml'],
    [f.uri('unrelated.yaml')],
  ])
    assert.throws(
      () => parseLspConfig({ ...f.config, filesystem: { files } }),
      /filesystem configuration/,
    );
  const { rootUri: _rootUri, ...source } = f.source;
  void _rootUri;
  assert.throws(
    () => parseLspConfig({ ...f.config, source: createSourceSnapshot(source) }),
    /filesystem configuration/,
  );
});

void test('filesystem failures reject oversized, aggregate-over-budget and invalid UTF-8 content without stale fallback', async (t) => {
  const f = await filesystemFixture(t, {
    files: { 'catalog.yaml': 'old', 'other.txt': 'old' },
    profile: {
      limits: { ...DEFAULT_DEPLOYMENT_PROFILE.limits, fileBytes: 100, requestBytes: 150 },
    },
  });
  const reader = await createFilesystemSource(f.config);
  t.after(() => reader.close());
  await writeFile(join(f.root, 'catalog.yaml'), 'x'.repeat(101));
  await assert.rejects(
    capture(reader, f),
    (error: unknown) => error instanceof FilesystemSnapshotError && error.reason === 'limit',
  );
  await writeFile(join(f.root, 'catalog.yaml'), 'x'.repeat(80));
  await writeFile(join(f.root, 'other.txt'), 'x'.repeat(80));
  await assert.rejects(
    capture(reader, f),
    (error: unknown) => error instanceof FilesystemSnapshotError && error.reason === 'limit',
  );
  await writeFile(join(f.root, 'catalog.yaml'), Buffer.from([255]));
  await assert.rejects(
    capture(reader, f),
    (error: unknown) => error instanceof FilesystemSnapshotError && error.reason === 'invalid_utf8',
  );
  await writeFile(join(f.root, 'catalog.yaml'), 'fixed');
  await writeFile(join(f.root, 'other.txt'), 'fixed');
  assert.equal((await capture(reader, f)).files.length, 2);
});

void test('filesystem capture rejects symlinks, hardlinks and non-file paths', async (t) => {
  for (const kind of ['file-link', 'directory-link', 'hardlink', 'directory'] as const)
    await t.test(kind, async (t) => {
      const nested = kind === 'directory-link';
      const f = await filesystemFixture(
        t,
        nested
          ? { files: { 'nested/catalog.yaml': 'old' }, entrypoints: ['nested/catalog.yaml'] }
          : {},
      );
      const outside = join(f.directory, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'secret'), 'private-host-content');
      await writeFile(join(outside, 'catalog.yaml'), 'private-host-content');
      const reader = await createFilesystemSource(f.config);
      t.after(() => reader.close());
      await rm(join(f.root, nested ? 'nested/catalog.yaml' : 'catalog.yaml'));
      try {
        if (kind === 'file-link')
          await symlink(join(outside, 'secret'), join(f.root, 'catalog.yaml'), 'file');
        else if (kind === 'hardlink')
          await link(join(outside, 'secret'), join(f.root, 'catalog.yaml'));
        else if (kind === 'directory') await mkdir(join(f.root, 'catalog.yaml'));
        else {
          await rm(join(f.root, 'nested'), { recursive: true });
          await symlink(
            outside,
            join(f.root, 'nested'),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
          t.skip('Filesystem link creation is unavailable.');
          return;
        }
        throw error;
      }
      await assert.rejects(
        capture(reader, f),
        (error: unknown) =>
          error instanceof FilesystemSnapshotError &&
          ['containment', 'changed'].includes(error.reason) &&
          !error.message.includes('private-host-content'),
      );
    });
});

void test('filesystem root identity is pinned and a symlink root cannot be approved', async (t) => {
  const f = await filesystemFixture(t);
  const reader = await createFilesystemSource(f.config);
  t.after(() => reader.close());
  await rename(f.root, join(f.directory, 'old-root'));
  await mkdir(f.root);
  await writeFile(join(f.root, 'catalog.yaml'), 'replacement');
  await assert.rejects(
    capture(reader, f),
    (error: unknown) => error instanceof FilesystemSnapshotError && error.reason === 'changed',
  );
  await rm(f.root, { recursive: true });
  try {
    await symlink(
      join(f.directory, 'old-root'),
      f.root,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return;
    throw error;
  }
  assert(f.config.source.rootUri?.endsWith('/'));
  await assert.rejects(
    createFilesystemSource(f.config),
    (error: unknown) => error instanceof FilesystemSnapshotError && error.reason === 'containment',
  );
});

void test('filesystem reads obey original deadlines, cancellation and awaited close', async (t) => {
  const f = await filesystemFixture(t);
  const reader = await createFilesystemSource(f.config);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reader.capture(f.source, { deadlineAt: Date.now() + 5000, signal: controller.signal }),
    /cancelled/i,
  );
  await assert.rejects(reader.capture(f.source, { deadlineAt: Date.now() - 1 }), /deadline/i);
  await reader.close();
  await assert.rejects(
    capture(reader, f),
    (error: unknown) => error instanceof FilesystemSnapshotError && error.reason === 'closed',
  );
});

void test('parallel capture bounds in-flight files by the byte budget and close drains every descriptor', async (t) => {
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`file-${i}.txt`, 'old']));
  const f = await filesystemFixture(t, {
    files,
    entrypoints: ['file-0.txt'],
    profile: {
      limits: { ...DEFAULT_DEPLOYMENT_PROFILE.limits, fileBytes: 64, requestBytes: 256 },
    },
  });
  const reader = await createFilesystemSource(f.config);
  const probe = await open(join(f.root, 'file-0.txt'), 'r');
  const prototype = Object.getPrototypeOf(probe) as Pick<FileHandle, 'read'>;
  const originalRead = prototype.read;
  await probe.close();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Set<FileHandle>();
  t.after(async () => {
    release();
    await reader.close();
  });
  t.mock.method(prototype, 'read', async function (this: FileHandle, buffer: Buffer) {
    held.add(this);
    assert(held.size <= 4, 'At most requestBytes/fileBytes reads may be in flight.');
    if (held.size === 4) entered();
    await gate;
    return originalRead.call(this, { buffer });
  });
  const pending = capture(reader, f);
  await Promise.race([ready, pending.then(() => assert.fail('Reads must reach the barrier.'))]);
  let drained = false;
  const stopping = reader.close().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false, 'Close awaits reads whose descriptors are still held.');
  release();
  await assert.rejects(pending, /cancelled/i);
  await stopping;
  assert.equal(held.size, 4);
  assert(
    [...held].every((handle) => handle.fd === -1),
    'Every held descriptor is closed.',
  );
});

void test('parallel batches reject aggregate overflow without a partial result and recover with exact budget bytes', async (t) => {
  const names = Array.from({ length: 4 }, (_, i) => `file-${i}.txt`);
  const f = await filesystemFixture(t, {
    files: Object.fromEntries(names.map((name) => [name, 'old'])),
    entrypoints: [names[0]!],
    profile: {
      limits: { ...DEFAULT_DEPLOYMENT_PROFILE.limits, fileBytes: 128, requestBytes: 256 },
    },
  });
  const reader = await createFilesystemSource(f.config);
  t.after(() => reader.close());
  await Promise.all(names.map((name) => writeFile(join(f.root, name), 'x'.repeat(80))));
  await assert.rejects(
    capture(reader, f),
    (error: unknown) => error instanceof FilesystemSnapshotError && error.reason === 'limit',
  );
  assert(f.source.files.every((file) => file.text === 'old'));
  await Promise.all(names.map((name) => writeFile(join(f.root, name), 'x'.repeat(64))));
  const result = await capture(reader, f);
  assert.equal(
    result.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0),
    256,
  );
  assert.deepEqual(
    result.files.map((file) => file.uri),
    names.map(f.uri).sort(),
  );
});

void test('open buffers mask disk read failures and reintroduced baseline files retain coherent change kinds', async (t) => {
  const f = await filesystemFixture(t);
  const reader = await createFilesystemSource(f.config);
  t.after(() => reader.close());
  await writeFile(join(f.root, 'catalog.yaml'), Buffer.from([255]));
  const held = await reader.capture(f.source, {
    deadlineAt: Date.now() + 5000,
    skip: [f.uri('catalog.yaml')],
  });
  assert.equal(held.digest, f.source.digest);
  await rm(join(f.root, 'catalog.yaml'));
  const removed = await capture(reader, f);
  const proposal = reconcileFilesystemSource(
    f.config,
    overlaySourceSnapshot(removed, [
      { uri: f.uri('catalog.yaml'), text: 'new buffer', origin: 'buffer', version: 2 },
    ]),
  );
  assert.deepEqual(proposal.changes, [{ uri: f.uri('catalog.yaml'), kind: 'modified' }]);
  assert.deepEqual(proposal.entrypoints, [f.uri('catalog.yaml')]);
});

void test('a mutation after descriptor inspection is rejected by the final named-file check', async (t) => {
  const f = await filesystemFixture(t);
  const reader = await createFilesystemSource(f.config);
  t.after(() => reader.close());
  const handle = await open(join(f.root, 'catalog.yaml'), 'r');
  const prototype = Object.getPrototypeOf(handle) as Pick<FileHandle, 'stat'>;
  const original = prototype.stat;
  await handle.close();
  let calls = 0;
  t.mock.method(prototype, 'stat', async function (this: FileHandle) {
    const stat = await original.call(this, { bigint: true });
    if (++calls === 2) await writeFile(join(f.root, 'catalog.yaml'), 'mutated after inspection');
    return stat;
  });
  await assert.rejects(
    capture(reader, f),
    (error: unknown) => error instanceof FilesystemSnapshotError && error.reason === 'changed',
  );
  assert.equal(calls, 2);
});

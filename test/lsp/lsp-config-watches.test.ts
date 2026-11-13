import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrustedFileWatches } from '../../src/lsp/config-watches.js';
void test('the process configuration watch survives credential generation retirement and all callbacks stop after terminal close', () => {
  const active = new Map<string, () => void>();
  const stops: string[] = [];
  let changes = 0;
  const watches = new TrustedFileWatches(
    '/trusted/host.json',
    () => {
      changes++;
    },
    (filename, changed) => {
      active.set(filename, changed);
      return () => {
        stops.push(filename);
        active.delete(filename);
      };
    },
  );
  const old = watches.credential('/trusted/old-token');
  const obsolete = active.get('/trusted/old-token')!;
  obsolete();
  assert.equal(changes, 1);
  old!.dispose();
  old!.dispose();
  obsolete();
  active.get('/trusted/host.json')!();
  assert.equal(changes, 2);
  assert.deepEqual(stops, ['/trusted/old-token']);
  const next = watches.credential('/trusted/new-token');
  assert.equal(watches.credential('/trusted/host.json'), undefined);
  active.get('/trusted/new-token')!();
  assert.equal(changes, 3);
  watches.close();
  watches.close();
  active.get('/trusted/new-token')!();
  assert.equal(changes, 3);
  next!.dispose();
  assert.equal(active.size, 0);
  assert.equal(watches.credential('/trusted/future-token'), undefined);
});

void test('the configuration watch reloads unless the file still holds the bytes in use', async () => {
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  let report!: () => void;
  let credential!: () => void;
  let changes = 0;
  let answer: () => Promise<boolean> = () => Promise.resolve(true);
  const watches = new TrustedFileWatches(
    '/trusted/host.json',
    () => {
      changes++;
    },
    (watched, changed) => {
      if (watched === '/trusted/host.json') report = changed;
      else credential = changed;
      return () => {};
    },
    () => answer(),
  );
  // An explicit reload already loaded these bytes: the watch has nothing new to load.
  report();
  await settle();
  assert.equal(changes, 0);
  // Different bytes reload.
  answer = () => Promise.resolve(false);
  report();
  await settle();
  assert.equal(changes, 1);
  // A file that cannot be read, or that changes while it is read, is not proof: it reloads.
  answer = () => Promise.reject(new Error('Trusted configuration changed during capture.'));
  report();
  await settle();
  assert.equal(changes, 2);
  // A credential change always reloads: the configuration file says nothing about it.
  answer = () => Promise.resolve(true);
  watches.credential('/trusted/token');
  credential();
  assert.equal(changes, 3);
  // A check that is still running when the watches close reloads nothing.
  let release!: (value: boolean) => void;
  answer = () => new Promise<boolean>((resolve) => (release = resolve));
  report();
  watches.close();
  release(false);
  await settle();
  assert.equal(changes, 3);
});

void test('a trusted configuration carries the digest of the bytes it was read from', async (t) => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { readTrustedLspConfig, trustedConfigDigest, trustedFileDigest } =
    await import('../../src/lsp/trusted-config.js');
  const { parseLspConfig } = await import('../../src/lsp/config.js');
  const { policyRun } = await import('../harness/policy-fixture.js');
  const run = policyRun({ rules: [] });
  const text = JSON.stringify(
    parseLspConfig({ ...run.context, identity: run.request.identity, source: run.request.source }),
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-config-digest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'host.json');
  const sha = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
  await writeFile(filename, text);
  const first = await readTrustedLspConfig(filename);
  assert.equal(trustedConfigDigest(first), sha(text));
  assert.equal(await trustedFileDigest(filename), sha(text));
  assert.equal(trustedConfigDigest({}), undefined);
  // The same bytes written again are the same configuration, whatever the file times say.
  await writeFile(filename, text);
  assert.equal(await trustedFileDigest(filename), trustedConfigDigest(first));
  // Other bytes of the same length, written at once, are a change that file times can miss.
  await writeFile(filename, text.slice(0, -1) + ' ');
  assert.notEqual(await trustedFileDigest(filename), trustedConfigDigest(first));
  await assert.rejects(trustedFileDigest(path.join(directory, 'missing.json')));
  await assert.rejects(trustedFileDigest(directory), /Invalid trusted configuration/u);
});

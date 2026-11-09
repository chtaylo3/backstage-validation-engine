import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrustedFileWatches } from '../src/lsp/config-watches.js';
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

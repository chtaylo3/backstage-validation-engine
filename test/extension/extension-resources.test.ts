import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyResourceGrowth } from '../../extensions/vscode/test/resources.js';
import type { ResourceSample, GrowthBudgets } from '../../extensions/vscode/test/resources.js';
const budgets: GrowthBudgets = {
  warmupOperations: 10,
  clientGrowthMiB: 128,
  serverGrowthMiB: 128,
  handleGrowth: 64,
  growthMiBPerOperation: 0.15,
};
const short = (): ResourceSample[] =>
  Array.from({ length: 60 }, (_, operation) => ({
    elapsedMs: operation * 1000,
    operation,
    pid: 42 + Math.floor(operation / 20),
    client: { rssMiB: 200, handles: 30 },
    server: { rssMiB: operation % 20 < 10 ? 200 + (operation % 20) * 15 : 340, handles: 40 },
  })).filter((row) => row.operation % 3 === 0 || [20, 40].includes(row.operation));
void test('resource growth measures each process after declared warmup without raising the RSS cap', () => {
  verifyResourceGrowth(short(), budgets);
  const leaking = short();
  leaking.at(-1)!.server.rssMiB += 129;
  assert.throws(() => verifyResourceGrowth(leaking, budgets), /retained RSS/);
});
void test('post-warmup handle leaks remain failures', () => {
  const leaking = short();
  leaking.at(-1)!.server.handles += 65;
  assert.throws(() => verifyResourceGrowth(leaking, budgets), /handle growth/);
});
void test('long process epochs reject a persistent slope even below the absolute growth cap', () => {
  const leaking: ResourceSample[] = Array.from({ length: 101 }, (_, index) => ({
    elapsedMs: index * 1000,
    operation: index * 3,
    pid: 42,
    client: { rssMiB: 200, handles: 30 },
    server: { rssMiB: 340 + index * 3 * 0.2, handles: 40 },
  }));
  assert.throws(() => verifyResourceGrowth(leaking, budgets), /growth per operation/);
});
void test('cold or frequently restarted processes cannot claim a measured plateau', () => {
  assert.throws(
    () =>
      verifyResourceGrowth(
        short().filter((row) => row.operation < 10),
        budgets,
      ),
    /after warmup/,
  );
  assert.throws(
    () =>
      verifyResourceGrowth(
        short().map((row) => ({ ...row, pid: row.operation })),
        budgets,
      ),
    /after warmup/,
  );
});

for (const side of ['client', 'server'] as const) {
  for (const kind of ['rssMiB', 'handles'] as const) {
    void test(`the first post-warmup quarter cannot hide a retained ${side} ${kind} leak`, () => {
      const samples: ResourceSample[] = Array.from({ length: 201 }, (_, operation) => ({
        operation,
        elapsedMs: operation * 1000,
        pid: 42,
        client: { rssMiB: 200, handles: 30 },
        server: { rssMiB: 500, handles: 40 },
      }));
      verifyResourceGrowth(samples, budgets, true, true);
      for (const row of samples)
        if (row.operation >= 30) row[side][kind] += kind === 'rssMiB' ? 129 : 65;
      assert.throws(
        () => verifyResourceGrowth(samples, budgets, true, true),
        kind === 'rssMiB' ? /retained RSS/ : /handle growth/,
      );
    });
  }
}

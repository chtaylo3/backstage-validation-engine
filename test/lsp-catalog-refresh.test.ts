import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogRefresh, CATALOG_REFRESH_LIMITS } from '../src/lsp/catalog-refresh.js';
import type { RefreshClock } from '../src/lsp/catalog-refresh.js';
import { overlaySourceSnapshot } from '../src/core/snapshots.js';
import { createDataSnapshot } from '../src/core/snapshots.js';
import type {
  CatalogLookupReport,
  CatalogProvider,
  CatalogSuggestionReport,
} from '../src/providers/types.js';
import {
  policyMatrix,
  policyRun,
  team,
  localTeam,
  componentText,
  ownerRule,
} from './harness/policy-fixture.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { startLspClient } from './harness/lsp-client.js';
import { setTimeout as pause } from 'node:timers/promises';
import {
  CodeActionRequest,
  ExecuteCommandRequest,
  DidOpenTextDocumentNotification,
} from 'vscode-languageserver/node';
import type { CodeAction } from 'vscode-languageserver/node';
import { fixPolicy } from './harness/fix-fixture.js';
import { URI } from './helpers.js';

function setup(maxAgeMs = 30_000) {
  let now = 1000,
    callback: (() => void) | undefined,
    delay = 0,
    invalidations = 0;
  const time: RefreshClock = {
    now: () => now,
    random: () => 0,
    schedule: (work, ms) => {
      callback = work;
      delay = ms;
      return () => {
        if (callback === work) callback = undefined;
      };
    },
  };
  const calls: { refs: readonly string[]; maxAgeMs: number; deadlineAt: number }[] = [];
  const source = policyRun();
  const access = {
    installationId: source.request.identity.installationId,
    principalId: 'reader',
    permissionRevision: '1',
    credentialRevision: '1',
    scope: ['catalog:read'],
    policyDigest: source.request.policy.digest,
    profileDigest: source.request.profile.digest,
    maxAgeMs,
  };
  let unavailable = false,
    body = 'body-1',
    suggestions: string[] = [];
  const provider: CatalogProvider = {
    connectionId: 'primary',
    adapterId: source.context.profile.adapterId,
    lookup: (refs, access, execution) => {
      calls.push({ refs, maxAgeMs: access.maxAgeMs, deadlineAt: execution.deadlineAt });
      return Promise.resolve({
        data: createDataSnapshot(
          refs.map((key) => ({
            key,
            ...(unavailable
              ? { status: 'unavailable' as const, reason: 'offline' as const }
              : { status: 'present' as const, value: { body } }),
            provenance: {
              providerId: 'backstage-catalog',
              connectionId: 'primary',
              installationId: access.installationId,
              principalId: access.principalId,
              permissionRevision: access.permissionRevision,
              scope: [...access.scope],
              revision: body,
              fetchedAt: now,
              expiresAt: now + 30_000,
            },
          })),
        ),
        failures: [],
        interrupted: 'none',
      });
    },
    suggest: () =>
      Promise.resolve({
        ...(unavailable
          ? { status: 'unavailable' as const, failure: 'offline' as const }
          : { status: 'ready' as const }),
        refs: [...suggestions],
        truncated: false,
        fetchedAt: now,
        expiresAt: now + 30_000,
      }),
    stats: () => ({ active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 }),
    close: () => Promise.resolve(),
  };
  const refresh = new CatalogRefresh({ provider, access }, () => invalidations++, time);
  const execution = { deadlineAt: now + 5000 };
  return {
    refresh,
    provider,
    access,
    execution,
    calls,
    get delay() {
      return delay;
    },
    get invalidations() {
      return invalidations;
    },
    advance(ms = delay) {
      now += ms;
      const work = callback;
      callback = undefined;
      work?.();
    },
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    setBody(value: string) {
      body = value;
    },
    setSuggestions(values: string[]) {
      suggestions = values;
    },
    setNow(value: number) {
      now = value;
    },
  };
}
async function read(h: ReturnType<typeof setup>, refs = ['group:default/team']) {
  const run = h.refresh.begin();
  const report = await run.catalog.provider.lookup(refs, h.access, h.execution);
  run.finish(true);
  return report;
}
void test('body and absence dependencies use qualified cadence, bypass caches only on refresh, and retain full-body revisions', async () => {
  const h = setup();
  assert.equal(h.refresh.status.timer, false);
  await read(h);
  assert.equal(h.delay, 30_000);
  assert.equal(h.calls[0]?.maxAgeMs, 30_000);
  const first = h.refresh.status.dataDigest;
  h.advance();
  assert.equal(h.invalidations, 1);
  assert.equal(h.refresh.generation, 1);
  h.setBody('body-2');
  await read(h);
  assert.notEqual(
    h.refresh.status.dataDigest,
    first,
    'Body changes alter the observed dependency digest.',
  );
  assert.equal(h.calls[1]?.maxAgeMs, 0);
  assert.equal(
    h.calls[1]?.deadlineAt,
    h.execution.deadlineAt,
    'The original deadline is retained.',
  );
  await read(h);
  assert.equal(h.calls[2]?.maxAgeMs, 30_000, 'Ordinary edits reuse normal freshness.');
  const empty = h.refresh.begin();
  empty.finish(true);
  assert.equal(h.refresh.status.references, 0);
  assert.equal(h.refresh.status.timer, false);
  await h.refresh.close();
});
void test('zero max age has a positive scheduling floor and bounded exponential outage backoff', async () => {
  const h = setup(0);
  await read(h);
  assert.equal(h.delay, CATALOG_REFRESH_LIMITS.floorMs);
  h.advance();
  h.setUnavailable(true);
  await read(h);
  assert.equal(h.delay, 1000);
  h.advance();
  await read(h);
  assert.equal(h.delay, 2000);
  for (let i = 0; i < 10; i++) {
    h.advance();
    await read(h);
  }
  assert.equal(h.delay, CATALOG_REFRESH_LIMITS.backoffMs);
  h.setUnavailable(false);
  h.advance();
  await read(h);
  assert.equal(h.refresh.status.failures, 0);
  assert.equal(h.delay, CATALOG_REFRESH_LIMITS.floorMs);
  await h.refresh.close();
  assert.equal(h.refresh.status.timer, false);
});
void test('query-only polling invalidates empty membership and has bounded recent scopes without extending user interest', async () => {
  const h = setup(500);
  const query = { kind: 'group', namespace: 'default', prefix: 'te' };
  const initial = await h.refresh.catalog.provider.suggest!(query, h.access, h.execution);
  assert.deepEqual(initial.refs, []);
  h.setSuggestions(['group:default/team']);
  h.advance();
  const run = h.refresh.begin();
  await h.refresh.refreshQueries({ deadlineAt: 10_000 });
  run.finish(true);
  const found = await h.refresh.catalog.provider.suggest!(query, h.access, { deadlineAt: 10_000 });
  assert.deepEqual(found.refs, ['group:default/team']);
  for (let i = 0; i < 40; i++)
    await h.refresh.catalog.provider.suggest!({ ...query, prefix: `te${i}` }, h.access, {
      deadlineAt: 10_000,
    });
  assert.equal(h.refresh.status.queries, CATALOG_REFRESH_LIMITS.queries);
  h.setNow(200_000);
  h.refresh.ensureFresh();
  assert.equal(h.refresh.status.queries, 0);
  assert.equal(h.refresh.status.timer, false);
  await h.refresh.close();
});
void test('late query replies cannot restore a retired dependency generation and close cancels owned reads', async () => {
  const h = setup(500);
  const query = { kind: 'group', namespace: 'default', prefix: 'te' };
  await h.refresh.catalog.provider.suggest!(query, h.access, h.execution);
  let release: (report: CatalogSuggestionReport) => void = () => {};
  let signal: AbortSignal | undefined;
  h.provider.suggest = (_query, _access, execution) => {
    signal = execution.signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const late = h.refresh.catalog.provider.suggest!(
    { ...query, prefix: 'other' },
    h.access,
    h.execution,
  );
  await Promise.resolve();
  await Promise.resolve();
  h.advance();
  assert.equal(signal?.aborted, true);
  release({
    status: 'ready',
    refs: ['group:default/obsolete'],
    fetchedAt: 1000,
    expiresAt: 40_000,
    truncated: false,
  });
  await assert.rejects(late, /stale/);
  await h.refresh.close();
  assert.equal(h.refresh.status.pending, 0);
});
void test('entity inventory is bounded and failed obsolete runs cannot replace accepted dependencies', async () => {
  const h = setup();
  await read(h);
  const run = h.refresh.begin();
  await assert.rejects(
    run.catalog.provider.lookup(
      Array.from({ length: 1001 }, (_, i) => `group:default/team${i}`),
      h.access,
      h.execution,
    ),
    /inventory/,
  );
  run.finish(false);
  assert.equal(h.refresh.status.references, 1);
  await h.refresh.close();
});
void test('PC-11 stdio observes add, body modification, deletion, rename and outage with unchanged document versions on both catalog contracts', async (t) => {
  const matrix = await policyMatrix(t);
  for (const { fixture, target } of matrix.fixtures)
    await t.test(target.backstageVersion, async (t) => {
      fixture.remove('group:default/team');
      const run = policyRun({ rules: [ownerRule] });
      const config = parseLspConfig({
        ...run.context,
        identity: run.request.identity,
        source: run.request.source,
        debounceMs: 0,
        catalog: {
          connectionId: 'primary',
          baseUrl: fixture.baseUrl,
          principalId: 'reader',
          credentialRevision: '1',
          scope: ['catalog:read'],
          maxAgeMs: 250,
          tokenEnv: 'BVE_TEST_TOKEN',
        },
      });
      const host = await startLspClient(t, config);
      const text = componentText();
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: URI, version: 7, text, languageId: 'yaml' },
      });
      const missing = (row: (typeof host.diagnostics)[number]) =>
        row.uri === URI &&
        row.version === 7 &&
        row.diagnostics.some((d) => d.code === 'owner-exists');
      await host.waitFor(missing);
      let after = host.diagnostics.length;
      const addedAt = Date.now();
      fixture.upsert(team);
      await host.waitFor(
        (row) => row.uri === URI && row.version === 7 && !row.diagnostics.length,
        after,
      );
      const elapsed = Date.now() - addedAt;
      assert(
        elapsed <= 250 + config.profile.limits.requestTimeoutMs,
        'Healthy addition fits one cadence plus one admitted request budget.',
      );
      t.diagnostic(`Remote addition to same-version result: ${elapsed} ms.`);
      after = host.diagnostics.length;
      fixture.upsert({
        ...team,
        metadata: { name: 'team', description: 'Changed without editing a source.' },
      });
      const count = fixture.requests().length;
      await host.waitFor(
        (row) => row.uri === URI && row.version === 7 && !row.diagnostics.length,
        after,
      );
      assert(
        fixture
          .requests()
          .slice(count)
          .some((row) => row.operation === 'byName' && row.status === 200),
        'The full entity body is read again before same-version evaluation.',
      );
      after = host.diagnostics.length;
      fixture.remove('group:default/team');
      fixture.upsert({ ...team, metadata: { name: 'renamed-team' } });
      await host.waitFor(missing, after);
      after = host.diagnostics.length;
      fixture.setPrincipal({
        token: 'policy-test-secret',
        principalId: 'reader',
        canRead: false,
        visibleRefs: '*',
      });
      await host.waitFor(
        (row) =>
          row.uri === URI &&
          row.version === 7 &&
          row.diagnostics.some(
            (d) =>
              d.code === 'validation/incomplete' ||
              (d.data as { category?: string } | undefined)?.category === 'dependency',
          ),
        after,
      );
      after = host.diagnostics.length;
      fixture.setPrincipal({
        token: 'policy-test-secret',
        principalId: 'reader',
        canRead: true,
        visibleRefs: '*',
      });
      fixture.upsert(team);
      await host.waitFor(
        (row) => row.uri === URI && row.version === 7 && !row.diagnostics.length,
        after,
      );
      assert(host.diagnostics.every((row) => row.uri !== URI || row.version === 7));
      assert.equal(host.applyRequests.length, 0, 'Remote rename never rewrites authored content.');
      await host.shutdown();
    });
});
void test('real provider body changes alter dependency digest while the entity identity remains unchanged', async (t) => {
  const matrix = await policyMatrix(t);
  for (let i = 0; i < matrix.fixtures.length; i++) {
    const { fixture } = matrix.fixtures[i]!;
    const source = policyRun();
    const catalog = await matrix.catalog(source, i);
    let now = Date.now(),
      tick: (() => void) | undefined;
    const refresh = new CatalogRefresh(catalog, () => {}, {
      now: () => now,
      random: () => 0,
      schedule: (work) => {
        tick = work;
        return () => {
          tick = undefined;
        };
      },
    });
    const observe = async () => {
      const run = refresh.begin();
      const report: CatalogLookupReport = await run.catalog.provider.lookup(
        ['group:default/team'],
        catalog.access,
        { deadlineAt: Date.now() + 5000 },
      );
      run.finish(true);
      return report;
    };
    await observe();
    const before = refresh.status.dataDigest;
    fixture.upsert({ ...team, spec: { type: 'team', children: ['new-child'] } });
    now += 250;
    tick?.();
    const report = await observe();
    assert.notEqual(refresh.status.dataDigest, before);
    assert(
      report.data.entries.some(
        (entry) => entry.status === 'present' && JSON.stringify(entry.value).includes('new-child'),
      ),
    );
    await refresh.close();
  }
});
void test('PC-11 query-only stdio sessions refresh empty membership, deletion and rename without opening a document', async (t) => {
  const matrix = await policyMatrix(t);
  for (const { fixture, target } of matrix.fixtures)
    await t.test(target.backstageVersion, async (t) => {
      const run = policyRun({ rules: [] });
      const host = await startLspClient(
        t,
        parseLspConfig({
          ...run.context,
          identity: run.request.identity,
          source: run.request.source,
          debounceMs: 0,
          catalog: {
            connectionId: 'primary',
            baseUrl: fixture.baseUrl,
            principalId: 'reader',
            credentialRevision: '1',
            scope: ['catalog:read'],
            maxAgeMs: 250,
            tokenEnv: 'BVE_TEST_TOKEN',
          },
        }),
      );
      const query = { kind: 'group', namespace: 'default', prefix: 'refresh-' };
      const search = () =>
        host.client.sendRequest<{ reference: string }[]>('bve/searchReferences', query);
      assert.deepEqual(await search(), []);
      fixture.upsert({ ...team, metadata: { name: 'refresh-added' } });
      const wait = async (wanted: string | undefined) => {
        const until = Date.now() + 10_000;
        for (;;) {
          const result = await search();
          if (wanted ? result.some((row) => row.reference === wanted) : result.length === 0)
            return result;
          assert(Date.now() < until, 'Fresh remote membership is visible.');
          await pause(25);
        }
      };
      await wait('group:default/refresh-added');
      const after = fixture.requests().length;
      fixture.remove('group:default/refresh-added');
      fixture.upsert({ ...team, metadata: { name: 'refresh-renamed' } });
      const renamed = await wait('group:default/refresh-renamed');
      assert(!renamed.some((row) => row.reference === 'group:default/refresh-added'));
      assert(
        fixture
          .requests()
          .slice(after)
          .some((row) => row.operation === 'byQuery' && row.status === 200),
      );
      fixture.remove('group:default/refresh-renamed');
      await wait(undefined);
      assert(
        !fixture.requests().some((row) => row.operation === 'byName'),
        'Identity-only queries do not collect full bodies.',
      );
      assert.equal(host.diagnostics.length, 0, 'The search never opens or edits a document.');
      await host.shutdown();
    });
});
void test('remote expiry revokes a previously offered guarded repair before client edit dispatch', async (t) => {
  const matrix = await policyMatrix(t);
  const { fixture } = matrix.fixtures[0]!;
  const fix = fixPolicy();
  const run = policyRun({ ...fix, rules: [...fix.rules, ownerRule] });
  const host = await startLspClient(
    t,
    parseLspConfig({
      ...run.context,
      identity: run.request.identity,
      source: run.request.source,
      debounceMs: 0,
      catalog: {
        connectionId: 'primary',
        baseUrl: fixture.baseUrl,
        principalId: 'reader',
        credentialRevision: '1',
        scope: ['catalog:read'],
        maxAgeMs: 500,
        tokenEnv: 'BVE_TEST_TOKEN',
      },
    }),
    { fixes: true },
  );
  const text = componentText().replace('production', 'experimental');
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 9, text, languageId: 'yaml' },
  });
  const diagnostic = await host.waitFor(
    (row) => row.version === 9 && row.diagnostics.some((d) => d.code === 'required-value'),
  );
  const actions = (await host.client.sendRequest(CodeActionRequest.type, {
    textDocument: { uri: URI },
    range: diagnostic.diagnostics[0]!.range,
    context: { diagnostics: diagnostic.diagnostics, only: ['quickfix'] },
  })) as CodeAction[];
  assert.equal(actions.length, 1, 'Positive control: the original current repair is offered.');
  const after = host.diagnostics.length;
  fixture.remove('group:default/team');
  await host.waitFor(
    (row) => row.version === 9 && row.diagnostics.some((d) => d.code === 'owner-exists'),
    after,
  );
  const result: unknown = await host.client.sendRequest(
    ExecuteCommandRequest.type,
    actions[0]!.command!,
  );
  assert.deepEqual(result, { applied: false, reason: 'stale' });
  assert.equal(host.applyRequests.length, 0);
  await host.shutdown();
});
void test('negative observation expiry shortens the cadence and protocol admission revokes claims before a delayed timer', async () => {
  const h = setup();
  const lookup = h.provider.lookup.bind(h.provider);
  h.provider.lookup = async (...args) => {
    const report = await lookup(...args);
    return {
      ...report,
      data: createDataSnapshot(
        report.data.entries.map((row) => ({
          key: row.key,
          status: 'missing' as const,
          provenance: { ...row.provenance, expiresAt: 1100 },
        })),
      ),
    };
  };
  await read(h);
  assert.equal(h.delay, 250, 'The scheduler retains a positive floor.');
  h.setNow(1100);
  h.refresh.ensureFresh();
  assert.equal(
    h.invalidations,
    1,
    'Expiry revokes claims before protocol work even if the timer has not fired.',
  );
  h.refresh.ensureFresh();
  assert.equal(h.invalidations, 1, 'A pending refresh is coalesced.');
  await h.refresh.close();
});
void test('live query refresh preserves deletion, invalid replacement and conflict masks and local choices during denial', async (t) => {
  const matrix = await policyMatrix(t);
  const { fixture } = matrix.fixtures[0]!;
  for (const mode of ['deleted', 'invalid', 'conflict'])
    await t.test(mode, async (t) => {
      fixture.setPrincipal({
        token: 'policy-test-secret',
        principalId: 'reader',
        canRead: true,
        visibleRefs: '*',
      });
      fixture.upsert(team);
      fixture.upsert({ ...team, metadata: { name: 'te-remote' } });
      fixture.remove('group:default/te-renamed');
      const local = {
        uri: 'file:///workspace/local.yaml',
        text: localTeam.text.replace('name: team', 'name: te-local'),
      };
      const baseline = policyRun({ files: [localTeam, local] }).request.source;
      const source =
        mode === 'deleted'
          ? overlaySourceSnapshot(baseline, [{ uri: localTeam.uri, deleted: true }])
          : mode === 'invalid'
            ? overlaySourceSnapshot(baseline, [
                {
                  ...localTeam,
                  text: 'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: team}\nspec: {}\n',
                },
              ])
            : overlaySourceSnapshot(baseline, [
                { uri: 'file:///workspace/duplicate.yaml', text: localTeam.text },
              ]);
      const run = policyRun({ source, baseline, rules: [] });
      const host = await startLspClient(
        t,
        parseLspConfig({
          ...run.context,
          identity: run.request.identity,
          source,
          baseline,
          debounceMs: 0,
          catalog: {
            connectionId: 'primary',
            baseUrl: fixture.baseUrl,
            principalId: 'reader',
            credentialRevision: '1',
            scope: ['catalog:read'],
            maxAgeMs: 250,
            tokenEnv: 'BVE_TEST_TOKEN',
          },
        }),
      );
      const query = { kind: 'group', namespace: 'default', prefix: 'te' };
      const search = () =>
        host.client.sendRequest<{ reference: string; source: string }[]>(
          'bve/searchReferences',
          query,
        );
      const initial = await search();
      assert(initial.some((row) => row.reference === 'group:default/te-remote'));
      assert(
        initial.some(
          (row) => row.reference === 'group:default/te-local' && row.source === 'Workspace source',
        ),
      );
      assert(!initial.some((row) => row.reference === 'group:default/team'));
      fixture.remove('group:default/te-remote');
      fixture.upsert({ ...team, metadata: { name: 'te-renamed' } });
      let found = initial;
      const deadline = Date.now() + 10_000;
      while (!found.some((row) => row.reference === 'group:default/te-renamed')) {
        assert(Date.now() < deadline);
        await pause(25);
        found = await search();
      }
      assert(
        !found.some(
          (row) =>
            row.reference === 'group:default/team' || row.reference === 'group:default/te-remote',
        ),
      );
      const after = fixture.requests().length;
      fixture.setPrincipal({
        token: 'policy-test-secret',
        principalId: 'reader',
        canRead: false,
        visibleRefs: '*',
      });
      while (
        !fixture
          .requests()
          .slice(after)
          .some((row) => row.operation === 'byQuery' && row.status === 403)
      ) {
        assert(Date.now() < deadline);
        await pause(25);
        await search();
      }
      const localOnly = await search();
      assert(localOnly.some((row) => row.reference === 'group:default/te-local'));
      assert(localOnly.every((row) => row.source === 'Workspace source'));
      await host.shutdown();
    });
});
void test('a failed advisory query cannot postpone an existing body observation expiry behind backoff', async () => {
  const h = setup();
  const lookup = h.provider.lookup.bind(h.provider);
  h.provider.lookup = async (...args) => {
    const report = await lookup(...args);
    return {
      ...report,
      data: createDataSnapshot(
        report.data.entries.map((row) => ({
          ...row,
          provenance: { ...row.provenance, expiresAt: 2000 },
        })),
      ),
    };
  };
  h.provider.suggest = () =>
    Promise.resolve({
      status: 'unavailable',
      failure: 'offline',
      refs: [],
      truncated: false,
      fetchedAt: 1000,
      expiresAt: 1000,
    });
  const run = h.refresh.begin();
  await run.catalog.provider.lookup(['group:default/team'], h.access, h.execution);
  await h.refresh.catalog.provider.suggest!(
    { kind: 'group', namespace: 'default', prefix: 'ot' },
    h.access,
    h.execution,
  );
  run.finish(true);
  assert.equal(h.refresh.status.failures, 1);
  assert.equal(h.delay, 1000, 'The successful body expires before the 30-second failure backoff.');
  h.advance();
  assert.equal(h.invalidations, 1, 'An idle session revokes expiry without a protocol request.');
  await h.refresh.close();
});
void test('a held advisory query does not delay timely remote-only body diagnostics or retain old repairs', async (t) => {
  const matrix = await policyMatrix(t);
  const { fixture } = matrix.fixtures[0]!;
  fixture.remove('group:default/team');
  const run = policyRun();
  const host = await startLspClient(
    t,
    parseLspConfig({
      ...run.context,
      identity: run.request.identity,
      source: run.request.source,
      debounceMs: 0,
      catalog: {
        connectionId: 'primary',
        baseUrl: fixture.baseUrl,
        principalId: 'reader',
        credentialRevision: '1',
        scope: ['catalog:read'],
        maxAgeMs: 500,
        tokenEnv: 'BVE_TEST_TOKEN',
      },
    }),
  );
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 12, text: componentText(), languageId: 'yaml' },
  });
  await host.waitFor(
    (row) => row.version === 12 && row.diagnostics.some((d) => d.code === 'owner-exists'),
  );
  await host.client.sendRequest('bve/searchReferences', {
    kind: 'group',
    namespace: 'default',
    prefix: 'ot',
  });
  const gate = fixture.holdNext({ operation: 'byQuery' });
  const after = host.diagnostics.length;
  fixture.upsert(team);
  try {
    await gate.entered;
    const result = await Promise.race([
      host
        .waitFor((row) => row.version === 12 && !row.diagnostics.length, after)
        .then(() => 'published'),
      gate.cancelled.then(() => 'query-cancelled'),
    ]);
    assert.equal(
      result,
      'published',
      'Body diagnostics publish while the unrelated query is still held and before its cancellation.',
    );
  } finally {
    gate.release();
  }
  await host.shutdown();
});

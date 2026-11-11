import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { loadPinnedMatrix } from '../../../test/harness/pinned-matrix.js';
import { startFixtureMatrix } from '../../../test/harness/fixture-matrix.js';
import { startFakeBackstage } from '../../../test/harness/fake-backstage.js';
import type { ResponseGate } from '../../../test/harness/fake-backstage.js';

/** Test-only control plane, separate from the pinned catalog wire-contract API. */
export async function createEditorCatalog(root: string, token: string = randomUUID()) {
  const artifactRoot = path.join(root, 'test/fixtures/backstage');
  const matrix = await startFixtureMatrix(
    await loadPinnedMatrix(artifactRoot),
    artifactRoot,
    (artifact) =>
      startFakeBackstage(artifact, {
        principals: [{ token, principalId: 'editor-reader', canRead: true, visibleRefs: '*' }],
        entities: [
          {
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: { name: 'remote-team' },
            spec: { type: 'team', children: [] },
          },
        ],
      }),
  );
  const gates = new Map<string, ResponseGate>();
  let outage = false;
  let outageNumber = 0;
  let outageAfter = 0;
  const events: { event: string; id?: string; version?: string; at: number }[] = [];
  const controlToken = randomUUID();
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== 'Bearer ' + controlToken) {
        response.writeHead(403).end();
        return;
      }
      let text = '';
      for await (const chunk of request) {
        text += String(chunk);
        if (Buffer.byteLength(text) > 4096) throw new Error('Control request exceeds limit.');
      }
      const value = JSON.parse(text || '{}') as {
        op: string;
        version?: number;
        operation?: 'byName' | 'byQuery';
        entityRef?: string;
        id?: string;
        after?: number;
      };
      const index = value.version ?? 0;
      const selected = matrix.fixtures[index];
      if (!selected) throw new Error('Unknown fixture version.');
      let result: unknown = {};
      if (value.op === 'arm') {
        if (value.operation !== 'byName' && value.operation !== 'byQuery')
          throw new Error('Invalid gated operation.');
        const id = randomUUID();
        const gate = selected.fixture.holdNext({
          operation: value.operation,
          ...(value.entityRef ? { entityRef: value.entityRef } : {}),
        });
        gates.set(id, gate);
        events.push({
          event: 'armed',
          id,
          version: selected.target.backstageVersion,
          at: Date.now(),
        });
        void gate.entered.then(() => events.push({ event: 'entered', id, at: Date.now() }));
        void gate.cancelled.then(() => events.push({ event: 'cancelled', id, at: Date.now() }));
        result = { id };
      } else if (value.op === 'entered' || value.op === 'cancelled' || value.op === 'release') {
        const gate = gates.get(value.id ?? '');
        if (!gate) throw new Error('Unknown gate.');
        if (value.op === 'release') {
          gate.release();
          events.push({ event: 'released', id: value.id!, at: Date.now() });
        } else await gate[value.op];
      } else if (value.op === 'outage') {
        outage = true;
        outageAfter = selected.fixture.requests().at(-1)?.id ?? 0;
        const reference = 'remote-team-' + ++outageNumber;
        selected.fixture.upsert({
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Group',
          metadata: { name: reference },
          spec: { type: 'team', children: [] },
        });
        selected.fixture.setPrincipal({
          token,
          principalId: 'editor-reader',
          canAccessCatalog: false,
          canRead: true,
          visibleRefs: '*',
        });
        events.push({ event: 'outage', version: selected.target.backstageVersion, at: Date.now() });
        result = { reference };
      } else if (value.op === 'recover') {
        if (!outage) throw new Error('Recover requires an observed outage.');
        if (
          !selected.fixture
            .requests()
            .some(
              (entry) =>
                entry.id > outageAfter && entry.operation === 'byName' && entry.status === 403,
            )
        )
          throw new Error('Recover requires a real denied catalog lookup.');
        selected.fixture.setPrincipal({
          token,
          principalId: 'editor-reader',
          canRead: true,
          visibleRefs: '*',
        });
        outage = false;
        events.push({
          event: 'recovered',
          version: selected.target.backstageVersion,
          at: Date.now(),
        });
        result = { id: String(selected.fixture.requests().at(-1)?.id ?? 0) };
      } else if (value.op === 'add-refresh' || value.op === 'remove-refresh') {
        if (value.op === 'add-refresh')
          selected.fixture.upsert({
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: { name: 'remote-refresh' },
            spec: { type: 'team', children: [] },
          });
        else selected.fixture.remove('group:default/remote-refresh');
        events.push({ event: value.op, version: selected.target.backstageVersion, at: Date.now() });
      } else if (value.op === 'cursor')
        result = { id: String(selected.fixture.requests().at(-1)?.id ?? 0) };
      else if (value.op === 'assert-read') {
        const read = selected.fixture
          .requests()
          .find(
            (entry) =>
              entry.id > (value.after ?? 0) &&
              entry.operation === 'byName' &&
              entry.status === 200 &&
              entry.principalId === 'editor-reader',
          );
        if (!read) throw new Error('No new authenticated catalog read.');
        result = { id: String(read.id) };
      } else if (value.op === 'requests') result = selected.fixture.requests();
      else throw new Error('Unknown control operation.');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    })().catch(() => {
      if (!response.destroyed) response.writeHead(500).end('Fixture control failed.');
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await matrix.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected loopback control listener.');
  return {
    token,
    controlToken,
    controlUrl: `http://127.0.0.1:${address.port}`,
    catalogs: matrix.fixtures.map(({ fixture, target }) => ({
      baseUrl: fixture.baseUrl,
      version: target.backstageVersion,
    })),
    evidence: () => ({
      events: [...events],
      fixtures: matrix.fixtures.map(({ fixture, target }) => ({
        version: target.backstageVersion,
        requests: fixture.requests(),
      })),
    }),
    async close() {
      try {
        await matrix.close();
        for (const { fixture } of matrix.fixtures) fixture.assertHealthy();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    },
  };
}

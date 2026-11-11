import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface Relation {
  source: string;
  type: string;
  target: string;
}
interface Seed {
  entities: Entity[];
  entityFiles: { entities: Entity[] }[];
  expected: { entityRefs: string[]; relations: Relation[]; absentRelations: Relation[] };
}
interface Entity {
  kind: string;
  metadata: { namespace: string; name: string };
  relations?: { type: string; targetRef: string }[];
}
const { converge } = (await import(
  pathToFileURL(path.resolve('test/integration/backstage/lib/catalog.mjs')).href
)) as { converge: (base: string, seed: Seed, token: string, timeout?: number) => Promise<unknown> };

void test('actual HTTP convergence rejects stale ownership/API edges and same-count wrong graph tuples', async (t) => {
  const seed = JSON.parse(
    await readFile('test/integration/backstage/data/mutation.json', 'utf8'),
  ) as Seed;
  const golden = (
    JSON.parse(await readFile('test/fixtures/backstage-behavior/seed-graphs.json', 'utf8')) as {
      mutation: string[][];
    }
  ).mutation;
  assert.deepEqual(seed.expected.relations.map((r) => [r.source, r.type, r.target]).sort(), golden);
  const entities = [...seed.entities, ...seed.entityFiles.flatMap((file) => file.entities)];
  const ref = (entity: Entity) =>
    `${entity.kind.toLowerCase()}:${entity.metadata.namespace}/${entity.metadata.name}`;
  let mode = 'clean';
  let requests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      requests++;
      assert.equal(request.headers.authorization, 'Bearer convergence-control');
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
        const { entityRefs } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          entityRefs: string[];
        };
        const ordered = entityRefs.map((reference) =>
          entities.find((entity) => ref(entity) === reference),
        );
        response.end(
          JSON.stringify({
            items: ordered.map((entity) =>
              entity
                ? {
                    ...entity,
                    relations: golden
                      .filter(([source]) => source === ref(entity))
                      .map(([, type, targetRef]) => ({ type, targetRef })),
                    ...(ref(entity) === 'component:bve-demo/demo-service' && mode === 'stale'
                      ? {
                          relations: [
                            { type: 'ownedBy', targetRef: 'group:bve-demo/team-next' },
                            { type: 'partOf', targetRef: 'system:bve-demo/demo-system' },
                            { type: 'ownedBy', targetRef: 'group:bve-demo/team-demo' },
                            { type: 'providesApi', targetRef: 'api:bve-demo/demo-api' },
                          ],
                        }
                      : {}),
                    ...(ref(entity) === 'resource:bve-demo/demo-database' && mode === 'wrong-tuple'
                      ? {
                          relations: [
                            { type: 'ownedBy', targetRef: 'group:bve-demo/team-demo' },
                            { type: 'partOf', targetRef: 'domain:bve-demo/demo-domain' },
                          ],
                        }
                      : {}),
                  }
                : null,
            ),
          }),
        );
      } else response.end('[]');
    })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  assert.deepEqual(await converge(base, seed, 'convergence-control', 1000), {
    entityCount: 9,
    relationCount: 18,
    absentCount: 1,
    absentRelationCount: 3,
  });
  mode = 'stale';
  await assert.rejects(converge(base, seed, 'convergence-control', 200), (error: unknown) => {
    const observed = (
      error as { observation: { unexpectedRelations: string[]; missingRelations: string[] } }
    ).observation;
    assert.deepEqual(observed.missingRelations, []);
    assert.deepEqual(observed.unexpectedRelations.sort(), [
      'component:bve-demo/demo-service/ownedBy/group:bve-demo/team-demo',
      'component:bve-demo/demo-service/providesApi/api:bve-demo/demo-api',
    ]);
    return true;
  });
  mode = 'wrong-tuple';
  await assert.rejects(converge(base, seed, 'convergence-control', 200), (error: unknown) => {
    assert.deepEqual(
      (error as { observation: { missingRelations: string[] } }).observation.missingRelations,
      ['resource:bve-demo/demo-database/partOf/system:bve-demo/demo-system'],
    );
    return true;
  });
  mode = 'clean';
  await converge(base, seed, 'convergence-control', 1000);
  assert.equal(requests, 8);
});

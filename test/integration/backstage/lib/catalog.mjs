import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { entityRef } from './seed.mjs';

export async function request(
  base,
  endpoint,
  { token, method = 'GET', body, timeout = 5000 } = {},
) {
  const response = await globalThis.fetch(base.replace(/\/$/u, '') + endpoint, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: globalThis.AbortSignal.timeout(timeout),
    redirect: 'error',
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}
export async function readEntities(base, refs, token) {
  const result = await request(base, '/api/catalog/entities/by-refs', {
    token,
    method: 'POST',
    body: { entityRefs: refs },
  });
  assert.equal(result.status, 200, 'Require an authenticated catalog batch.');
  assert(Array.isArray(result.body.items) && result.body.items.length === refs.length);
  return result.body.items;
}
export async function converge(base, seed, token, timeout = 120_000) {
  const deadline = performance.now() + timeout;
  let last = { stage: 'not-read' };
  const expected = new Map(
    [...seed.entities, ...seed.entityFiles.flatMap((f) => f.entities)].map((e) => [
      entityRef(e),
      e,
    ]),
  );
  while (performance.now() < deadline) {
    last = {
      stage: 'catalog-convergence',
      missing: [],
      unexpectedPresent: [],
      bodyMismatch: [],
      missingRelations: [],
      unexpectedRelations: [],
      processingErrors: [],
    };
    try {
      const refs = [...seed.expected.entityRefs, ...seed.expected.absentEntityRefs];
      const actual = await readEntities(base, refs, token);
      for (let i = 0; i < refs.length; i++) {
        const entity = actual[i];
        const authored = expected.get(refs[i]);
        if (!authored) {
          if (entity) last.unexpectedPresent.push(refs[i]);
          continue;
        }
        if (!entity) {
          last.missing.push(refs[i]);
          continue;
        }
        if (entityRef(entity) !== refs[i] || !isDeepStrictEqual(entity.spec, authored.spec))
          last.bodyMismatch.push(refs[i]);
        if (entity.status?.items?.some((entry) => entry.level === 'error'))
          last.processingErrors.push(refs[i]);
        for (const relation of seed.expected.relations.filter((r) => r.source === refs[i]))
          if (
            !entity.relations?.some(
              (r) => r.type === relation.type && r.targetRef === relation.target,
            )
          )
            last.missingRelations.push(
              relation.source + '/' + relation.type + '/' + relation.target,
            );
        for (const relation of seed.expected.absentRelations.filter((r) => r.source === refs[i]))
          if (
            entity.relations?.some(
              (r) => r.type === relation.type && r.targetRef === relation.target,
            )
          )
            last.unexpectedRelations.push(
              relation.source + '/' + relation.type + '/' + relation.target,
            );
      }
      const locations = await request(base, '/api/catalog/entities?filter=kind=location', {
        token,
      });
      assert.equal(locations.status, 200);
      for (const entity of locations.body)
        if (entity.status?.items?.some((entry) => entry.level === 'error'))
          last.processingErrors.push(entityRef(entity));
      if (
        [
          last.missing,
          last.unexpectedPresent,
          last.bodyMismatch,
          last.missingRelations,
          last.unexpectedRelations,
          last.processingErrors,
        ].every((items) => items.length === 0)
      )
        return {
          entityCount: seed.expected.entityRefs.length,
          relationCount: seed.expected.relations.length,
          absentCount: seed.expected.absentEntityRefs.length,
          absentRelationCount: seed.expected.absentRelations.length,
        };
      for (const key of [
        'missing',
        'unexpectedPresent',
        'bodyMismatch',
        'missingRelations',
        'unexpectedRelations',
        'processingErrors',
      ])
        last[key] = last[key].slice(0, 16);
    } catch {
      last.requestFailure = 'catalog_http_or_shape_error';
    }
    await delay(250);
  }
  const error = new Error('Catalog convergence deadline expired.');
  error.observation = last;
  throw error;
}

export async function refresh(base, token) {
  const locations = await request(base, '/api/catalog/entities?filter=kind=location', { token });
  assert.equal(locations.status, 200);
  for (const entity of locations.body) {
    const result = await request(base, '/api/catalog/refresh', {
      token,
      method: 'POST',
      body: { entityRef: entityRef(entity) },
    });
    assert.equal(result.status, 200);
  }
}

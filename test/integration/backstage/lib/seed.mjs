import { TextDecoder } from 'node:util';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile, open } from 'node:fs/promises';
import path from 'node:path';

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const digest = (value) =>
  'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
export function entityRef(entity) {
  assert(entity && typeof entity === 'object' && typeof entity.kind === 'string');
  assert(entity.metadata && typeof entity.metadata.name === 'string');
  return `${entity.kind}:${entity.metadata.namespace ?? 'default'}/${entity.metadata.name}`.toLowerCase();
}
export function validateSeed(seed) {
  const pending = [{ value: seed, depth: 0 }];
  const visited = new WeakSet();
  let values = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    assert(++values <= 100_000 && depth <= 64, 'Bound seed JSON values and depth.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      assert(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
      continue;
    }
    assert(
      value &&
        typeof value === 'object' &&
        [Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)),
      'Use plain JSON values.',
    );
    assert(!visited.has(value), 'Seed JSON cannot contain cycles or shared object references.');
    visited.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      assert(Object.hasOwn(descriptor, 'value'), 'Seed values cannot contain accessors.');
      pending.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
  assert(seed && typeof seed === 'object' && !Array.isArray(seed), 'Supply a JSON seed object.');
  assert.deepEqual(Object.keys(seed).sort(), [
    'entities',
    'entityFiles',
    'expected',
    'id',
    'schemaVersion',
  ]);
  assert.equal(seed.schemaVersion, 1, 'Use seed schema version 1.');
  assert.match(seed.id, /^[a-z0-9][a-z0-9-]{0,63}$/u);
  assert(Array.isArray(seed.entities) && seed.entities.length > 0 && seed.entities.length <= 1000);
  assert(Array.isArray(seed.entityFiles) && seed.entityFiles.length <= 32);
  const files = [{ filename: 'entities.yaml', entities: seed.entities }, ...seed.entityFiles];
  const filenames = new Set();
  const refs = new Set();
  for (const file of files) {
    assert.deepEqual(Object.keys(file).sort(), ['entities', 'filename']);
    assert.match(
      file.filename,
      /^[a-z0-9][a-z0-9-]{0,63}\.yaml$/u,
      'Use a contained catalog filename.',
    );
    assert(!filenames.has(file.filename), 'Catalog filenames must be unique.');
    filenames.add(file.filename);
    assert(
      Array.isArray(file.entities) && file.entities.length > 0 && file.entities.length <= 1000,
    );
    for (const entity of file.entities) {
      const ref = entityRef(entity);
      assert(
        ['Group', 'User', 'Component', 'API', 'System', 'Domain', 'Resource', 'Location'].includes(
          entity.kind,
        ),
      );
      assert.equal(entity.metadata.namespace, 'bve-demo');
      assert.match(entity.metadata.name, /^[a-z0-9][a-z0-9-]*$/u);
      assert.match(entity.apiVersion, /^[a-z0-9./-]+$/u);
      assert.match(ref, /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u);
      assert(!refs.has(ref), 'Entity identities must be unique.');
      refs.add(ref);
    }
  }
  assert(refs.size <= 1000, 'Limit the complete seed to 1000 entities.');
  assert.deepEqual(Object.keys(seed.expected).sort(), [
    'absentEntityRefs',
    'absentRelations',
    'entityRefs',
    'relations',
  ]);
  assert.deepEqual(
    [...seed.expected.entityRefs].sort(),
    [...refs].sort(),
    'Expected references must match authored entities.',
  );
  assert.equal(new Set(seed.expected.entityRefs).size, refs.size);
  assert(Array.isArray(seed.expected.absentEntityRefs));
  for (const ref of seed.expected.absentEntityRefs) {
    assert.match(ref, /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u);
    assert(!refs.has(ref));
  }
  assert(Array.isArray(seed.expected.relations));
  for (const relation of seed.expected.relations) {
    assert.deepEqual(Object.keys(relation).sort(), ['source', 'target', 'type']);
    assert(
      refs.has(relation.source) && refs.has(relation.target),
      'Relations must name authored entities.',
    );
    assert.match(relation.type, /^[a-zA-Z][a-zA-Z0-9]+$/u);
  }
  assert(Array.isArray(seed.expected.absentRelations));
  const declaredRefs = new Set([...refs, ...seed.expected.absentEntityRefs]);
  const requiredTuples = new Set(seed.expected.relations.map(canonical));
  const absentTuples = new Set();
  for (const relation of seed.expected.absentRelations) {
    assert.deepEqual(Object.keys(relation).sort(), ['source', 'target', 'type']);
    assert(
      refs.has(relation.source) && declaredRefs.has(relation.target),
      'Absent relations must name declared entities.',
    );
    assert.match(relation.type, /^[a-zA-Z][a-zA-Z0-9]+$/u);
    const tuple = canonical(relation);
    assert(
      !requiredTuples.has(tuple) && !absentTuples.has(tuple),
      'Relation expectations cannot conflict or repeat.',
    );
    absentTuples.add(tuple);
  }
  const edges = new Map(files.map((file) => [file.filename, []]));
  for (const file of files)
    for (const entity of file.entities)
      if (entity.kind.toLowerCase() === 'location') {
        assert.equal(entity.spec.type, 'file');
        const targets = [
          ...(entity.spec.target ? [entity.spec.target] : []),
          ...(entity.spec.targets ?? []),
        ];
        for (const target of targets) {
          assert(
            target.startsWith('./') && filenames.has(target.slice(2)),
            'Location targets must name generated payload files.',
          );
          edges.get(file.filename).push(target.slice(2));
          assert.notEqual(
            target.slice(2),
            file.filename,
            'Location targets cannot point to their own file.',
          );
        }
      }
  const active = new Set();
  const complete = new Set();
  function visit(name) {
    assert(!active.has(name), 'Location payload files cannot form cycles.');
    if (complete.has(name)) return;
    active.add(name);
    for (const target of edges.get(name)) visit(target);
    active.delete(name);
    complete.add(name);
  }
  for (const name of filenames) visit(name);
  assert(Buffer.byteLength(canonical(seed)) <= 1024 * 1024, 'Limit seed input to one MiB.');
  return seed;
}
export async function renderSeed(seed, directory) {
  validateSeed(seed);
  await mkdir(directory, { recursive: true });
  // JSON is a YAML 1.2 subset. Document separators preserve one entity per document.
  // Install payloads before the root file so a root refresh cannot observe missing payloads.
  const files = [...seed.entityFiles, { filename: 'entities.yaml', entities: seed.entities }];
  const outputs = [];
  for (const file of files) {
    const body =
      file.entities.map((entity) => JSON.stringify(entity, null, 2)).join('\n---\n') + '\n';
    const destination = path.join(directory, file.filename);
    const temporary = destination + '.next';
    await writeFile(temporary, body, { mode: 0o644 });
    await rename(temporary, destination);
    outputs.push({
      filename: file.filename,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  }
  return { seedId: seed.id, seedDigest: digest(seed), files: outputs };
}

export async function loadSeed(filename) {
  const file = await open(filename, 'r');
  try {
    const metadata = await file.stat();
    assert(
      metadata.isFile() && metadata.size <= 1024 * 1024,
      'Use a seed file no larger than one MiB.',
    );
    const body = Buffer.alloc(metadata.size + 1);
    let bytesRead = 0;
    while (bytesRead < body.length) {
      const chunk = await file.read(body, bytesRead, body.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await file.stat();
    assert(
      bytesRead === metadata.size &&
        after.size === metadata.size &&
        after.mtimeMs === metadata.mtimeMs,
      'The seed file changed during capture.',
    );
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, bytesRead));
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('Seed JSON could not be parsed.');
    }
    return validateSeed(value);
  } finally {
    await file.close();
  }
}

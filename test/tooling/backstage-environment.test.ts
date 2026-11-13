import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import { parseAllDocuments } from 'yaml';
import { digestJson } from '../../src/index.js';

interface Entity {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string };
  spec: Record<string, unknown>;
}
interface Seed {
  schemaVersion: number;
  id: string;
  entities: Entity[];
  entityFiles: { filename: string; entities: Entity[] }[];
  expected: {
    entityRefs: string[];
    absentEntityRefs: string[];
    absentRelations: { source: string; type: string; target: string }[];
    relations: { source: string; type: string; target: string }[];
  };
}
const directory = path.resolve('test/integration/backstage');
const { validateSeed, renderSeed, digest, loadSeed } = (await import(
  pathToFileURL(path.join(directory, 'lib/seed.mjs')).href
)) as {
  validateSeed: (input: unknown) => Seed;
  renderSeed: (
    input: Seed,
    destination: string,
  ) => Promise<{ seedDigest: string; files: { filename: string; sha256: string }[] }>;
  digest: (input: unknown) => string;
  loadSeed: (filename: string) => Promise<Seed>;
};
const load = async (name: string): Promise<Seed> =>
  JSON.parse(await readFile(path.join(directory, 'data', name + '.json'), 'utf8')) as Seed;

void test('Backstage seeds satisfy the owned schema and retain all eight kinds and actual relation expectations', async () => {
  const schema = JSON.parse(
    await readFile(path.join(directory, 'catalog-seed.schema.json'), 'utf8'),
  ) as object;
  const validate = new Ajv({ strict: true }).compile(schema);
  for (const name of ['baseline', 'mutation']) {
    const seed = await load(name);
    assert(validate(seed), JSON.stringify(validate.errors));
    validateSeed(seed);
    assert.equal(digest(seed), digestJson(seed));
  }
  const baseline = await load('baseline');
  assert.deepEqual([...new Set(baseline.entities.map((entity) => entity.kind))].sort(), [
    'API',
    'Component',
    'Domain',
    'Group',
    'Location',
    'Resource',
    'System',
    'User',
  ]);
  assert.equal(baseline.expected.entityRefs.length, 9);
  const golden = JSON.parse(
    await readFile('test/fixtures/backstage-behavior/seed-graphs.json', 'utf8'),
  ) as Record<string, string[][]>;
  for (const name of ['baseline', 'mutation']) {
    const seed = await load(name);
    assert.deepEqual(
      seed.expected.relations.map((r) => [r.source, r.type, r.target]).sort(),
      golden[name],
    );
  }
  assert.equal(baseline.expected.relations.length, 22);
  assert.equal((await load('mutation')).expected.relations.length, 18);
  assert.equal((await load('mutation')).expected.absentRelations.length, 3);
  const wrongVersion = { ...baseline, schemaVersion: 2 };
  assert.equal(validate(wrongVersion), false);
  assert.throws(() => validateSeed(wrongVersion));
});

void test('Backstage seed admission rejects conflicting identity, unsafe file paths, unknown expectations and cyclic Location input', async () => {
  const source = await load('baseline');
  const changes: ((seed: Seed) => void)[] = [
    (seed) => seed.entities.push(structuredClone(seed.entityFiles[0]!.entities[0]!)),
    (seed) => {
      seed.entityFiles[0]!.filename = '../outside.yaml';
    },
    (seed) => {
      seed.entityFiles[0]!.filename = 'C:\\outside.yaml';
    },
    (seed) => {
      seed.entities[0]!.metadata.namespace = 'outside-fixture';
    },
    (seed) => {
      seed.expected.entityRefs.pop();
    },
    (seed) => {
      seed.expected.relations[0]!.target = 'group:bve-demo/unknown';
    },
    (seed) => {
      seed.expected.absentRelations.push(structuredClone(seed.expected.relations[0]!));
    },
    (seed) => {
      seed.expected.absentRelations.push({
        source: seed.expected.entityRefs[0]!,
        type: 'ownedBy',
        target: 'group:bve-demo/unknown',
      });
    },
    (seed) => {
      seed.expected.absentEntityRefs.push(seed.expected.entityRefs[0]!);
    },
    (seed) => {
      const child = seed.entityFiles[0]!.entities[0]!;
      const previous = 'component:bve-demo/' + child.metadata.name;
      child.kind = 'Location';
      child.spec = { type: 'file', target: './entities.yaml' };
      seed.expected.entityRefs = seed.expected.entityRefs.map((ref) =>
        ref === previous ? 'location:bve-demo/' + child.metadata.name : ref,
      );
    },
  ];
  for (const change of changes) {
    const seed = structuredClone(source);
    change(seed);
    assert.throws(() => validateSeed(seed));
  }
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => validateSeed(cyclic));
  let executed = false;
  assert.throws(() =>
    validateSeed({
      get schemaVersion() {
        executed = true;
        return 1;
      },
    }),
  );
  assert.equal(executed, false);
});

void test('Backstage rendering preserves authored API text, replaces complete documents, and never writes outside the selected catalog directory', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'bve-seed-'));
  try {
    const destination = path.join(temporary, 'catalog');
    await mkdir(destination);
    const untouched = path.join(temporary, 'untouched');
    await writeFile(untouched, 'preserve');
    const baseline = await load('baseline');
    const first = await renderSeed(baseline, destination);
    const body = await readFile(path.join(destination, 'entities.yaml'), 'utf8');
    const parsed = parseAllDocuments(body).map((document) => document.toJSON() as Entity);
    assert.deepEqual(parsed, baseline.entities);
    assert.equal(
      parsed.find((entity) => entity.kind === 'API')!.spec.definition,
      baseline.entities.find((entity) => entity.kind === 'API')!.spec.definition,
    );
    assert.deepEqual(await renderSeed(baseline, destination), first);
    const mutation = await load('mutation');
    await renderSeed(mutation, destination);
    assert.deepEqual(
      parseAllDocuments(await readFile(path.join(destination, 'entities.yaml'), 'utf8')).map(
        (document) => document.toJSON() as Entity,
      ),
      mutation.entities,
    );
    assert.equal(await readFile(untouched, 'utf8'), 'preserve');
    assert((await readdir(destination)).every((name) => name.endsWith('.yaml')));
    const unsafe = structuredClone(baseline);
    unsafe.entityFiles[0]!.filename = '../untouched';
    await assert.rejects(renderSeed(unsafe, destination));
    assert.equal(await readFile(untouched, 'utf8'), 'preserve');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

void test('Backstage seed capture rejects malformed JSON, invalid UTF-8 and oversized files before rendering', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'bve-seed-capture-'));
  try {
    const file = path.join(temporary, 'seed.json');
    const seed = await load('baseline');
    await writeFile(file, JSON.stringify(seed));
    assert.deepEqual(await loadSeed(file), seed);
    await writeFile(file, '{"schemaVersion":');
    await assert.rejects(loadSeed(file), /Seed JSON could not be parsed/u);
    await writeFile(file, Buffer.from([0xff, 0xfe]));
    await assert.rejects(loadSeed(file));
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1, 32));
    await assert.rejects(loadSeed(file), /one MiB/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

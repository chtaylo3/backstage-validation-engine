import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import { ContractError, contractSchemas, createDataSnapshot, parseContract } from '../src/index.js';
import type { ContractTypes, DataEntry } from '../src/index.js';
import { NOW, makeRequest } from './helpers.js';

void test('rejects prototype contracts and caller-supplied authority flags', () => {
  assert.throws(
    () => parseContract('validation-request', { ...makeRequest(), contractVersion: '0.1' }),
    ContractError,
  );
  assert.throws(
    () => parseContract('validation-request', { ...makeRequest(), authorized: true }),
    ContractError,
  );
  const request = makeRequest();
  assert.throws(
    () =>
      parseContract('validation-request', {
        ...request,
        execution: { ...request.execution, deadlineAt: NOW + 5001 },
      }),
    /5 seconds/,
  );
  assert.throws(
    () =>
      parseContract('validation-request', { ...request, run: { ...request.run, generation: 2 } }),
    /generations/,
  );
  assert(Object.isFrozen(request.source.files));
});

void test('requests reject expired provider snapshots and cross-installation or permission data', () => {
  const request = makeRequest();
  const provenance = {
    providerId: 'catalog',
    connectionId: 'primary',
    installationId: 'installation-1',
    principalId: 'principal-1',
    permissionRevision: 'permissions-1',
    scope: ['catalog:read'],
    revision: 'catalog-42',
    fetchedAt: NOW - 1000,
    expiresAt: NOW + 1000,
  };
  for (const overrides of [
    { installationId: 'other' },
    { permissionRevision: 'other' },
    { expiresAt: NOW },
    { fetchedAt: NOW + 1 },
  ]) {
    const data = createDataSnapshot([
      { key: 'owner', status: 'missing', provenance: { ...provenance, ...overrides } },
    ]);
    assert.throws(() => parseContract('validation-request', { ...request, data }), ContractError);
  }
  const data = createDataSnapshot([
    { key: 'owner', status: 'unavailable', reason: 'permission_denied', provenance },
  ]);
  assert.equal(
    parseContract('validation-request', { ...request, data }).data.entries[0]?.status,
    'unavailable',
  );
});

void test('schema errors omit rejected values', () => {
  const input = { ...makeRequest(), contractVersion: 'sensitive-secret-value' };
  assert.throws(
    () => parseContract('validation-request', input),
    (error: unknown) => {
      assert(error instanceof ContractError);
      assert(!error.message.includes('sensitive-secret-value'));
      assert(error.issues.some((issue) => issue.path === '/contractVersion'));
      return true;
    },
  );
});

void test('provider entry static type preserves present JSON payloads', () => {
  const entry: DataEntry = {
    key: 'x',
    status: 'present',
    value: { nested: [null, 1, true] },
    provenance: {
      providerId: 'p',
      connectionId: 'c',
      installationId: 'i',
      principalId: 'u',
      permissionRevision: 'r',
      scope: [],
      revision: 'v',
      fetchedAt: 0,
      expiresAt: 1,
    },
  };
  assert.deepEqual(createDataSnapshot([entry]).entries[0], entry);
});

void test('checked-in wire examples satisfy emitted schemas and production semantic checks', async () => {
  const ajv = new Ajv({ strict: true, allErrors: true });
  for (const name of Object.keys(contractSchemas)) {
    const emitted: unknown = JSON.parse(
      await readFile(resolve('schemas', `${name}.schema.json`), 'utf8'),
    );
    ajv.addSchema(emitted as object);
  }
  const examples = resolve('examples/contracts');
  const names: Record<string, keyof ContractTypes> = {
    'source-snapshot.json': 'source-snapshot',
    'data-snapshot.json': 'data-snapshot',
    'deployment-profile.json': 'deployment-profile',
    'policy-bundle.json': 'policy-bundle',
    'activation-manifest.json': 'activation-manifest',
    'validation-request.json': 'validation-request',
  };
  const expected: Record<string, readonly [string, string]> = {
    'result-passed.json': ['completed', 'allow'],
    'result-rule-false.json': ['completed', 'block'],
    'result-invalid-policy.json': ['error', 'block'],
    'result-unsupported-processor.json': ['incomplete', 'block'],
    'result-catalog-unavailable.json': ['incomplete', 'block'],
    'result-timeout.json': ['incomplete', 'block'],
    'result-bypassed.json': ['bypassed', 'allow'],
  };
  const files = (await readdir(examples)).filter((file) => file.endsWith('.json')).sort();
  assert.equal(files.length, Object.keys(names).length + Object.keys(expected).length);
  for (const file of files) {
    const name = names[file] ?? 'validation-result';
    const input: unknown = JSON.parse(await readFile(resolve(examples, file), 'utf8'));
    const id = contractSchemas[name].$id;
    assert(id);
    const validate = ajv.getSchema(id);
    assert(validate);
    assert(validate(input), `${file}: ${ajv.errorsText(validate.errors)}`);
    parseContract(name, input);
    if (file in expected) {
      const result = parseContract('validation-result', input);
      assert.deepEqual([result.outcome, result.enforcement], expected[file], file);
    }
  }
});

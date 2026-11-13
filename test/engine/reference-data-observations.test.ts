import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stringify } from 'yaml';
import {
  ContractError,
  createDataSnapshot,
  digestJson,
  prepareBackstageReferenceData,
} from '../../src/index.js';
import type { CatalogProvider, DataEntry } from '../../src/index.js';
import { PROPOSED_CATALOG_PROVIDER } from '../../src/pipeline/proposed-catalog.js';
import { catalogEntityKey } from '../../src/providers/catalog.js';
import { ManualClock } from '../harness/manual-clock.js';
import { componentText, policyRun } from '../harness/policy-fixture.js';

/*
 * How `prepareBackstageReferenceData` treats each shape of provider response. Every target is
 * blocked, answered by the proposed catalog, or sent to the provider; `lookupCatalog` validates the
 * provider's answer before `observeTargets` builds one observation per target.
 */
const ROOT = 'file:///workspace/';
const CONNECTION = 'stub';
const group = (name: string, spec: Record<string, unknown> = { type: 'team', children: [] }) =>
  stringify({ apiVersion: 'backstage.io/v1alpha1', kind: 'Group', metadata: { name }, spec });
const component = (name: string, owner: string) =>
  componentText(owner).replace('name: service', `name: ${name}`);

/** A request whose Components own the given teams, with optional extra source files. */
function scenario(owners: readonly string[], files: readonly { uri: string; text: string }[] = []) {
  const [first, ...rest] = owners;
  return policyRun({
    mode: 'ci',
    rootUri: ROOT,
    text: component('service-0', first!),
    files: [
      ...rest.map((owner, index) => ({
        uri: `${ROOT}service-${index + 1}.yaml`,
        text: component(`service-${index + 1}`, owner),
      })),
      ...files,
    ],
  });
}
type Run = ReturnType<typeof scenario>;
function accessFor(run: Run) {
  return {
    installationId: run.request.identity.installationId,
    principalId: 'reader',
    permissionRevision: run.request.identity.permissionRevision,
    credentialRevision: '1',
    scope: ['catalog:read'],
    profileDigest: run.request.profile.digest,
    policyDigest: run.request.policy.digest,
    maxAgeMs: 0,
  };
}
/** A snapshot built by hand, so that a duplicated key reaches the engine's own parsing. */
function rawSnapshot(entries: readonly DataEntry[]) {
  const content = { contractVersion: createDataSnapshot([]).contractVersion, entries };
  return { ...content, digest: digestJson(content) };
}
/**
 * Runs the preparation with a stub provider. `answer` receives the requested targets and a
 * builder of one well-formed entry, and returns the entries the provider reports.
 */
function prepare(
  run: Run,
  answer: (
    refs: readonly string[],
    entry: (ref: string, status?: 'present' | 'missing') => DataEntry,
  ) => readonly DataEntry[] | Promise<never>,
) {
  const clock = new ManualClock(run.request.execution.startedAt, 1000);
  const access = accessFor(run);
  const asked: (readonly string[])[] = [];
  const provider: CatalogProvider = {
    connectionId: CONNECTION,
    adapterId: run.context.profile.adapterId,
    lookup: async (refs) => {
      asked.push([...refs]);
      const provenance = {
        providerId: 'backstage-catalog',
        connectionId: CONNECTION,
        installationId: access.installationId,
        principalId: access.principalId,
        permissionRevision: access.permissionRevision,
        scope: access.scope,
        revision: 'stub-1',
        fetchedAt: clock.wall(),
        expiresAt: clock.wall() + 60_000,
      };
      const entry = (ref: string, status: 'present' | 'missing' = 'present'): DataEntry =>
        status === 'present'
          ? {
              key: catalogEntityKey(CONNECTION, ref),
              status,
              value: { kind: 'Group', ref },
              provenance,
            }
          : { key: catalogEntityKey(CONNECTION, ref), status, provenance };
      const entries = await answer(refs, entry);
      return { data: rawSnapshot(entries), failures: [], interrupted: 'none' };
    },
    stats: () => ({ active: 0, queued: 0, cacheEntries: 0, cacheBytes: 0 }),
    close: () => Promise.resolve(),
  };
  const result = prepareBackstageReferenceData(run.request, run.context, {
    provider,
    access,
    clock,
    referencePaths: ['/spec/owner'],
  });
  return { result, asked };
}
const rejectsWith = (code: string, message: string) => (error: unknown) => {
  assert.ok(error instanceof ContractError, String(error));
  assert.equal(error.code, code);
  assert.equal(error.issues[0]?.message, message);
  // The response was rejected before `observeTargets` could meet an unanswered target.
  assert.notEqual(error.issues[0]?.message, 'catalog observation is missing');
  return true;
};
const SET_DIFFERS = 'catalog observation set differs from request';
const AUTHORITY_DIFFERS = 'catalog observation authority differs from request';

void test('a provider response with a duplicated key is rejected while the response is parsed', async () => {
  const { result, asked } = prepare(scenario(['team-a', 'team-b']), (refs, entry) => [
    entry(refs[0]!),
    entry(refs[0]!),
  ]);
  // The data-snapshot contract requires distinct keys, so the duplicate never reaches the
  // observation step: it is rejected inside `lookupCatalog` by `parseContract('data-snapshot')`.
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof ContractError, String(error));
    assert.equal(error.code, 'invalid_contract');
    assert.deepEqual(error.issues, [{ path: '/entries', message: 'duplicate identities' }]);
    return true;
  });
  assert.deepEqual(asked, [['group:default/team-a', 'group:default/team-b']]);
});

void test('a provider response with too few or too many entries is rejected as a different set', async () => {
  const fewer = prepare(scenario(['team-a', 'team-b']), (refs, entry) => [entry(refs[0]!)]);
  await assert.rejects(fewer.result, rejectsWith('integrity', SET_DIFFERS));
  const more = prepare(scenario(['team-a', 'team-b']), (refs, entry) => [
    ...refs.map((ref) => entry(ref)),
    entry('group:default/team-z'),
  ]);
  await assert.rejects(more.result, rejectsWith('integrity', SET_DIFFERS));
});

void test('a provider entry for a target that was not requested is rejected as a different authority', async () => {
  const { result } = prepare(scenario(['team-a', 'team-b']), (refs, entry) => [
    entry(refs[0]!),
    entry('group:default/team-z'),
  ]);
  await assert.rejects(result, rejectsWith('integrity', AUTHORITY_DIFFERS));
});

void test('a provider entry for a target the proposed catalog answered is rejected', async () => {
  const local = { uri: `${ROOT}local-team.yaml`, text: group('local-team') };
  const instead = prepare(scenario(['local-team', 'remote-team'], [local]), (_refs, entry) => [
    entry('group:default/local-team'),
  ]);
  await assert.rejects(instead.result, rejectsWith('integrity', AUTHORITY_DIFFERS));
  // The provider is asked only for the target that the sources did not answer.
  assert.deepEqual(instead.asked, [['group:default/remote-team']]);
  const besides = prepare(scenario(['local-team', 'remote-team'], [local]), (refs, entry) => [
    ...refs.map((ref) => entry(ref)),
    entry('group:default/local-team'),
  ]);
  await assert.rejects(besides.result, rejectsWith('integrity', SET_DIFFERS));
});

void test('a well-formed provider response gives one observation per target in target order', async () => {
  const { result, asked } = prepare(scenario(['team-b', 'team-a']), (refs, entry) =>
    // Answered in reverse order, once each.
    [...refs].reverse().map((ref, index) => entry(ref, index ? 'present' : 'missing')),
  );
  const preparation = await result;
  assert.deepEqual(asked, [['group:default/team-a', 'group:default/team-b']]);
  assert.deepEqual(
    preparation.observations.map((row) => [row.targetRef, row.status]),
    [
      ['group:default/team-a', 'present'],
      ['group:default/team-b', 'missing'],
    ],
  );
  assert.equal(preparation.interrupted, 'none');
  assert.equal(preparation.pinFailure, undefined);
});

void test('a failed lookup blocks every eligible target as a provider failure', async () => {
  const { result, asked } = prepare(scenario(['team-a', 'team-b']), () =>
    Promise.reject(new Error('provider down')),
  );
  const preparation = await result;
  assert.equal(asked.length, 1);
  assert.deepEqual(
    preparation.observations.map((row) => [
      row.targetRef,
      row.status,
      'reason' in row ? row.reason : undefined,
    ]),
    [
      ['group:default/team-a', 'blocked', 'provider_failure'],
      ['group:default/team-b', 'blocked', 'provider_failure'],
    ],
  );
});

void test('mixed targets give a blocked, a proposed-catalog and a provider observation', async () => {
  const { result, asked } = prepare(
    scenario(
      ['blocked-team', 'local-team', 'remote-team'],
      [
        // Claims its identity but is not accepted: the proposed catalog blocks the target.
        { uri: `${ROOT}blocked-team.yaml`, text: group('blocked-team', { children: 7 }) },
        { uri: `${ROOT}local-team.yaml`, text: group('local-team') },
      ],
    ),
    (refs, entry) => refs.map((ref) => entry(ref)),
  );
  const preparation = await result;
  assert.deepEqual(asked, [['group:default/remote-team']]);
  assert.deepEqual(
    preparation.observations.map((row) => [
      row.targetRef,
      row.status,
      'reason' in row ? row.reason : row.provenance.providerId,
    ]),
    [
      ['group:default/blocked-team', 'blocked', 'local_source'],
      ['group:default/local-team', 'present', PROPOSED_CATALOG_PROVIDER],
      ['group:default/remote-team', 'present', 'backstage-catalog'],
    ],
  );
});

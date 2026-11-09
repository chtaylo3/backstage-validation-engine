import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface Case {
  id: string;
  scope: string;
  editorVersion?: string;
  status: 'passed' | 'failed' | 'unexecuted';
  phase: string;
  durationMs: number;
}
interface Counts {
  discovered: number;
  executed: number;
  passed: number;
  failed: number;
  unexecuted: number;
}
interface Expected {
  revision: string;
  cliSha256: string;
  vsixSha256: string;
  inventoryDigest: string;
  seedDigests: { baseline: string; mutation: string };
  policyDigest: string;
  targets: string[];
  cases: { id: string; scope: string }[];
  details: Record<
    string,
    {
      sourceCommit: string;
      packages: Record<string, string>;
      lockfileDigest: string;
      baseImage: string;
    }
  >;
}
interface Target {
  target: string;
  sourceCommit: string;
  packages: Record<string, string>;
  lockfileDigest: string;
  baseImage: string;
  imageId: string;
  testImageId: string;
  sqliteVersion: string;
  sqliteDriverVersion: string;
  editorVersions: string[];
  policyDigest: string;
  cases: Case[];
  counts: Counts;
  cleanup: { status: string };
}
interface Report {
  schemaVersion: number;
  mode: string;
  status: string;
  revision: string;
  candidates: {
    cli: { revision: string; sha256: string };
    vsix: { revision: string; sha256: string };
  };
  inventoryDigest: string;
  seedDigests: { baseline: string; mutation: string };
  policyDigest: string;
  targets: Target[];
  counts: Counts;
  cleanup: { status: string };
  startedAt: string;
  completedAt: string;
}
const { loadBackstageExpectations, verifyBackstageEvidence } = (await import(
  pathToFileURL(path.resolve('scripts/backstage-release-evidence.mjs')).href
)) as {
  loadBackstageExpectations: (
    root: string,
    candidates: { revision: string; cliSha256: string; vsixSha256: string },
  ) => Promise<Expected>;
  verifyBackstageEvidence: (report: Report, expected: Expected) => true;
};
const candidates = {
  revision: 'a'.repeat(40),
  cliSha256: 'b'.repeat(64),
  vsixSha256: 'c'.repeat(64),
};
const count = (n: number): Counts => ({
  discovered: n,
  executed: n,
  passed: n,
  failed: 0,
  unexecuted: 0,
});
function report(expected: Expected): Report {
  const cases: Case[] = expected.cases.flatMap((row) =>
    (row.scope === 'editor' ? ['1.106.3', '1.145.2'] : [undefined]).map((editorVersion) => ({
      ...row,
      ...(editorVersion ? { editorVersion } : {}),
      status: 'passed' as const,
      phase: 'complete',
      durationMs: 1,
    })),
  );
  return {
    schemaVersion: 1,
    mode: 'release',
    status: 'passed',
    revision: expected.revision,
    candidates: {
      cli: { revision: expected.revision, sha256: expected.cliSha256 },
      vsix: { revision: expected.revision, sha256: expected.vsixSha256 },
    },
    inventoryDigest: expected.inventoryDigest,
    seedDigests: { ...expected.seedDigests },
    policyDigest: expected.policyDigest,
    targets: expected.targets.map((target) => ({
      target,
      ...structuredClone(expected.details[target]!),
      imageId: 'sha256:' + 'd'.repeat(64),
      testImageId: 'sha256:' + 'e'.repeat(64),
      sqliteVersion: '3.50.4',
      sqliteDriverVersion: '12.4.1',
      editorVersions: ['1.106.3', '1.145.2'],
      policyDigest: expected.policyDigest,
      cases: structuredClone(cases),
      counts: count(cases.length),
      cleanup: { status: 'passed' },
    })),
    counts: count(cases.length * expected.targets.length),
    cleanup: { status: 'passed' },
    startedAt: '2026-11-08T00:00:00.000Z',
    completedAt: '2026-11-08T00:01:00.000Z',
  };
}

void test('real-backend release expectations derive from candidate inventory, seeds, policy and lockfiles', async () => {
  const expected = await loadBackstageExpectations(path.resolve('.'), candidates);
  assert.deepEqual(expected.targets, ['1.55.3', '1.56.3']);
  assert(expected.cases.length > 0);
  assert.equal(verifyBackstageEvidence(report(expected), expected), true);
  assert.match(expected.inventoryDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(expected.seedDigests.baseline, expected.seedDigests.mutation);
});

void test('release gate rejects different application inputs, client artifacts, missing cases and unfinished cleanup', async () => {
  const expected = await loadBackstageExpectations(path.resolve('.'), candidates);
  const mutations: ((row: Report) => void)[] = [
    (row) => {
      row.mode = 'development';
    },
    (row) => {
      row.revision = 'f'.repeat(40);
    },
    (row) => {
      row.candidates.cli.sha256 = 'f'.repeat(64);
    },
    (row) => {
      row.candidates.vsix.revision = 'f'.repeat(40);
    },
    (row) => {
      row.inventoryDigest = 'sha256:' + 'f'.repeat(64);
    },
    (row) => {
      row.seedDigests.baseline = row.seedDigests.mutation;
    },
    (row) => {
      row.policyDigest = 'sha256:' + 'f'.repeat(64);
    },
    (row) => {
      row.targets[0]!.sourceCommit = 'f'.repeat(40);
    },
    (row) => {
      row.targets[0]!.packages['@backstage/plugin-catalog-backend'] = '0.0.0';
    },
    (row) => {
      row.targets[0]!.lockfileDigest = 'sha256:' + 'f'.repeat(64);
    },
    (row) => {
      row.targets[0]!.baseImage = 'node:latest';
    },
    (row) => {
      row.targets[0]!.cases.pop();
    },
    (row) => {
      row.targets[0]!.cases.push(structuredClone(row.targets[0]!.cases[0]!));
    },
    (row) => {
      row.targets[0]!.cases[0]!.status = 'failed';
    },
    (row) => {
      row.targets[0]!.cases[0]!.phase = 'running';
    },
    (row) => {
      row.targets[0]!.cases[0]!.status = 'unexecuted';
    },
    (row) => {
      row.targets[0]!.cases[0]!.durationMs = Number.NaN;
    },
    (row) => {
      row.targets[0]!.cleanup.status = 'failed';
    },
    (row) => {
      row.cleanup.status = 'failed';
    },
    (row) => {
      row.counts.passed--;
    },
    (row) => {
      row.completedAt = '';
    },
    (row) => {
      row.completedAt = '2026-11-07T00:00:00.000Z';
    },
  ];
  for (const mutate of mutations) {
    const value = report(expected);
    mutate(value);
    assert.throws(() => verifyBackstageEvidence(value, expected));
  }
});

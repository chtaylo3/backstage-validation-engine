import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
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
const independent = JSON.parse(
  await readFile('test/fixtures/backstage-evidence-controls.json', 'utf8'),
) as { purpose: string; expected: Expected };
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
// Synthetic verifier control. No executed release qualification.
function report(expected: Expected = independent.expected): Report {
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

void test('independent synthetic verifier inventory matches the versioned loader output', async () => {
  const expected = await loadBackstageExpectations(path.resolve('.'), candidates);
  assert.match(independent.purpose, /No executed release qualification/u);
  assert.deepEqual(expected, independent.expected);
  assert.equal(expected.cases.length, 47);
  assert.equal(verifyBackstageEvidence(report(), expected), true);
  assert.deepEqual(report().counts, count(118));
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
    const value = report();
    mutate(value);
    assert.throws(() => verifyBackstageEvidence(value, expected));
  }
});

void test('named version, driver, empty-matrix and count controls reject independent evidence', async (t) => {
  const controls: [string, (row: Report, expected: Expected) => void, RegExp | undefined][] = [
    [
      'wrong editor inventory',
      (row) => {
        row.targets[0]!.editorVersions[0] = '1.0.0';
      },
      /1\.0\.0/u,
    ],
    [
      'wrong editor case',
      (row) => {
        row.targets[0]!.cases.find((entry) => entry.scope === 'editor')!.editorVersion = '1.0.0';
      },
      /each target\/editor case exactly once/u,
    ],
    [
      'wrong SQLite driver',
      (row) => {
        row.targets[0]!.sqliteDriverVersion = '12.4.0';
      },
      /12\.4\.1/u,
    ],
    [
      'empty report targets',
      (row) => {
        row.targets = [];
        row.counts = count(0);
      },
      undefined,
    ],
    [
      'empty expected targets',
      (_row, expected) => {
        expected.targets = [];
      },
      undefined,
    ],
    [
      'empty expected cases',
      (_row, expected) => {
        expected.cases = [];
      },
      undefined,
    ],
    [
      'duplicate expected targets',
      (_row, expected) => {
        expected.targets.push(expected.targets[0]!);
      },
      undefined,
    ],
    [
      'missing case',
      (row) => {
        row.targets[0]!.cases.pop();
      },
      /each target\/editor case exactly once/u,
    ],
    [
      'duplicate case',
      (row) => {
        row.targets[0]!.cases.push(structuredClone(row.targets[0]!.cases[0]!));
      },
      /each target\/editor case exactly once/u,
    ],
    [
      'wrong target count',
      (row) => {
        row.targets[0]!.counts.executed--;
      },
      undefined,
    ],
    [
      'wrong aggregate count',
      (row) => {
        row.counts.discovered--;
      },
      undefined,
    ],
    [
      'duplicate target',
      (row) => {
        row.targets.push(structuredClone(row.targets[0]!));
      },
      undefined,
    ],
    [
      'failed aggregate',
      (row) => {
        row.status = 'failed';
      },
      undefined,
    ],
    [
      'invalid image identity',
      (row) => {
        row.targets[0]!.imageId = 'latest';
      },
      undefined,
    ],
  ];
  for (const [name, mutate, reason] of controls)
    await t.test(name, () => {
      const value = report();
      const expected = structuredClone(independent.expected);
      mutate(value, expected);
      if (reason) assert.throws(() => verifyBackstageEvidence(value, expected), reason);
      else assert.throws(() => verifyBackstageEvidence(value, expected));
    });
});

void test('independent evidence detects an isolated expectation-loader case omission', async () => {
  const filename = path.resolve('scripts/backstage-release-evidence.mjs');
  const source = (await readFile(filename, 'utf8'))
    .replaceAll(
      "'../test/integration/backstage/lib/evidence.mjs'",
      JSON.stringify(
        pathToFileURL(path.resolve('test/integration/backstage/lib/evidence.mjs')).href,
      ),
    )
    .replaceAll(
      "'../test/integration/backstage/lib/seed.mjs'",
      JSON.stringify(pathToFileURL(path.resolve('test/integration/backstage/lib/seed.mjs')).href),
    );
  assert(source.includes('cases: inventory.cases,'));
  const faulty = source.replace('cases: inventory.cases,', 'cases: inventory.cases.slice(1),');
  const loader = (await import(
    'data:text/javascript;base64,' + Buffer.from(faulty).toString('base64')
  )) as { loadBackstageExpectations: typeof loadBackstageExpectations };
  const omitted = await loader.loadBackstageExpectations(path.resolve('.'), candidates);
  assert.equal(omitted.cases.length, 46);
  assert.throws(() => assert.deepEqual(omitted, independent.expected));
  assert.throws(
    () => verifyBackstageEvidence(report(), omitted),
    /each target\/editor case exactly once/u,
  );
  // The former self-derived fixture accepts this faulty loader output.
  assert.equal(verifyBackstageEvidence(report(omitted), omitted), true);
});

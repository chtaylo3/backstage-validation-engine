import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startFakeBackstage } from './fake-backstage.js';
import { startFixtureMatrix } from './fixture-matrix.js';
import { loadPinnedMatrix } from './pinned-matrix.js';

const root = path.resolve('test/fixtures/backstage');
const selectedMinor = process.argv[2];
const targets = (await loadPinnedMatrix(root)).filter(
  (target) => selectedMinor === undefined || target.minorLine === selectedMinor,
);
if (!targets.length) throw new Error(`Unsupported fixture minor: ${selectedMinor}`);
const entities: unknown = JSON.parse(
  await readFile('test/fixtures/backstage-entities.json', 'utf8'),
);
if (!Array.isArray(entities)) throw new Error('Expected an entity fixture array');
const matrix = await startFixtureMatrix(targets, root, (artifact) =>
  startFakeBackstage(artifact, {
    entities,
    principals: [
      {
        token: 'development-only-token',
        principalId: 'fixture-developer',
        canRead: true,
        visibleRefs: '*',
      },
    ],
  }),
);
for (const { target, fixture } of matrix.fixtures) {
  process.stdout.write(`Backstage ${target.backstageVersion}: ${fixture.baseUrl}\n`);
}
process.stdout.write('Authorization: Bearer development-only-token\nCtrl+C to stop.\n');
await new Promise<void>((resolve) => {
  const stop = () => {
    void matrix.close().then(resolve, (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
      resolve();
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
});

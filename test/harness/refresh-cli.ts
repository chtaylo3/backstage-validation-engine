import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  refreshReleaseInventory,
  sameReleaseInventory,
  saveReleaseInventory,
} from './release-refresh.js';
import { parsePinnedInventory, parseSupportConfiguration } from './pinned-matrix.js';

const root = path.resolve('test/fixtures/backstage');
const check = process.argv[2] === '--check';
if (process.argv.length > (check ? 3 : 2)) throw new Error('Expected no arguments or --check');
const configuration = parseSupportConfiguration(
  JSON.parse(await readFile(path.join(root, 'support.json'), 'utf8')) as unknown,
);
const refreshed = await refreshReleaseInventory(configuration);
if (check) {
  const current = parsePinnedInventory(
    JSON.parse(await readFile(path.join(root, 'inventory.json'), 'utf8')) as unknown,
  );
  if (!sameReleaseInventory(current, refreshed.inventory)) {
    throw new Error(
      'Upstream Backstage fixtures changed; run fixtures:refresh and review the diff',
    );
  }
} else await saveReleaseInventory(root, refreshed);
process.stdout.write(
  `${refreshed.inventory.releases.map((release) => release.backstageVersion).join(', ')}\n`,
);

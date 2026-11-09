import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const require = createRequire('/app/packages/backend/package.json');
function metadata(name) {
  let directory = path.dirname(require.resolve(name));
  for (;;) {
    try {
      const value = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (value.name === name) return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Installed package metadata is unavailable.');
    directory = parent;
  }
}
const targets = JSON.parse(readFileSync('/app/test-targets.json', 'utf8'));
const target = targets.targets[process.argv[2]];
const packages = Object.fromEntries(
  Object.keys(target.packages).map((name) => [name, metadata(name).version]),
);
const Database = require('better-sqlite3');
const database = new Database(':memory:');
const sqliteVersion = database.prepare('select sqlite_version() as version').get().version;
database.close();
console.log(
  JSON.stringify({
    packages,
    sqliteVersion,
    sqliteDriverVersion: metadata('better-sqlite3').version,
    nodeVersion: process.version,
  }),
);

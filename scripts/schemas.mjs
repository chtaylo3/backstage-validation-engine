import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { contractSchemas } from '../dist/contracts/index.js';

const check = process.argv.includes('--check');
const directory = new URL('../schemas/', import.meta.url);
if (!check) await mkdir(directory, { recursive: true });
for (const [name, schema] of Object.entries(contractSchemas)) {
  const file = new URL(`${name}.schema.json`, directory);
  const expected = `${JSON.stringify(schema, null, 2)}\n`;
  if (check) {
    const actual = await readFile(file, 'utf8').catch(() => '');
    if (actual !== expected) {
      console.error(`${name}: schema is missing or stale; run npm run schemas:generate`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(file, expected);
  }
}

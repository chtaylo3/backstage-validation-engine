import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { crc32 } from 'node:zlib';
const { inspectVsix } = (await import(
  pathToFileURL(path.resolve('test/integration/backstage/lib/vsix.mjs')).href
)) as {
  inspectVsix: (file: string, revision: string) => Promise<{ files: string[] }>;
};
/** Independent stored ZIP fixture, with real CRC and directory/local entries. */
function zip(entries: [string, string][]): Buffer {
  const locals: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [filename, content] of entries) {
    const name = Buffer.from(filename),
      data = Buffer.from(content);
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const table = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(table.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, table, end]);
}
void test('VSIX policy admits declared payload and rejects crafted forbidden paths in either archive order', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-vsix-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.vsix');
  const clean: [string, string][] = [
    [
      'extension/build-info.json',
      JSON.stringify({ revision: 'candidate', target: 'linux-x64', nodeVersion: '24.22.1' }),
    ],
    ['extension/server/package-lock.json', await readFile('package-lock.json', 'utf8')],
    ['extension/server/node_modules/.package-lock.json', '{}'],
    ['extension/server/node_modules/@backstage/catalog-model/dist/index.js', ''],
    ['extension/server/dist/lsp/stdio.js', ''],
  ];
  await writeFile(file, zip(clean));
  assert.equal((await inspectVsix(file, 'candidate')).files.length, clean.length);
  for (const forbidden of [
    'extension/server/nested/catalog.sqlite',
    'extension/server/node_modules/@backstage/test/index.js',
    'extension/server/seed.json',
    'extension/server/yarn.lock',
    'extension/server/apps/backend/index.js',
    'extension/server/node_modules/@backstage/catalog-model/nested/state.sqlite.bak',
    'extension/server/node_modules/@backstage/catalog-model/seed.json',
    'extension/server/node_modules/@backstage/catalog-model/nested/yarn.lock',
    'extension/server/node_modules/@backstage/catalog-model/apps/backend/index.js',
    'extension/server/node_modules/@backstage/catalog-model/node_modules/undeclared/index.js',
    'extension/server/node_modules/undeclared/package.json',
    'extension/server/node_modules/@backstage/catalog-model/STATE.SQLITE3-wal',
    'extension/server/../build-info.json',
    'extension//build-info.json',
    'extension/./build-info.json',
    '/extension/build-info.json',
    'extension\\server\\seed.json',
    'C:/extension/build-info.json',
    'extension/build-info.json',
  ])
    for (const first of [false, true]) {
      const entry: [string, string] = [forbidden, '{}'];
      await writeFile(file, zip(first ? [entry, ...clean] : [...clean, entry]));
      await assert.rejects(inspectVsix(file, 'candidate'), /./u, forbidden);
    }
  const selfDeclared = clean.map(
    ([name, body]) =>
      [
        name,
        name.endsWith('package-lock.json') ? '{"packages":{"node_modules/undeclared":{}}}' : body,
      ] as [string, string],
  );
  await writeFile(
    file,
    zip([...selfDeclared, ['extension/server/node_modules/undeclared/index.js', '']]),
  );
  await assert.rejects(inspectVsix(file, 'candidate'), /immutable graph|runtime closure/);
});

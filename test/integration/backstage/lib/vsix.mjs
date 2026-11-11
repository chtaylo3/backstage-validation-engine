import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const hostLock = JSON.parse(
  await readFile(new URL('../../../../package-lock.json', import.meta.url), 'utf8'),
);
const runtimePackages = Object.entries(hostLock.packages)
  .filter(([name, value]) => name && !value.dev)
  .map(([name]) => name);
const exactPayload = new Set([
  '[Content_Types].xml',
  'extension.vsixmanifest',
  ...[
    'package.json',
    'readme.md',
    'LICENSE.txt',
    'THIRD_PARTY_NOTICES.txt',
    'client-SBOM.cdx.json',
    'build-info.json',
    'out/extension.cjs',
    'out/extension.cjs.map',
    'runtime/node',
    'runtime/node.exe',
    'runtime/LICENSE',
    'server/package.json',
    'server/package-lock.json',
    'server/LICENSE',
    'server/SBOM.cdx.json',
    'server/node_modules/.package-lock.json',
  ].map((name) => 'extension/' + name),
]);
export function admitVsixPath(name) {
  assert(
    typeof name === 'string' &&
      name.length > 0 &&
      !name.includes('\\') &&
      [...name].every((character) => character.charCodeAt(0) >= 32),
  );
  assert(
    !name.startsWith('/') &&
      !name.includes(':') &&
      !name.split('/').some((part) => !part || part === '.' || part === '..'),
    'Require canonical ZIP paths.',
  );
  const lower = name.toLowerCase();
  assert(
    !/(?:^|\/)(?:\.env(?:[.-][^/]*)?|\.artifacts|apps|backend|seed(?:[.-][^/]*)?|seeds)(?:\/|$)|\.(?:sqlite(?:3)?|db)(?:$|[./_-])/u.test(
      lower,
    ),
    'Exclude backend state, seeds, databases and credentials at every depth.',
  );
  if (
    /(?:^|\/)(?:package-lock\.json|\.package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|bun\.lockb?)(?:$)/u.test(
      lower,
    )
  )
    assert(
      [
        'extension/server/package-lock.json',
        'extension/server/node_modules/.package-lock.json',
      ].includes(name),
      'Only declared production lock metadata is admitted.',
    );
  if (exactPayload.has(name)) return;
  if (
    /^extension\/server\/dist\/(?:[a-z-]+\/)*[a-z0-9-]+\.(?:js(?:\.map)?|d\.ts(?:\.map)?)$/u.test(
      name,
    )
  )
    return;
  if (/^extension\/server\/schemas\/[a-z0-9-]+\.schema\.json$/u.test(name)) return;
  const prefix = 'extension/server/';
  assert(name.startsWith(prefix), 'Unexpected VSIX payload.');
  const relative = name.slice(prefix.length);
  const matches = runtimePackages
    .filter((entry) => relative.startsWith(entry + '/'))
    .sort((a, b) => b.length - a.length);
  assert(matches.length > 0, 'Dependency is outside the host-approved runtime closure.');
  const remainder = relative.slice(matches[0].length + 1);
  assert(
    !remainder.split('/').includes('node_modules'),
    'Nested packages must have their own approved lock entry.',
  );
}

/** Read one bounded metadata entry without extracting or executing archive content. */
export async function inspectVsix(filename, revision, { allowLocal = false } = {}) {
  assert((await stat(filename)).size < 256 * 1024 * 1024, 'Bound the candidate archive.');
  const bytes = await readFile(filename);
  let trailer = bytes.length - 22;
  while (
    trailer >= Math.max(0, bytes.length - 65_557) &&
    bytes.readUInt32LE(trailer) !== 0x06054b50
  )
    trailer--;
  assert(trailer >= 0, 'Require a ZIP directory.');
  const count = bytes.readUInt16LE(trailer + 10);
  assert(count > 0 && count < 20_000);
  let offset = bytes.readUInt32LE(trailer + 16);
  const files = [];
  let build;
  let lockSeen = false;
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const size = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    admitVsixPath(name);
    assert(!files.includes(name), 'Reject duplicate ZIP entries.');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const localNameLength = bytes.readUInt16LE(local + 26);
    assert.equal(
      bytes.toString('utf8', local + 30, local + 30 + localNameLength),
      name,
      'Local and directory paths must agree.',
    );
    assert(
      !/^extension\/(?:test|\.env|\.artifacts|server\/(?:test|\.env|\.artifacts))(?:\/|$)|^extension\/(?:server\/)?[^/]*\.sqlite(?:$|-)/u.test(
        name,
      ),
      'Exclude test state and credentials from the VSIX.',
    );
    files.push(name);
    if (name === 'extension/build-info.json' || name === 'extension/server/package-lock.json') {
      const bound = name.endsWith('build-info.json') ? 16 * 1024 : 2 * 1024 * 1024;
      assert(uncompressed <= bound);
      assert.equal(bytes.readUInt32LE(local), 0x04034b50);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + size);
      const method = bytes.readUInt16LE(offset + 10);
      assert([0, 8].includes(method));
      const body =
        method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: bound });
      assert.equal(body.length, uncompressed);
      const metadata = JSON.parse(body.toString('utf8'));
      if (name.endsWith('build-info.json')) build = metadata;
      else {
        assert.deepEqual(
          metadata,
          hostLock,
          'The payload lock must match the host-approved immutable graph.',
        );
        lockSeen = true;
      }
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert(build, 'Require the candidate build identity.');
  assert(lockSeen, 'Require the declared production dependency lock.');
  assert(build.revision === revision || (allowLocal && build.revision === 'local'));
  assert.equal(build.target, 'linux-x64');
  assert.equal(build.nodeVersion, '24.22.1');
  return { build, files, sha256: createHash('sha256').update(bytes).digest('hex') };
}

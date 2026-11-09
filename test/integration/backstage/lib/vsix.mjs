import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

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
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const size = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    assert(!name.includes('\\') && !name.split('/').includes('..'));
    assert(
      !/^extension\/(?:test|\.env|\.artifacts|server\/(?:test|\.env|\.artifacts))(?:\/|$)|^extension\/(?:server\/)?[^/]*\.sqlite(?:$|-)/u.test(
        name,
      ),
      'Exclude test state and credentials from the VSIX.',
    );
    files.push(name);
    if (name === 'extension/build-info.json') {
      assert(!build && uncompressed <= 16 * 1024);
      assert.equal(bytes.readUInt32LE(local), 0x04034b50);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + size);
      const method = bytes.readUInt16LE(offset + 10);
      assert([0, 8].includes(method));
      const body =
        method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: 16 * 1024 });
      assert.equal(body.length, uncompressed);
      build = JSON.parse(body.toString('utf8'));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert(build, 'Require the candidate build identity.');
  assert(build.revision === revision || (allowLocal && build.revision === 'local'));
  assert.equal(build.target, 'linux-x64');
  assert.equal(build.nodeVersion, '24.22.1');
  return { build, files, sha256: createHash('sha256').update(bytes).digest('hex') };
}

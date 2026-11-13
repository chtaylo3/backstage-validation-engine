import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseLspConfig } from './config.js';

const digests = new WeakMap<object, string>();
const digest = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
/** The digest of the file bytes that `readTrustedLspConfig` parsed this configuration from. */
export function trustedConfigDigest(config: object): string | undefined {
  return digests.get(config);
}
/** The digest of the bytes of the file now, read with the checks of a configuration load. */
export async function trustedFileDigest(filename: string): Promise<string> {
  return digest(await captureTrustedFile(filename));
}
/** The path is fixed by the host process. No protocol request can replace it. */
export async function readTrustedLspConfig(filename: string) {
  const bytes = await captureTrustedFile(filename);
  const config = parseLspConfig(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
  );
  digests.set(config, digest(bytes));
  return config;
}
/** One bounded read of a regular file that did not change while it was read. */
async function captureTrustedFile(filename: string): Promise<Buffer> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > 32n * 1024n * 1024n)
      throw new Error('Invalid trusted configuration.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, 32 * 1024 * 1024 + 1 - bytes));
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > 32 * 1024 * 1024) throw new Error('Trusted configuration exceeds limits.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes) !== after.size
    )
      throw new Error('Trusted configuration changed during capture.');
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseLspConfig } from './config.js';

/** The path is fixed by the host process. No protocol request can replace it. */
export async function readTrustedLspConfig(filename: string) {
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
    return parseLspConfig(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown,
    );
  } finally {
    await handle.close();
  }
}

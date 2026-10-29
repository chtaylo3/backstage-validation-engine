import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

export const LSP_FRAME_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 8192;

/** Bound framing before the protocol SDK buffers/decodes a JSON message. */
export class BoundedLspInput extends Transform {
  private header: Buffer = Buffer.alloc(0);
  private remaining = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining) {
          const count = Math.min(this.remaining, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + count));
          offset += count;
          this.remaining -= count;
        } else {
          // Headers are small; accumulate at most HEADER_BYTES even if a body arrives in one chunk.
          const byte = chunk.subarray(offset, ++offset);
          this.header = Buffer.concat([this.header, byte]);
          if (this.header.length > HEADER_BYTES) throw new Error('LSP header exceeds limits.');
          if (!this.header.subarray(-4).equals(Buffer.from('\r\n\r\n'))) continue;
          const lines = this.header.toString('ascii').split('\r\n').filter(Boolean);
          const lengths = lines.filter((line) => /^content-length:/i.test(line));
          if (lengths.length !== 1 || !/^content-length: *[1-9][0-9]* *$/i.test(lengths[0]!))
            throw new Error('Invalid LSP content length.');
          const length = Number(lengths[0]!.slice(lengths[0]!.indexOf(':') + 1).trim());
          if (!Number.isSafeInteger(length) || length > LSP_FRAME_BYTES)
            throw new Error('LSP message exceeds limits.');
          if (lines.some((line) => !/^[A-Za-z0-9-]+: [\x20-\x7e]+$/.test(line)))
            throw new Error('Invalid LSP header.');
          this.remaining = length;
          this.push(this.header);
          this.header = Buffer.alloc(0);
        }
      }
      callback();
    } catch {
      callback(new Error('Invalid or oversized LSP frame.'));
    }
  }
  override _flush(callback: TransformCallback): void {
    callback(this.remaining || this.header.length ? new Error('Truncated LSP frame.') : undefined);
  }
}

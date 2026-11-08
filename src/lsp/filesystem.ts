import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceSnapshot } from '../contracts/schemas.js';
import type { Immutable } from '../core/json.js';
import { createSourceSnapshot, overlaySourceSnapshot } from '../core/snapshots.js';
import { isCanonicalSourceUri } from '../core/source-uris.js';
import { RequestBudget } from '../runtime/request-budget.js';
import type { LspConfig } from './config.js';

export class FilesystemSnapshotError extends Error {
  override readonly name = 'FilesystemSnapshotError';
  constructor(
    readonly reason:
      'unavailable' | 'containment' | 'changed' | 'limit' | 'invalid_utf8' | 'closed',
  ) {
    super('The approved filesystem snapshot could not be captured.');
  }
}
export interface FilesystemSource {
  readonly files: readonly string[];
  capture(
    base: Immutable<SourceSnapshot>,
    options: {
      readonly deadlineAt: number;
      readonly signal?: AbortSignal;
      readonly skip?: readonly string[];
    },
  ): Promise<Immutable<SourceSnapshot>>;
  close(): Promise<void>;
}
function fail(reason: FilesystemSnapshotError['reason']): never {
  throw new FilesystemSnapshotError(reason);
}
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    !isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith('..' + sep) &&
    resolve(root, rel) === path
  );
};

/** Exact host allowlist; no directory discovery, source-selected paths or network loaders. */
export async function createFilesystemSource(config: LspConfig): Promise<FilesystemSource> {
  const settings = config.filesystem;
  const rootUri = config.source.rootUri;
  if (!settings || !rootUri || !isCanonicalSourceUri(rootUri, true)) fail('containment');
  const root = resolve(fileURLToPath(rootUri));
  let physical: string;
  let identity: Awaited<ReturnType<typeof lstat>>;
  try {
    identity = await lstat(root);
    if (!identity.isDirectory() || identity.isSymbolicLink()) fail('containment');
    physical = await realpath(root);
  } catch (error) {
    if (error instanceof FilesystemSnapshotError) throw error;
    fail('unavailable');
  }
  const allowed = new Set(settings.files);
  const paths = new Map(
    settings.files.map((uri) => {
      const path = fileURLToPath(uri);
      if (!inside(root, path)) fail('containment');
      return [uri, path];
    }),
  );
  const shutdown = new AbortController();
  const pending = new Set<Promise<Immutable<SourceSnapshot>>>();
  async function checkRoot(budget: RequestBudget) {
    budget.throwIfInterrupted();
    const stat = await lstat(root);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino ||
      (await realpath(root)) !== physical
    )
      fail('changed');
    budget.throwIfInterrupted();
  }
  async function checkPath(path: string, budget: RequestBudget) {
    await checkRoot(budget);
    const parts = relative(root, path).split(sep);
    let current = root;
    for (const [index, part] of parts.entries()) {
      budget.throwIfInterrupted();
      current = resolve(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) fail('containment');
      if (index < parts.length - 1 && !stat.isDirectory()) fail('containment');
    }
    if (!inside(physical, await realpath(path))) fail('containment');
  }
  async function read(path: string, budget: RequestBudget): Promise<string | undefined> {
    budget.throwIfInterrupted();
    try {
      await checkPath(path, budget);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail('containment');
    if (before.size > BigInt(config.profile.limits.fileBytes)) fail('limit');
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
        fail('changed');
      const chunks: Buffer[] = [];
      let bytes = 0;
      const expectedBytes = Number(before.size);
      while (bytes <= config.profile.limits.fileBytes) {
        budget.throwIfInterrupted();
        const chunk = Buffer.alloc(
          Math.min(
            64 * 1024,
            config.profile.limits.fileBytes + 1 - bytes,
            expectedBytes + 1 - bytes,
          ),
        );
        const count = (await handle.read(chunk)).bytesRead;
        if (!count) break;
        bytes += count;
        if (bytes > config.profile.limits.fileBytes) fail('limit');
        if (bytes > expectedBytes) fail('changed');
        chunks.push(chunk.subarray(0, count));
      }
      if (bytes > config.profile.limits.fileBytes) fail('limit');
      const after = await handle.stat({ bigint: true });
      await checkPath(path, budget);
      const named = await lstat(path, { bigint: true });
      if (
        after.dev !== named.dev ||
        after.ino !== named.ino ||
        after.nlink !== 1n ||
        named.nlink !== 1n ||
        after.size !== named.size ||
        after.mtimeNs !== named.mtimeNs ||
        after.ctimeNs !== named.ctimeNs ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        BigInt(bytes) !== after.size
      )
        fail('changed');
      budget.throwIfInterrupted();
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(chunks),
        );
      } catch {
        return fail('invalid_utf8');
      }
    } finally {
      await handle.close();
    }
  }
  async function capture(
    base: Immutable<SourceSnapshot>,
    options: {
      readonly deadlineAt: number;
      readonly signal?: AbortSignal;
      readonly skip?: readonly string[];
    },
  ) {
    if (shutdown.signal.aborted) fail('closed');
    using budget = new RequestBudget(
      options.deadlineAt,
      AbortSignal.any([shutdown.signal, ...(options.signal ? [options.signal] : [])]),
    );
    try {
      const skip = new Set(options.skip ?? []);
      if (skip.size > 1000 || [...skip].some((uri) => !allowed.has(uri))) fail('containment');
      const updates: Parameters<typeof overlaySourceSnapshot>[1][number][] = [];
      let bytes = 0;
      // Bound descriptors and in-flight bytes while overlapping independent
      // native I/O. Every file retains its full before/after containment and
      // identity checks, and a failed batch drains before capture rejects.
      const width = Math.min(
        8,
        Math.max(
          1,
          Math.floor(config.profile.limits.requestBytes / config.profile.limits.fileBytes),
        ),
      );
      const selected = [...paths].filter(([uri]) => !skip.has(uri));
      for (let offset = 0; offset < selected.length; offset += width) {
        const batch = selected.slice(offset, offset + width);
        const reads = await Promise.allSettled(batch.map(([, path]) => read(path, budget)));
        for (const [index, result] of reads.entries()) {
          if (result.status === 'rejected') throw result.reason;
          const [uri] = batch[index]!;
          const text = result.value;
          if (text === undefined) {
            if (base.files.some((file) => file.uri === uri)) updates.push({ uri, deleted: true });
          } else {
            bytes += Buffer.byteLength(text);
            if (bytes > config.profile.limits.requestBytes) fail('limit');
            updates.push({ uri, text, origin: 'repository' });
          }
        }
      }
      await checkRoot(budget);
      budget.throwIfInterrupted();
      let next = overlaySourceSnapshot(base, updates);
      next = reconcileFilesystemSource(config, next);
      return next;
    } catch (error) {
      if (budget.interrupted) budget.throwIfInterrupted();
      if (error instanceof FilesystemSnapshotError) throw error;
      return fail('unavailable');
    }
  }
  return {
    files: Object.freeze([...allowed]),
    capture: (base, options) => {
      const work = capture(base, options);
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    },
    close: async () => {
      shutdown.abort();
      await Promise.allSettled([...pending]);
    },
  };
}

/** Preserve the immutable baseline while rebuilding a disk-plus-buffer proposal. */
export function reconcileFilesystemSource(
  config: LspConfig,
  snapshot: Immutable<SourceSnapshot>,
): Immutable<SourceSnapshot> {
  const anchor =
    config.baseline ?? (config.source.changes.length === 0 ? config.source : undefined);
  let next = snapshot;
  if (anchor) {
    const previous = new Map(anchor.files.map((file) => [file.uri, file]));
    const current = new Map(next.files.map((file) => [file.uri, file]));
    const changes: SourceSnapshot['changes'] = [];
    for (const uri of new Set([...previous.keys(), ...current.keys()])) {
      const before = previous.get(uri),
        after = current.get(uri);
      if (!before) changes.push({ uri, kind: 'added' });
      else if (!after) changes.push({ uri, kind: 'deleted' });
      else if (before.digest !== after.digest) changes.push({ uri, kind: 'modified' });
    }
    next = createSourceSnapshot({ ...next, changes });
  }
  const planned = config.filesystem?.entrypoints ?? config.source.entrypoints;
  return planned === undefined
    ? next
    : createSourceSnapshot({
        ...next,
        entrypoints: planned.filter((uri) => next.files.some((file) => file.uri === uri)),
      });
}

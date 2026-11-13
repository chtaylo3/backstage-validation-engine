import type { DataEntry, SourceChange, SourceSnapshot } from '../contracts/schemas.js';
import { CONTRACT_VERSION } from '../contracts/schemas.js';
import { parseContract } from '../contracts/validate.js';
import { digestJson, digestText, immutableJson } from '../base/json.js';
import type { Immutable } from '../base/json.js';
import { reject } from '../base/errors.js';

export interface SourceInput {
  readonly uri: string;
  readonly text: string;
  readonly origin?: 'repository' | 'buffer';
  readonly version?: number;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Files represent the effective proposed snapshot, not a path into a live checkout. */
export function createSourceSnapshot(input: {
  readonly repository: string;
  readonly revision: string;
  readonly rootUri?: string;
  readonly entrypoints?: readonly string[];
  readonly files: readonly SourceInput[];
  readonly changes?: readonly Immutable<SourceChange>[];
}): Immutable<SourceSnapshot> {
  // Clone the boundary input before inspecting it, rejecting callbacks/accessors.
  const safe = immutableJson(input) as unknown as typeof input;
  const content = {
    contractVersion: CONTRACT_VERSION,
    repository: safe.repository,
    revision: safe.revision,
    ...(safe.rootUri === undefined ? {} : { rootUri: safe.rootUri }),
    ...(safe.entrypoints === undefined ? {} : { entrypoints: [...safe.entrypoints].sort(compare) }),
    files: safe.files
      .map((file) => ({
        uri: file.uri,
        text: file.text,
        digest: digestText(file.text),
        origin: file.origin ?? 'repository',
        ...(file.version === undefined ? {} : { version: file.version }),
      }))
      .sort((a, b) => compare(a.uri, b.uri)),
    changes: [...(safe.changes ?? [])].sort((a, b) => compare(a.uri, b.uri)),
  };
  return parseContract('source-snapshot', { ...content, digest: digestJson(content) });
}

/** Applies additions/replacements/deletion tombstones while preserving the base. */
export function overlaySourceSnapshot(
  base: Immutable<SourceSnapshot>,
  overlays: readonly (SourceInput | { readonly uri: string; readonly deleted: true })[],
): Immutable<SourceSnapshot> {
  const verified = parseContract('source-snapshot', base);
  const safe = immutableJson(overlays) as unknown as typeof overlays;
  const files = new Map<string, SourceInput>(verified.files.map((file) => [file.uri, file]));
  const changes = new Map(verified.changes.map((change) => [change.uri, change]));
  const seen = new Set<string>();
  for (const overlay of safe) {
    if (seen.has(overlay.uri)) reject('invalid_contract', '/overlays', 'competing overlay claims');
    seen.add(overlay.uri);
    if ('deleted' in overlay) {
      files.delete(overlay.uri);
      if (changes.get(overlay.uri)?.kind === 'added') changes.delete(overlay.uri);
      else changes.set(overlay.uri, { uri: overlay.uri, kind: 'deleted' });
    } else {
      const previous = changes.get(overlay.uri)?.kind;
      const kind =
        previous === 'added' || (!files.has(overlay.uri) && previous !== 'deleted')
          ? 'added'
          : 'modified';
      files.set(overlay.uri, overlay);
      changes.set(overlay.uri, { uri: overlay.uri, kind });
    }
  }
  return createSourceSnapshot({
    repository: verified.repository,
    revision: verified.revision,
    ...(verified.rootUri === undefined ? {} : { rootUri: verified.rootUri }),
    ...(verified.entrypoints === undefined
      ? {}
      : { entrypoints: verified.entrypoints.filter((uri) => files.has(uri)) }),
    files: [...files.values()],
    changes: [...changes.values()],
  });
}

export function createDataSnapshot(entries: readonly Immutable<DataEntry>[]) {
  const safe = immutableJson(entries) as unknown as typeof entries;
  const content = {
    contractVersion: CONTRACT_VERSION,
    entries: [...safe].sort((a, b) => compare(a.key, b.key)),
  };
  return parseContract('data-snapshot', { ...content, digest: digestJson(content) });
}

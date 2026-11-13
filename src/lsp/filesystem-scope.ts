import path from 'node:path';
import { isCanonicalSourceUri } from '../base/source-uris.js';

/**
 * The filesystem part of a trusted LSP configuration. `config.ts` validates configurations with
 * these functions, and `discovery.ts` enumerates files with them, so they live apart from both.
 */
export interface FilesystemScope {
  readonly filesystem?: {
    readonly files: readonly string[];
    readonly discovery?: {
      readonly roots: readonly string[];
      readonly include: readonly string[];
      readonly exclude?: readonly string[];
    };
  };
}
export const DISCOVERY_EXCLUDES: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.artifacts/**',
  '**/.test-dist/**',
  '**/dist/**',
];
export function discoveryMatches(config: FilesystemScope, root: string, uri: string): boolean {
  if (!uri.startsWith(root)) return false;
  const name = decodeURIComponent(uri.slice(root.length));
  const settings = config.filesystem?.discovery;
  return (
    !!settings &&
    settings.include.some((pattern) => path.posix.matchesGlob(name, pattern)) &&
    ![...DISCOVERY_EXCLUDES, ...(settings.exclude ?? [])].some((pattern) =>
      path.posix.matchesGlob(name, pattern),
    )
  );
}
export function approvedFilesystemUri(config: FilesystemScope, uri: string): boolean {
  return (
    !!config.filesystem &&
    isCanonicalSourceUri(uri) &&
    (config.filesystem.files.includes(uri) ||
      !!config.filesystem.discovery?.roots.some((root) => discoveryMatches(config, root, uri)))
  );
}

import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCanonicalSourceUri } from '../core/source-uris.js';
import type { RequestBudget } from '../runtime/request-budget.js';
import type { LspConfig } from './config.js';

const excluded = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.artifacts/**',
  '**/.test-dist/**',
  '**/dist/**',
];
function matches(config: LspConfig, root: string, uri: string): boolean {
  if (!uri.startsWith(root)) return false;
  const name = decodeURIComponent(uri.slice(root.length));
  const settings = config.filesystem?.discovery;
  return (
    !!settings &&
    settings.include.some((pattern) => path.posix.matchesGlob(name, pattern)) &&
    ![...excluded, ...(settings.exclude ?? [])].some((pattern) =>
      path.posix.matchesGlob(name, pattern),
    )
  );
}
export function approvedFilesystemUri(config: LspConfig, uri: string): boolean {
  return (
    !!config.filesystem &&
    isCanonicalSourceUri(uri) &&
    (config.filesystem.files.includes(uri) ||
      !!config.filesystem.discovery?.roots.some((root) => matches(config, root, uri)))
  );
}
export function filesystemEvent(config: LspConfig, uri: string): boolean {
  return (
    approvedFilesystemUri(config, uri) ||
    !!config.filesystem?.discovery?.roots.some(
      (root) => uri.startsWith(root) || root.startsWith(uri.endsWith('/') ? uri : uri + '/'),
    )
  );
}
/** Discovery only enumerates host-selected roots. The reader still checks each file before use. */
export async function discoverFiles(
  config: LspConfig,
  budget: RequestBudget,
  checkDirectory: (directory: string) => Promise<void>,
): Promise<string[]> {
  const settings = config.filesystem?.discovery;
  if (!settings) return [];
  const files = new Set<string>();
  let entries = 0;
  for (const root of settings.roots) {
    const stack = [{ directory: path.resolve(fileURLToPath(root)), depth: 0 }];
    while (stack.length) {
      budget.throwIfInterrupted();
      const { directory, depth } = stack.pop()!;
      if (depth > 32) throw new Error('Discovery exceeds limits.');
      await checkDirectory(directory);
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (++entries > 10_000) throw new Error('Discovery exceeds limits.');
        budget.throwIfInterrupted();
        const target = path.join(directory, entry.name);
        const uri = pathToFileURL(target).href;
        const relative = decodeURIComponent(uri.slice(root.length));
        if (
          [...excluded, ...(settings.exclude ?? [])].some((pattern) =>
            path.posix.matchesGlob(`${relative}${entry.isDirectory() ? '/' : ''}`, pattern),
          )
        )
          continue;
        if (entry.isDirectory()) stack.push({ directory: target, depth: depth + 1 });
        else if (matches(config, root, uri)) {
          if (entry.isSymbolicLink() || !entry.isFile())
            throw new Error('Discovered source is not a regular file.');
          files.add(uri);
          if (files.size > 1000) throw new Error('Discovery exceeds limits.');
        }
      }
    }
  }
  return [...files].sort();
}

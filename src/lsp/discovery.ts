import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RequestBudget } from '../runtime/request-budget.js';
import type { LspConfig } from './config.js';
import { approvedFilesystemUri, discoveryMatches, DISCOVERY_EXCLUDES } from './filesystem-scope.js';
import { builtinCapabilitySession } from '../capabilities/session.js';
import { parseBinding } from '../capabilities/admission.js';
import { digestJson } from '../base/json.js';
import { createDataSnapshot } from '../core/snapshots.js';
import { randomUUID } from 'node:crypto';
import type { Immutable } from '../base/json.js';
import type { SourceSnapshot } from '../contracts/schemas.js';

export { approvedFilesystemUri } from './filesystem-scope.js';

export function filesystemEvent(config: LspConfig, uri: string): boolean {
  return (
    approvedFilesystemUri(config, uri) ||
    !!config.filesystem?.discovery?.roots.some(
      (root) => uri.startsWith(root) || root.startsWith(uri.endsWith('/') ? uri : uri + '/'),
    )
  );
}
/** Discovery only enumerates host-selected roots. The reader still checks each file before use. */
async function scanApprovedFiles(
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
          [...DISCOVERY_EXCLUDES, ...(settings.exclude ?? [])].some((pattern) =>
            path.posix.matchesGlob(`${relative}${entry.isDirectory() ? '/' : ''}`, pattern),
          )
        )
          continue;
        if (entry.isDirectory()) stack.push({ directory: target, depth: depth + 1 });
        else if (discoveryMatches(config, root, uri)) {
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

/** The host approves roots before providing this built-in scanner. Every returned file is read again through containment checks. */
export async function discoverFiles(
  config: LspConfig,
  budget: RequestBudget,
  checkDirectory: (directory: string) => Promise<void>,
  source: Immutable<SourceSnapshot> = config.source,
): Promise<string[]> {
  const settings = config.filesystem?.discovery;
  if (!settings) return [];
  const provider = builtinCapabilitySession(
    'bve.builtin.source-discovery',
    {
      'source-discovery': async () => ({
        sources: (await scanApprovedFiles(config, budget, checkDirectory)).map((uri) => ({ uri })),
        complete: true,
      }),
    },
    {
      async: ['source-discovery'],
      required: ['source-discovery'],
      permissions: ['source-discovery'],
      clock: budget.clock,
    },
  );
  try {
    const identity = {
      sourceDigest: source.digest,
      ...(config.baseline ? { baselineDigest: config.baseline.digest } : {}),
      policyDigest: config.activation.policyDigest,
      profileDigest: config.activation.profileDigest,
      activationDigest: digestJson(config.activation),
      dataDigest: createDataSnapshot([]).digest,
      dependencyDigest: digestJson([]),
      authorityContextDigest: digestJson(config.identity),
      activationGeneration: config.activation.generation,
      workspaceGeneration: 0,
      sessionGeneration: 0,
      dependencyGeneration: 0,
    };
    const result = await provider.provide(
      'source-discovery',
      {
        roots: [...settings.roots],
        include: [...settings.include],
        exclude: [...(settings.exclude ?? [])],
      },
      {
        requestId: randomUUID(),
        binding: parseBinding({ ...identity, contextId: digestJson(identity) }),
        deadlineAt: budget.deadlineAt,
        signal: budget.signal,
      },
    );
    if (result.status !== 'ready' || !result.value.complete)
      throw new Error('Source discovery is unavailable.');
    const uris = result.value.sources.map((source) => source.uri);
    if (uris.some((uri) => !approvedFilesystemUri(config, uri)))
      throw new Error('Discovered source is not approved.');
    return uris;
  } finally {
    await provider.close();
  }
}

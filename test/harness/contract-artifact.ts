import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureTarget } from './version-matrix.js';

export interface ContractArtifact {
  readonly target: FixtureTarget;
  /** Immutable source text. Each server creates its own parsed/compiled contract state. */
  readonly text: string;
}

function assertInside(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('OpenAPI artifact must stay inside the artifact root');
  }
}

/** Offline integrity verification; full OpenAPI request/response validation belongs to the server. */
export async function loadContractArtifact(
  target: FixtureTarget,
  artifactRoot: string,
): Promise<ContractArtifact> {
  const artifactPath = target.openApi.path;
  if (
    path.posix.isAbsolute(artifactPath) ||
    path.win32.isAbsolute(artifactPath) ||
    artifactPath.includes('\\') ||
    artifactPath.split('/').includes('..')
  ) {
    throw new Error('OpenAPI artifact path must be relative without parent traversal');
  }
  const root = await realpath(artifactRoot);
  const file = await realpath(path.resolve(root, artifactPath));
  assertInside(root, file);
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== target.openApi.sha256) {
    throw new Error(`OpenAPI artifact checksum mismatch for ${target.backstageVersion}`);
  }
  return Object.freeze({ target, text: bytes.toString('utf8') });
}

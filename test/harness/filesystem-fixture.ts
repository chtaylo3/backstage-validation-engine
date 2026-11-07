import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { createSourceSnapshot } from '../../src/index.js';
import type {
  DeploymentProfile,
  PolicyBundle,
  SchemaArtifact,
  Immutable,
} from '../../src/index.js';
import { parseLspConfig } from '../../src/lsp/config.js';
import { componentText, policyRun } from './policy-fixture.js';

export async function filesystemFixture(
  t: TestContext,
  options: {
    files?: Record<string, string>;
    approved?: string[];
    entrypoints?: string[];
    profile?: Partial<DeploymentProfile>;
    rules?: readonly PolicyBundle['rules'][number][];
    schemaArtifacts?: readonly Immutable<SchemaArtifact>[];
    baseUrl?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'bve-filesystem-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'root');
  await mkdir(root);
  const uri = (name: string) => pathToFileURL(join(root, name)).href;
  const files = options.files ?? { 'catalog.yaml': componentText() };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  const approved = options.approved ?? Object.keys(files);
  const entrypoints = options.entrypoints ?? ['catalog.yaml'];
  const source = createSourceSnapshot({
    repository: 'repository',
    revision: '1',
    rootUri: pathToFileURL(root + sep).href,
    entrypoints: entrypoints.filter((name) => name in files).map(uri),
    files: Object.entries(files).map(([name, text]) => ({ uri: uri(name), text })),
  });
  const run = policyRun({
    source,
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.rules ? { rules: options.rules } : {}),
    ...(options.schemaArtifacts ? { schemaArtifacts: options.schemaArtifacts } : {}),
  });
  const config = parseLspConfig({
    ...run.context,
    source,
    identity: run.request.identity,
    debounceMs: 0,
    filesystem: { files: approved.map(uri), entrypoints: entrypoints.map(uri) },
    ...(options.baseUrl
      ? {
          catalog: {
            connectionId: 'primary',
            baseUrl: options.baseUrl,
            principalId: 'reader',
            credentialRevision: '1',
            scope: ['catalog:read'],
            maxAgeMs: 0,
            tokenEnv: 'BVE_TEST_TOKEN',
          },
        }
      : {}),
  });
  return { directory, root, uri, source, config };
}

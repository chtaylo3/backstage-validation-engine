import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  createSourceSnapshot,
  digestJson,
  parseContract,
} from '../dist/index.js';
import { createFilesystemSource, parseLspConfig } from '../dist/lsp/index.js';

const [rootPath, destination, ...names] = process.argv.slice(2);
if (!rootPath || !destination || names.length === 0)
  throw new Error(
    'Usage: node examples/create-filesystem-lsp-config.mjs ROOT OUTPUT CATALOG_FILE [PAYLOAD_FILE ...]',
  );
const rootUri = pathToFileURL(resolve(rootPath) + sep).href;
const files = names.map((name) => pathToFileURL(resolve(rootPath, name)).href);
const profile = DEFAULT_DEPLOYMENT_PROFILE;
const policy = parseContract('policy-bundle', {
  contractVersion: '0.2',
  id: 'development-baseline',
  revision: 'development-1',
  extends: [],
  rules: [
    {
      id: 'owner-required',
      version: '1',
      kind: 'cel',
      expression: 'has(entity.spec.owner)',
      selector: 'entity.kind == "Component"',
      mandatory: true,
      severity: 'error',
      requires: [],
    },
  ],
  schemas: [],
  plugins: [],
});
const activation = parseContract('activation-manifest', {
  contractVersion: '0.2',
  generation: 1,
  installationId: 'development-installation',
  repositoryId: 'development-repository',
  policyDigest: digestJson(policy),
  profileDigest: digestJson(profile),
  bypassDigest: digestJson([]),
  activatedAt: Date.now(),
  authority: {
    repository: 'https://github.com/example/governance',
    revision: 'development-1',
    verifierId: 'development-only',
    evidenceDigest: digestJson({ development: true }),
  },
});
const config = parseLspConfig({
  profile,
  policy,
  activation,
  identity: {
    installationId: activation.installationId,
    repositoryId: activation.repositoryId,
    authorityRef: 'development-only',
    permissionRevision: '1',
  },
  source: createSourceSnapshot({
    repository: 'development-repository',
    revision: 'development-1',
    rootUri,
    files: [],
    entrypoints: [],
  }),
  filesystem: { files, entrypoints: [files[0]] },
});
const reader = await createFilesystemSource(config);
try {
  const captured = await reader.capture(config.source, {
    deadlineAt: Date.now() + profile.limits.requestTimeoutMs,
  });
  const source = createSourceSnapshot({ ...captured, changes: [] });
  const ready = parseLspConfig({ ...config, source });
  await writeFile(destination, JSON.stringify(ready, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    'Created development-only filesystem LSP configuration. Launch node dist/lsp/stdio.js --config with the generated file.',
  );
} finally {
  await reader.close();
}

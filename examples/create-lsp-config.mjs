import { writeFile } from 'node:fs/promises';
import {
  CONTRACT_VERSION,
  DEFAULT_DEPLOYMENT_PROFILE,
  createSourceSnapshot,
  digestJson,
} from '../dist/index.js';
import { parseLspConfig } from '../dist/lsp/index.js';

const [baseUrl, destination] = process.argv.slice(2);
if (!baseUrl || !destination) {
  throw new Error('Usage: node examples/create-lsp-config.mjs CATALOG_BASE_URL OUTPUT_FILE');
}
const profile = DEFAULT_DEPLOYMENT_PROFILE;
const policy = {
  contractVersion: CONTRACT_VERSION,
  id: 'development-policy',
  revision: 'development-1',
  extends: [],
  schemas: [],
  plugins: [],
  rules: [
    {
      id: 'owner-exists',
      version: '1',
      kind: 'catalog',
      check: 'exists',
      referencePath: '/spec/owner',
      selector: 'entity.kind == "Component"',
      mandatory: true,
      severity: 'error',
      requires: [],
    },
  ],
};
const activation = {
  contractVersion: CONTRACT_VERSION,
  generation: 1,
  installationId: 'fixture-development',
  repositoryId: 'fixture-repository',
  policyDigest: digestJson(policy),
  profileDigest: digestJson(profile),
  bypassDigest: digestJson([]),
  activatedAt: Date.now(),
  authority: {
    repository: 'development-fixture',
    revision: 'development-1',
    verifierId: 'synthetic-development-only',
    evidenceDigest: digestJson({ fixture: true }),
  },
};
const config = parseLspConfig({
  profile,
  policy,
  activation,
  identity: {
    installationId: activation.installationId,
    repositoryId: activation.repositoryId,
    authorityRef: 'synthetic-development-only',
    permissionRevision: 'development-1',
  },
  source: createSourceSnapshot({ repository: 'development-fixture', revision: '1', files: [] }),
  debounceMs: 25,
  catalog: {
    connectionId: 'fixture',
    baseUrl,
    principalId: 'fixture-developer',
    credentialRevision: 'development-1',
    scope: ['catalog:read'],
    maxAgeMs: 0,
    tokenEnv: 'BVE_CATALOG_TOKEN',
  },
});
await writeFile(destination, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Development launcher configuration written to ${destination}`);

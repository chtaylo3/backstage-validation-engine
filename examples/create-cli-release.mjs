import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DEFAULT_DEPLOYMENT_PROFILE,
  createSourceSnapshot,
  digestJson,
  parseContract,
  resolvePolicyBundles,
  signPolicyRelease,
} from '../dist/index.js';

const destination = process.argv[2];
if (!destination)
  throw new Error('Supply a new destination directory for the development example.');
await mkdir(destination, { recursive: true });
const now = Date.now();
const schema = {
  type: 'object',
  properties: {
    spec: {
      type: 'object',
      required: ['lifecycle'],
      properties: { lifecycle: { const: 'production' } },
    },
  },
};
const artifact = parseContract('schema-artifact', {
  contractVersion: '0.2',
  id: 'example/production',
  version: '1',
  digest: digestJson(schema),
  schema,
});
const pin = { id: artifact.id, version: artifact.version, digest: artifact.digest };
const baseline = parseContract('policy-bundle', {
  contractVersion: '0.2',
  id: 'organization-baseline',
  revision: 'example-1',
  extends: [],
  rules: [
    {
      id: 'production-only',
      version: '1',
      kind: 'schema',
      schema: pin,
      mandatory: true,
      severity: 'error',
      requires: [],
    },
  ],
  schemas: [pin],
  plugins: [],
});
const root = parseContract('policy-bundle', {
  ...baseline,
  id: 'repository-additions',
  extends: [digestJson(baseline)],
  rules: [],
  schemas: [],
});
const policy = resolvePolicyBundles(
  digestJson(root),
  [root, baseline],
  [digestJson(baseline)],
).policy;
const profile = DEFAULT_DEPLOYMENT_PROFILE;
const activation = parseContract('activation-manifest', {
  contractVersion: '0.2',
  generation: 1,
  installationId: 'example-installation',
  repositoryId: 'example-repository',
  policyDigest: digestJson(policy),
  profileDigest: digestJson(profile),
  bypassDigest: digestJson([]),
  activatedAt: now,
  authority: {
    repository: 'https://github.com/example/governance',
    revision: 'example-1',
    verifierId: 'development-signer',
    evidenceDigest: digestJson({ example: true }),
  },
});
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const release = signPolicyRelease(
  {
    contractVersion: '0.2',
    rootDigest: digestJson(root),
    bundles: [root, baseline],
    profile,
    schemaArtifacts: [artifact],
    activation,
    issuedAt: now,
    expiresAt: now + 3_600_000,
  },
  privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  'example-key',
);
const trust = parseContract('policy-trust', {
  contractVersion: '0.2',
  generation: 1,
  identity: {
    installationId: 'example-installation',
    repositoryId: 'example-repository',
    authorityRef: 'development-signer/example',
    permissionRevision: 'example-1',
  },
  keys: [
    { id: 'example-key', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  ],
  mandatoryDigests: [digestJson(baseline)],
  maxAgeMs: 3_600_000,
});
const source = createSourceSnapshot({
  repository: 'https://github.com/example/application',
  revision: 'example-1',
  rootUri: 'file:///workspace/',
  entrypoints: ['file:///workspace/catalog-info.yaml'],
  files: [
    {
      uri: 'file:///workspace/catalog-info.yaml',
      text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: example}\nspec:\n  type: service\n  lifecycle: production\n  owner: team\n',
    },
  ],
});
for (const [name, value] of Object.entries({ release, trust, source }))
  await writeFile(resolve(destination, `${name}.json`), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
console.log(
  `Created a one-hour development release in ${resolve(destination)}. The ephemeral private key was discarded.`,
);

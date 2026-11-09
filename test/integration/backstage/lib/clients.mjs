import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from './seed.mjs';

const exec = promisify(execFile);
const candidate = '/run/work/candidate/node_modules/@chtaylo3/backstage-validation-engine';
const fixtureRoot = new URL('../', import.meta.url);
export async function installClient() {
  const checksum = createHash('sha256')
    .update(await readFile('/candidate/cli.tgz'))
    .digest('hex');
  const marker = '/run/work/candidate.sha256';
  if ((await readFile(marker, 'utf8').catch(() => '')) !== checksum) {
    await rm('/run/work/candidate', { recursive: true, force: true });
    await exec(
      'npm',
      [
        'install',
        '--prefix',
        '/run/work/candidate',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '/candidate/cli.tgz',
      ],
      { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
    );
    await writeFile(marker, checksum);
  }
  return import(pathToFileURL(path.join(candidate, 'dist/index.js')).href);
}
export const validText =
  'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: proposal, namespace: bve-demo}\nspec:\n  type: service\n  lifecycle: production\n  owner: group:bve-demo/team-demo\n';
export const invalidText = validText.replace('lifecycle: production', 'lifecycle: experimental');
export async function sourceFor(fixture, text) {
  const engine = await installClient();
  return engine.createSourceSnapshot({
    repository: 'backstage-release-proposal',
    revision: process.env.BVE_REVISION ?? 'development',
    rootUri: pathToFileURL(fixture.workspace + path.sep).href,
    entrypoints: [pathToFileURL(fixture.sourceFile).href],
    files: [{ uri: pathToFileURL(fixture.sourceFile).href, text }],
  });
}
export async function createClientFixture({
  directory = '/run/work/client-fixture',
  workspace = '/run/work/proposals',
  baseUrl = process.env.BVE_BACKSTAGE_URL,
  tokenEnv = 'BVE_BACKSTAGE_READER_TOKEN',
  profile: suppliedProfile,
} = {}) {
  const engine = await installClient();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true });
  const data = JSON.parse(await readFile(new URL('policy.json', fixtureRoot), 'utf8'));
  const profile = suppliedProfile ?? engine.DEFAULT_DEPLOYMENT_PROFILE;
  const policy = engine.parseContract('policy-bundle', data.bundle);
  const now = Date.now();
  const activation = engine.parseContract('activation-manifest', {
    contractVersion: '0.2',
    generation: 1,
    installationId: 'backstage-release',
    repositoryId: 'backstage-release',
    policyDigest: engine.digestJson(policy),
    profileDigest: engine.digestJson(profile),
    bypassDigest: engine.digestJson([]),
    activatedAt: now,
    authority: {
      repository: 'synthetic-backstage-release',
      revision: '1',
      verifierId: 'backstage-release',
      evidenceDigest: engine.digestJson({ fixture: 'backstage-release' }),
    },
  });
  const identity = {
    installationId: 'backstage-release',
    repositoryId: 'backstage-release',
    authorityRef: 'synthetic-backstage-release',
    permissionRevision: '1',
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const release = engine.signPolicyRelease(
    {
      contractVersion: '0.2',
      rootDigest: engine.digestJson(policy),
      bundles: [policy],
      profile,
      schemaArtifacts: data.schemas,
      activation,
      issuedAt: now,
      expiresAt: now + 3_600_000,
    },
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    'release-test-key',
  );
  const trust = engine.parseContract('policy-trust', {
    contractVersion: '0.2',
    generation: 1,
    identity,
    keys: [
      {
        id: 'release-test-key',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    ],
    mandatoryDigests: [engine.digestJson(policy)],
    maxAgeMs: 3_600_000,
  });
  engine.verifyPolicyRelease(release, trust);
  const sourceFile = path.join(workspace, 'catalog.yaml');
  const fixture = {
    directory,
    workspace,
    sourceFile,
    configPath: path.join(directory, 'launcher.json'),
    releasePath: path.join(directory, 'release.json'),
    trustPath: path.join(directory, 'trust.json'),
    catalogConfigPath: path.join(directory, 'catalog.json'),
    policyDigest: digest(policy),
    profile,
    policy,
    activation,
    identity,
    schemaArtifacts: data.schemas,
    validText,
    invalidText,
  };
  fixture.source = await sourceFor(fixture, invalidText);
  const catalog = {
    connectionId: 'real-backstage',
    allowInsecureHttp: true,
    baseUrl: baseUrl + '/api/catalog',
    principalId: 'bve-reader',
    credentialRevision: '1',
    scope: ['catalog:read'],
    maxAgeMs: 500,
    tokenEnv,
  };
  const launcher = {
    profile,
    policy,
    activation,
    identity,
    schemaArtifacts: data.schemas,
    source: fixture.source,
    filesystem: {
      files: [pathToFileURL(sourceFile).href],
      entrypoints: [pathToFileURL(sourceFile).href],
    },
    catalog,
    debounceMs: 25,
  };
  for (const [filename, value] of [
    [fixture.releasePath, release],
    [fixture.trustPath, trust],
    [fixture.catalogConfigPath, catalog],
    [fixture.configPath, launcher],
  ])
    await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await writeFile(sourceFile, invalidText);
  return fixture;
}
export async function runCli(
  fixture,
  text,
  { format = 'json', token = process.env.BVE_BACKSTAGE_READER_TOKEN, output, sourceOverride } = {},
) {
  const engine = await installClient();
  const source = sourceOverride ?? (await sourceFor(fixture, text));
  const input = path.join(fixture.directory, 'source.json');
  await writeFile(input, JSON.stringify(source));
  const args = [
    path.join(candidate, 'dist/cli/main.js'),
    'validate',
    '--source',
    input,
    '--release',
    fixture.releasePath,
    '--trust',
    fixture.trustPath,
    '--catalog-config',
    fixture.catalogConfigPath,
    '--format',
    format,
  ];
  let result;
  const env = { ...process.env };
  if (token === null) delete env.BVE_BACKSTAGE_READER_TOKEN;
  else env.BVE_BACKSTAGE_READER_TOKEN = token;
  try {
    result = await exec(process.execPath, args, {
      env,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    result.code = 0;
  } catch (error) {
    assert([1, 2].includes(error.code), 'CLI must exit with its documented code.');
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  const report = JSON.parse(result.stdout);
  if (format === 'json' && report.provenance) engine.parseContract('validation-result', report);
  if (output) await writeFile(output, result.stdout, { mode: 0o644 });
  for (const secret of [
    process.env.BVE_BACKSTAGE_READER_TOKEN,
    process.env.BVE_BACKSTAGE_ADMIN_TOKEN,
    process.env.BVE_BACKSTAGE_DENIED_TOKEN,
  ].filter(Boolean))
    assert(
      !result.stdout.includes(secret) && !result.stderr.includes(secret),
      'Client reports must omit credentials.',
    );
  return { ...result, report };
}
export function substantiveFindings(report) {
  return report.findings
    .map((finding) => ({
      ruleId: finding.ruleId,
      path: finding.location?.path ?? finding.path,
      category: finding.category,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

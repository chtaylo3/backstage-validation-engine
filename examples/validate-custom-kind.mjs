import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  closeSharedCelRuntime,
  createSourceSnapshot,
  createValidationResult,
  digestJson,
  parseContract,
  resultExitCode,
  validatePolicySources,
} from '../dist/index.js';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./contracts/${name}.json`, import.meta.url), 'utf8'));
const template = await fixture('validation-request');
const artifact = parseContract('schema-artifact', await fixture('schema-artifact'));
const base = await fixture('deployment-profile');
const profile = parseContract('deployment-profile', {
  ...base,
  admission: { allowedKinds: ['Widget'], locations: [] },
  customKinds: [
    {
      kind: 'Widget',
      apiVersion: 'example.com/v1',
      schema: {
        id: artifact.id,
        version: artifact.version,
        digest: artifact.digest,
      },
    },
  ],
});
const policy = await fixture('policy-bundle');
const activation = parseContract('activation-manifest', {
  ...(await fixture('activation-manifest')),
  profileDigest: digestJson(profile),
});
const context = { profile, policy, activation, schemaArtifacts: [artifact] };
const source = createSourceSnapshot({
  repository: template.source.repository,
  revision: 'synthetic-custom-kind-example',
  files: [
    {
      uri: 'file:///workspace/widget.yaml',
      origin: 'buffer',
      version: 1,
      text: JSON.stringify({
        apiVersion: 'example.com/v1',
        kind: 'Widget',
        metadata: { name: 'example' },
        spec: {
          owner: 'team',
          tier: process.argv.includes('--invalid') ? 0 : 1,
        },
      }),
    },
  ],
});
const startedAt = Date.now();
const request = parseContract('validation-request', {
  ...template,
  source,
  run: { ...template.run, runId: randomUUID() },
  execution: { mode: 'ci', startedAt, deadlineAt: startedAt + 5000 },
  profile: { id: profile.id, digest: digestJson(profile) },
  activation: { generation: activation.generation, digest: digestJson(activation) },
});
try {
  const report = await validatePolicySources(request, context);
  const result = createValidationResult({
    ...report,
    request: report.request,
    artifacts: report.compatibility.artifacts,
    completedAt: Date.now(),
    authorityCheckedAt: startedAt,
  });
  console.log(
    JSON.stringify(
      {
        scope:
          'Pinned custom-schema admission and CEL policy with synthetic development authority.',
        outcome: result.outcome,
        enforcement: result.enforcement,
        artifacts: result.artifacts,
        findings: result.findings,
        coverage: result.coverage,
        ruleStates: result.ruleStates,
      },
      null,
      2,
    ),
  );
  process.exitCode = resultExitCode(result);
} finally {
  await closeSharedCelRuntime();
}

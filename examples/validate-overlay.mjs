import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  closeSharedCelRuntime,
  createSourceSnapshot,
  createValidationResult,
  digestJson,
  overlaySourceSnapshot,
  parseContract,
  resultExitCode,
  validatePolicySources,
} from '../dist/index.js';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./contracts/${name}.json`, import.meta.url), 'utf8'));
const template = await fixture('validation-request');
const profile = await fixture('deployment-profile');
const policy = parseContract('policy-bundle', {
  ...(await fixture('policy-bundle')),
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
});
const activation = parseContract('activation-manifest', {
  ...(await fixture('activation-manifest')),
  policyDigest: digestJson(policy),
});
const component = {
  uri: 'file:///workspace/catalog-info.yaml',
  text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: example}\nspec: {type: service, lifecycle: production, owner: team}\n',
};
const team = {
  uri: 'file:///workspace/team.yaml',
  text: 'apiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata: {name: team}\nspec: {type: team, children: []}\n',
};
const deleted = process.argv.includes('--deleted');
const baseline = createSourceSnapshot({
  repository: template.source.repository,
  revision: 'before',
  rootUri: 'file:///workspace/',
  files: [component, ...(deleted ? [team] : [])],
});
const source = createSourceSnapshot({
  ...overlaySourceSnapshot(baseline, deleted ? [{ uri: team.uri, deleted: true }] : [team]),
  revision: 'after',
});
const startedAt = Date.now();
const request = parseContract('validation-request', {
  ...template,
  source,
  baseline,
  run: { ...template.run, runId: randomUUID() },
  execution: { mode: 'ci', startedAt, deadlineAt: startedAt + 5000 },
  policy: { digest: digestJson(policy), revision: policy.revision },
  activation: { generation: activation.generation, digest: digestJson(activation) },
});
try {
  const report = await validatePolicySources(request, { profile, policy, activation });
  const result = createValidationResult({
    ...report,
    artifacts: report.compatibility.artifacts,
    completedAt: Date.now(),
    authorityCheckedAt: startedAt,
  });
  console.log(
    JSON.stringify(
      {
        scope:
          'Proposed catalog overlay using pinned source/baseline bytes and synthetic development authority.',
        outcome: result.outcome,
        enforcement: result.enforcement,
        provenance: result.provenance,
        observations: report.preparation?.observations,
        findings: result.findings,
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

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  closeSharedCelRuntime,
  createSourceSnapshot,
  createValidationResult,
  executeCelRules,
  parseContract,
  resultExitCode,
} from '../dist/index.js';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./contracts/${name}.json`, import.meta.url), 'utf8'));
const requestTemplate = await fixture('validation-request');
const context = {
  profile: await fixture('deployment-profile'),
  policy: await fixture('policy-bundle'),
  activation: await fixture('activation-manifest'),
};
const uri = 'file:///workspace/catalog-info.yaml';
const source = createSourceSnapshot({
  repository: requestTemplate.source.repository,
  revision: 'synthetic-example-revision',
  files: [
    {
      uri,
      text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: example\nspec:\n  type: service\n  lifecycle: production\n  owner: group:default/platform\n',
    },
  ],
});
const startedAt = Date.now();
const request = parseContract('validation-request', {
  ...requestTemplate,
  source,
  run: { ...requestTemplate.run, runId: randomUUID() },
  execution: { mode: 'ci', startedAt, deadlineAt: startedAt + 5000 },
});

try {
  // Explicit normalized fixture: this example does not parse YAML or verify authority.
  const report = await executeCelRules(request, context, [
    {
      id: 'component:default/example',
      value: {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: { name: 'example' },
        spec: { type: 'service', lifecycle: 'production', owner: 'group:default/platform' },
      },
      location: {
        uri,
        document: 0,
        path: '',
        range: { start: { line: 0, character: 0 }, end: { line: 8, character: 0 } },
      },
    },
  ]);
  const result = createValidationResult({
    request,
    ...report,
    completedAt: Date.now(),
    authorityCheckedAt: startedAt,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = resultExitCode(result);
} finally {
  await closeSharedCelRuntime();
}

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  closeSharedCelRuntime,
  createSourceSnapshot,
  executeCelRules,
  locateParsedPath,
  parseContract,
  validateBackstageSources,
} from '../dist/index.js';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./contracts/${name}.json`, import.meta.url), 'utf8'));
const template = await fixture('validation-request');
const context = {
  profile: await fixture('deployment-profile'),
  policy: await fixture('policy-bundle'),
  activation: await fixture('activation-manifest'),
};
const source = createSourceSnapshot({
  repository: template.source.repository,
  revision: 'synthetic-native-example',
  files: [
    {
      uri: 'file:///workspace/catalog-info.yaml',
      origin: 'buffer',
      version: 7,
      text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: example\nspec:\n  type: service\n  lifecycle: production\n  owner: group:default/platform\n',
    },
  ],
});
const startedAt = Date.now();
const request = parseContract('validation-request', {
  ...template,
  source,
  run: { ...template.run, runId: randomUUID() },
  execution: { mode: 'ci', startedAt, deadlineAt: startedAt + 5000 },
});

try {
  const native = await validateBackstageSources(request, context);
  const rules = await executeCelRules(
    request,
    context,
    native.entities.map((entity) => ({
      id: entity.entityRef,
      value: entity.normalized,
      location: locateParsedPath(entity.document, ''),
    })),
  );
  console.log(
    JSON.stringify(
      {
        scope:
          'Example of parsing, native BC-01/BC-02 and CEL rules; remaining compatibility stages are not attested.',
        adapterId: native.adapterId,
        entities: native.entities.map(({ document, ...entity }) => ({
          ...entity,
          uri: document.uri,
          document: document.document,
          version: document.version,
        })),
        findings: [...native.findings, ...rules.findings],
        coverage: [...native.coverage, ...rules.coverage],
        ruleStates: rules.ruleStates,
        interrupted: native.interrupted === 'none' ? rules.interrupted : native.interrupted,
      },
      null,
      2,
    ),
  );
} finally {
  await closeSharedCelRuntime();
}

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  BACKSTAGE_ADAPTER_IDS,
  closeSharedCelRuntime,
  validatePolicySources,
} from '../src/index.js';
import { SourceLineIndex } from '../src/parsing/locations.js';
import { SCALAR_FIX_LIMITS } from '../src/core/scalar-fixes.js';
import { fixPolicy } from './harness/fix-fixture.js';
import { schemaArtifact } from './harness/custom-kind-fixture.js';
import type { JsonValue } from '../src/index.js';
import { componentText, policyRun } from './harness/policy-fixture.js';
import { URI } from './helpers.js';

after(closeSharedCelRuntime);
void test('scalar const repairs preserve source formatting and validate on both model pins', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS) {
    for (const scalar of ['experimental', "'experimental'", '"experimental"']) {
      await t.test(adapterId + ':' + scalar, async () => {
        const text = componentText()
          .replace('production', scalar + ' # keep 😀')
          .replaceAll('\n', '\r\n');
        const options = { ...fixPolicy(), text, profile: { adapterId } };
        const run = policyRun(options);
        const before = JSON.stringify(run);
        const report = await validatePolicySources(run.request, run.context);
        const edits = report.findings.flatMap((row) => row.edits);
        assert.equal(edits.length, 1);
        const edit = edits[0]!;
        assert.equal(edit.uri, URI);
        assert.equal(edit.sourceDigest, run.request.source.files[0]?.digest);
        assert.equal(edit.version, 1);
        assert.equal(edit.text, '"production"');
        const index = new SourceLineIndex(text);
        const fixed =
          text.slice(0, index.offset(edit.range.start)) +
          edit.text +
          text.slice(index.offset(edit.range.end));
        assert.equal(fixed, text.replace(scalar, '"production"'));
        const next = policyRun({ ...options, text: fixed });
        const verified = await validatePolicySources(next.request, next.context);
        assert.equal(verified.ruleStates[0]?.status, 'passed');
        assert.equal(JSON.stringify(run), before);
      });
    }
  }
});

void test('JSON and primitive const values have exact bounded replacements', async (t) => {
  for (const expected of ['string', 12, false, null]) {
    await t.test(JSON.stringify(expected), async () => {
      const text = JSON.stringify({
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: { name: 'service' },
        spec: { type: 'service', lifecycle: 'production', owner: 'team', extra: 'old😀' },
      });
      const run = policyRun({ ...fixPolicy(expected, 'extra'), text });
      const report = await validatePolicySources(run.request, run.context);
      const edit = report.findings.flatMap((row) => row.edits)[0];
      assert(edit);
      assert.equal(text.slice(edit.range.start.character, edit.range.end.character), '"old😀"');
      assert.equal(edit.text, JSON.stringify(expected));
    });
  }
});

void test('structured inclusions target their actual file, digest and buffer version', async (t) => {
  for (const kind of ['$yaml', '$json'] as const) {
    await t.test(kind, async () => {
      const included = 'file:///workspace/spec.' + (kind === '$yaml' ? 'yaml' : 'json');
      const value = { type: 'service', lifecycle: 'experimental', owner: 'team' };
      const includedText =
        kind === '$yaml'
          ? 'type: service\nlifecycle: experimental\nowner: team\n'
          : JSON.stringify(value);
      const run = policyRun({
        ...fixPolicy(),
        rootUri: 'file:///workspace/',
        entrypoints: [URI],
        text: `apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: service}\nspec: {${kind}: ./spec.${kind === '$yaml' ? 'yaml' : 'json'}}\n`,
        files: [{ uri: included, text: includedText, version: 7, origin: 'buffer' }],
      });
      const report = await validatePolicySources(run.request, run.context);
      const edit = report.findings.flatMap((row) => row.edits)[0];
      assert(edit);
      assert.equal(edit.uri, included);
      assert.equal(edit.version, 7);
      assert.equal(edit.sourceDigest, run.request.source.files[1]?.digest);
      const index = new SourceLineIndex(includedText);
      assert.equal(
        includedText.slice(index.offset(edit.range.start), index.offset(edit.range.end)),
        kind === '$yaml' ? 'experimental' : '"experimental"',
      );
    });
  }
});

void test('ambiguous, indirect, oversized and non-scalar repairs are omitted', async (t) => {
  const cases = [
    {
      name: 'alias',
      text: componentText().replace(
        'lifecycle: production',
        'alias: &value experimental\n  lifecycle: *value',
      ),
    },
    { name: 'block', text: componentText().replace('production', '|-\n    experimental') },
    { name: 'oversized source', text: componentText().replace('production', 'x'.repeat(4097)) },
    { name: 'oversized replacement', text: componentText(), policy: fixPolicy('x'.repeat(4097)) },
    { name: 'object const', text: componentText(), policy: fixPolicy({ foo: 'bar' }) },
    { name: 'array const', text: componentText(), policy: fixPolicy(['bar']) },
    { name: 'missing field', text: componentText(), policy: fixPolicy('required', 'missing') },
    {
      name: 'false selector',
      text: componentText().replace('production', 'experimental'),
      selector: 'false',
    },
  ];
  for (const item of cases)
    await t.test(item.name, async () => {
      const policy = item.policy ?? fixPolicy();
      const run = policyRun({
        ...policy,
        text: item.text,
        rules: policy.rules.map((rule) => ({
          ...rule,
          ...(item.selector ? { selector: item.selector } : {}),
        })),
      });
      const report = await validatePolicySources(run.request, run.context);
      assert.deepEqual(
        report.findings.flatMap((row) => row.edits),
        [],
      );
    });
  await t.test('$text', async () => {
    const run = policyRun({
      ...fixPolicy(),
      rootUri: 'file:///workspace/',
      entrypoints: [URI],
      text: componentText().replace('production', '{$text: ./value.txt}'),
      files: [
        { uri: 'file:///workspace/value.txt', text: 'experimental', version: 2, origin: 'buffer' },
      ],
    });
    const report = await validatePolicySources(run.request, run.context);
    assert.equal(report.ruleStates[0]?.status, 'failed');
    assert.deepEqual(
      report.findings.flatMap((row) => row.edits),
      [],
    );
  });
});

void test('fix generation is capped per validation run', async () => {
  const text = Array.from({ length: 70 }, (_, i) =>
    componentText()
      .replace('name: service', 'name: service-' + i)
      .replace('production', 'experimental'),
  ).join('---\n');
  const run = policyRun({ ...fixPolicy(), text });
  const report = await validatePolicySources(run.request, run.context);
  assert.equal(report.findings.filter((row) => row.ruleId === 'required-value').length, 70);
  assert.equal(report.findings.flatMap((row) => row.edits).length, SCALAR_FIX_LIMITS.generated);
});

void test('const values in alternative branches, conditions and references are not prescribed repairs', async (t) => {
  const branch = { properties: { spec: { properties: { lifecycle: { const: 'production' } } } } };
  const schemas: JsonValue[] = [
    {
      anyOf: [
        branch,
        { properties: { spec: { properties: { lifecycle: { const: 'staging' } } } } },
      ],
    },
    {
      oneOf: [
        branch,
        { properties: { spec: { properties: { lifecycle: { const: 'staging' } } } } },
      ],
    },
    { if: { properties: { kind: { const: 'Component' } } }, then: branch },
    { allOf: [branch] },
    { definitions: { branch }, $ref: '#/definitions/branch' },
  ];
  for (const [i, schema] of schemas.entries())
    await t.test(String(i), async () => {
      const artifact = schemaArtifact(schema);
      const policy = fixPolicy();
      const run = policyRun({
        text: componentText().replace('production', 'experimental'),
        schemaArtifacts: [artifact],
        rules: policy.rules.map((rule) => ({
          ...rule,
          schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
        })),
      });
      const report = await validatePolicySources(run.request, run.context);
      assert.equal(report.ruleStates[0]?.status, 'failed');
      assert.deepEqual(
        report.findings.flatMap((row) => row.edits),
        [],
      );
    });
});

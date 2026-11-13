import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseLspConfig } from '../../src/lsp/config.js';
import { EditorService } from '../../src/lsp/editor.js';
import { FixRegistry } from '../../src/lsp/fixes.js';
import { prepareRuleContributions } from '../../src/host/rule-contributions.js';
import { parseEditorArtifacts } from '../../src/capabilities/editor-artifacts.js';
import { validatePolicySources } from '../../src/pipeline/policy-sources.js';
import {
  getSharedCelRuntime,
  closeSharedCelRuntime,
  CelError,
} from '../../src/runtime/cel/index.js';
import {
  policyRun,
  componentText,
  ownerRule,
  policyMatrix,
  team,
} from '../harness/policy-fixture.js';
import { editorArtifact as artifact } from '../harness/editor-artifact.js';
import { schemaArtifact } from '../harness/custom-kind-fixture.js';
import { URI } from '../helpers.js';
import type { PolicyBundle } from '../../src/contracts/schemas.js';

after(closeSharedCelRuntime);
const rule: PolicyBundle['rules'][number] = {
  id: 'lifecycle-rule',
  version: '1',
  kind: 'cel',
  mandatory: true,
  severity: 'error',
  requires: [],
  expression: 'entity.spec.lifecycle.matches("production")',
};
async function fixture(
  t: TestContext,
  run = policyRun({ text: componentText().replace('production', 'experimental'), rules: [rule] }),
  declaration = artifact(run),
  catalog?: NonNullable<Parameters<typeof validatePolicySources>[2]>['catalog'],
) {
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    editorArtifacts: [declaration],
  });
  const service = new EditorService(config);
  t.after(() => service.close());
  const documents = new Map(
    run.request.source.files.map((file) => [
      file.uri,
      TextDocument.create(file.uri, 'yaml', file.version ?? 1, file.text),
    ]),
  );
  const report = await validatePolicySources(run.request, run.context, catalog ? { catalog } : {});
  await service.update(run.request, 1);
  await service.refine(report, 1);
  const controller = new AbortController();
  const prepare = () =>
    prepareRuleContributions({
      report,
      context: config,
      artifacts: config.editorArtifacts,
      generation: 7,
      signal: controller.signal,
      current: () => true,
      ...(catalog ? { catalog } : {}),
      render: (subjectId, path, value, ruleId) =>
        service.renderRuleCandidate(subjectId, path, value, ruleId, 1, documents, report.findings),
    });
  return { config, service, documents, report, prepare, controller, run };
}

void test('approved editor artifacts reject altered contents, policy/rule/profile pins, stages and executable declarations', () => {
  const run = policyRun({ rules: [rule] });
  const good = artifact(run);
  assert.equal(parseEditorArtifacts([good], run.context.policy, run.context.profile).length, 1);
  for (const altered of [
    { ...good, id: 'tampered' },
    { ...good, policyDigest: 'sha256:' + '0'.repeat(64) },
    { ...good, profileDigest: 'sha256:' + '0'.repeat(64) },
    { ...good, loader: 'arbitrary-module' },
    artifact(run, { ruleDigest: 'sha256:' + '0'.repeat(64) }),
    artifact(run, { choices: Array.from({ length: 17 }, (_, i) => String(i)) }),
    artifact(run, { path: '/spec/__proto__' }),
    artifact(run, { languageProfile: 'draft-07/re2js@2.9.0/schema-v1' }),
  ])
    assert.throws(() => parseEditorArtifacts([altered], run.context.policy, run.context.profile));
  assert.throws(() => parseEditorArtifacts([good, good], run.context.policy, run.context.profile));
  let reads = 0;
  const accessors: unknown[] = [];
  Object.defineProperty(accessors, '0', {
    enumerable: true,
    get: () => {
      reads++;
      return good;
    },
  });
  assert.throws(() => parseEditorArtifacts(accessors, run.context.policy, run.context.profile));
  assert.equal(reads, 0, 'Artifact admission cannot invoke an array accessor.');
});

void test('CEL finite candidates use substring matching and retain exact full-pipeline evidence through capabilities', async (t) => {
  const f = await fixture(t);
  const rows = await f.prepare();
  assert.deepEqual(
    rows[0]!.candidates.map((row) => row.value),
    ['production', 'xproductionx'],
  );
  for (const candidate of rows[0]!.candidates) {
    assert.equal(candidate.evidence.originalSourceDigest, f.report.request.source.digest);
    assert.notEqual(
      candidate.evidence.hypotheticalSourceDigest,
      candidate.evidence.originalSourceDigest,
    );
    assert.equal(candidate.evidence.dependencyGeneration, 7);
    assert.equal(candidate.evidence.checkedRules[0]?.status, 'passed');
    assert(candidate.evidence.coverage.every((row) => row.status === 'verified'));
    assert(candidate.repair);
  }
  f.service.installRuleContributions(rows, 1);
  const document = f.documents.get(URI)!;
  const start = document.getText().indexOf('lifecycle: ');
  const completion = f.service.complete(
    { textDocument: { uri: URI }, position: document.positionAt(start + 'lifecycle: '.length) },
    1,
    f.documents,
  );
  // A prefix of the current scalar filters these values. Hover still exposes the approved declaration.
  assert(
    completion.items.some(
      (item) => item.label === 'production' && item.detail?.includes('Checked rule'),
    ),
    JSON.stringify(completion.items),
  );
  const hover = f.service.hover(URI, document.positionAt(start + 2), 1, f.documents);
  assert(
    hover &&
      typeof hover.contents === 'object' &&
      'value' in hover.contents &&
      'kind' in hover.contents,
  );
  assert.match(hover.contents.value, /Approved lifecycle/u);
  assert.equal(hover.contents.kind, 'plaintext');
});

void test('anchored CEL matching rejects the substring candidate and preserves unrelated findings honestly', async (t) => {
  const anchored = { ...rule, expression: 'entity.spec.lifecycle.matches("^production$")' };
  const unrelated = { ...rule, id: 'unrelated', expression: 'false' };
  const f = await fixture(
    t,
    policyRun({
      rules: [anchored, unrelated],
      text: componentText().replace('production', 'experimental'),
    }),
  );
  const rows = await f.prepare();
  assert.deepEqual(
    rows[0]!.candidates.map((row) => row.value),
    ['production'],
  );
  const evidence = rows[0]!.candidates[0]!.evidence;
  assert.equal(evidence.checkedRules.length, 2);
  assert.equal(evidence.remainingFindings, 1);
  assert.match(rows[0]!.candidates[0]!.label, /1 other findings/u);
});

void test('a candidate that changes its selector to not_applicable cannot become a verified repair', async (t) => {
  const selected = {
    ...rule,
    selector: 'entity.spec.lifecycle == "experimental"',
    expression: 'false',
  };
  const f = await fixture(
    t,
    policyRun({ rules: [selected], text: componentText().replace('production', 'experimental') }),
  );
  const rows = await f.prepare();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.candidates.length, 0);
});

void test('false, error, unknown and failed prerequisite outcomes suppress prescriptive contributions and retain required validation', async (t) => {
  for (const expression of ['false', 'entity.missing.value == 1']) {
    const pre = { ...rule, id: 'prerequisite', expression };
    const dependent = { ...rule, requires: ['prerequisite'] };
    const run = policyRun({ rules: [dependent, pre] });
    const f = await fixture(t, run, artifact(run));
    assert(
      f.report.ruleStates.some((row) => row.ruleId === dependent.id && row.status === 'blocked'),
    );
    assert.equal((await f.prepare()).length, 0);
    assert(f.report.findings.length || f.report.coverage.some((row) => row.status !== 'verified'));
  }
  const f = await fixture(t, policyRun({ rules: [{ ...rule, selector: 'false' }] }));
  assert.equal((await f.prepare()).length, 0);
  const unavailableRun = policyRun({ rules: [ownerRule, { ...rule, requires: ['owner-exists'] }] });
  const unavailable = await fixture(t, unavailableRun);
  assert.equal((await unavailable.prepare()).length, 0);
  assert(
    unavailable.report.findings.some(
      (row) => row.ruleId === 'owner-exists' && row.category === 'dependency',
    ),
  );
});

void test('schema RE2 declarations use the declared pattern and full schema pipeline', async (t) => {
  for (const pattern of ['production', '^production$']) {
    const schema = schemaArtifact({
      type: 'object',
      properties: { spec: { properties: { lifecycle: { type: 'string', pattern } } } },
    });
    const schemaRule: PolicyBundle['rules'][number] = {
      ...rule,
      kind: 'schema',
      schema: { id: schema.id, version: schema.version, digest: schema.digest },
    };
    delete (schemaRule as Record<string, unknown>).expression;
    const run = policyRun({
      rules: [schemaRule],
      schemaArtifacts: [schema],
      text: componentText().replace('production', 'experimental'),
    });
    const f = await fixture(t, run);
    assert.deepEqual(
      (await f.prepare())[0]!.candidates.map((row) => row.value),
      pattern.startsWith('^') ? ['production'] : ['production', 'xproductionx'],
    );
  }
});

void test('new owner candidates collect their own authorized catalog facts on both backend contracts', async (t) => {
  const matrix = await policyMatrix(t);
  for (let index = 0; index < matrix.fixtures.length; index++) {
    const owner = {
      ...rule,
      id: 'owner-pattern',
      requires: ['owner-exists'],
      expression: 'entity.spec.owner.matches("^good")',
    };
    const run = policyRun({ rules: [ownerRule, owner], text: componentText('badname') });
    const selected = matrix.fixtures[index]!.fixture;
    for (const name of ['badname', 'goodteam']) selected.upsert({ ...team, metadata: { name } });
    const originalCatalog = await matrix.catalog(run, index);
    const observed: string[] = [];
    const catalog = {
      ...originalCatalog,
      provider: {
        ...originalCatalog.provider,
        lookup: (...args: Parameters<typeof originalCatalog.provider.lookup>) => {
          observed.push(...args[0]);
          return originalCatalog.provider.lookup(...args);
        },
      },
    };
    const declaration = artifact(run, {
      path: '/spec/owner',
      choices: ['goodteam', 'goodmissing'],
    });
    const f = await fixture(t, run, declaration, catalog);
    assert(
      f.report.ruleStates.some((row) => row.ruleId === ownerRule.id && row.status === 'passed'),
    );
    const rows = await f.prepare();
    assert.deepEqual(
      rows[0]!.candidates.map((row) => row.value),
      ['goodteam'],
    );
    assert(observed.includes('group:default/goodteam'));
    assert(observed.includes('group:default/goodmissing'));
    assert(selected.requests().some((row) => row.operation === 'byName' && row.status === 200));
    assert.equal(rows[0]!.candidates[0]!.evidence.checkedRules.length, 2);
  }
});

void test('guarded declared repairs preserve quotes/comments and require explicit single-use selection and client acceptance', async (t) => {
  const text = componentText()
    .replace('production', "'experimental' # keep 😀")
    .replaceAll('\n', '\r\n');
  const f = await fixture(t, policyRun({ rules: [rule], text }));
  const rows = await f.prepare();
  f.service.installRuleContributions(rows, 1);
  const proposals = f.service.ruleRepairs(1, f.documents);
  assert(proposals.length);
  assert.equal(proposals[0]!.finding.edits[0]!.text, "'production'");
  const registry = new FixRegistry();
  registry.replace({
    generation: 1,
    findings: [],
    suggestions: proposals,
    source: f.run.request.source,
    documents: f.documents,
    expiresAt: f.service.ruleExpiresAt,
  });
  const limits = { fileBytes: 1024 * 1024, requestBytes: 16 * 1024 * 1024, atomicTextEdits: true };
  const edit = proposals[0]!.finding.edits[0]!;
  const actions = registry.actions(
    { textDocument: { uri: URI }, range: edit.range, context: { diagnostics: [] } },
    1,
    f.documents,
    limits,
  );
  let dispatches = 0;
  assert(actions[0]?.command?.arguments);
  assert.equal(
    (
      await registry.apply(actions[0].command.arguments, 1, f.documents, limits, () => {
        dispatches++;
        return Promise.resolve({ applied: false });
      })
    ).reason,
    'client_rejected',
  );
  assert.equal(
    (
      await registry.apply(actions[0].command.arguments, 1, f.documents, limits, () => {
        dispatches++;
        return Promise.resolve({ applied: true });
      })
    ).reason,
    'stale',
  );
  assert.equal(dispatches, 1);
  const fresh = registry.actions(
    { textDocument: { uri: URI }, range: edit.range, context: { diagnostics: [] } },
    1,
    f.documents,
    limits,
  )[0]!;
  assert.equal(
    (
      await registry.apply(fresh.command!.arguments, 1, f.documents, limits, (workspaceEdit) => {
        assert(workspaceEdit.documentChanges?.length === 1);
        const change = workspaceEdit.documentChanges[0]!;
        assert('textDocument' in change);
        const updated = TextDocument.applyEdits(
          f.documents.get(URI)!,
          change.edits.map((edit) => {
            assert('newText' in edit);
            return edit;
          }),
        );
        assert.equal(updated, text.replace("'experimental'", "'production'"));
        return Promise.resolve({ applied: true });
      })
    ).applied,
    true,
  );
  f.service.invalidate();
  assert.equal(f.service.ruleRepairs(1, f.documents).length, 0);
});

void test('candidate metadata is local while pending and obsolete or cancelled preparations cannot authorize repairs', async (t) => {
  const f = await fixture(t);
  assert.equal(f.service.ruleRepairs(1, f.documents).length, 0);
  f.controller.abort();
  assert.deepEqual(await f.prepare(), []);
  const fresh = await fixture(t);
  const rows = await fresh.prepare();
  fresh.service.invalidate();
  fresh.service.installRuleContributions(rows, 1);
  assert.equal(fresh.service.ruleRepairs(1, fresh.documents).length, 0);
});

void test('structured includes keep actual payload ranges and ambiguous or aliased mappings never produce repairs', async (t) => {
  const text = componentText().replace(
    'spec:\n  type: service\n  lifecycle: production\n  owner: team\n',
    'spec: {$yaml: spec.yaml}\n',
  );
  const payload = 'type: service\nlifecycle: experimental # preserve\nowner: team\n';
  const run = policyRun({
    rules: [rule],
    text,
    rootUri: 'file:///workspace/',
    files: [{ uri: 'file:///workspace/spec.yaml', text: payload, version: 1 }],
    entrypoints: [URI],
  });
  const f = await fixture(t, run);
  const rows = await f.prepare();
  assert(rows[0]!.candidates.length);
  const edit = rows[0]!.candidates[0]!.repair!.edits[0]!;
  assert.equal(edit.uri, 'file:///workspace/spec.yaml');
  assert.equal(edit.range.start.line, 1);
  assert.equal(edit.range.start.character, 'lifecycle: '.length);
  const alias = await fixture(
    t,
    policyRun({
      rules: [rule],
      text: componentText()
        .replace('  type: service', '  type: &life experimental')
        .replace('  lifecycle: production', '  lifecycle: *life'),
    }),
  );
  const rendered = await alias.prepare();
  assert(rendered.every((row) => row.candidates.length === 0));
  const ambiguousRun = policyRun({
    rules: [rule],
    text,
    rootUri: 'file:///workspace/',
    files: [
      { uri: 'file:///workspace/spec.yaml', text: payload, version: 1 },
      {
        uri: 'file:///workspace/other.yaml',
        text: text.replace('{name: service}', '{name: other}'),
        version: 1,
      },
    ],
    entrypoints: [URI, 'file:///workspace/other.yaml'],
  });
  const ambiguous = await fixture(t, ambiguousRun);
  assert((await ambiguous.prepare()).every((row) => row.candidates.length === 0));
});

void test('an eligible missing field supplies a field name and a verified single-property insertion', async (t) => {
  const declared = {
    ...rule,
    expression: 'has(entity.spec.classification) && entity.spec.classification == "internal"',
  };
  const run = policyRun({ rules: [declared], text: componentText() + '  \n' });
  const f = await fixture(
    t,
    run,
    artifact(run, {
      path: '/spec/classification',
      choices: ['internal'],
      examples: [],
      repairs: true,
    }),
  );
  const rows = await f.prepare();
  assert.deepEqual(
    rows[0]!.candidates.map((row) => row.value),
    ['internal'],
  );
  f.service.installRuleContributions(rows, 1);
  const document = f.documents.get(URI)!;
  const completions = f.service.complete(
    { textDocument: { uri: URI }, position: document.positionAt(document.getText().length - 1) },
    1,
    f.documents,
  );
  assert(completions.items.some((row) => row.label === 'classification'));
  const repairs = f.service.ruleRepairs(1, f.documents);
  assert.equal(repairs.length, 1);
  assert.match(repairs[0]!.finding.edits[0]!.text, /"classification": "internal"/u);
});
void test('a checked array index supplies completion, hover and logical repair without granting proof to sibling indices', async (t) => {
  const declared = { ...rule, expression: 'entity.metadata.tags[0] == "good"' };
  const text = componentText().replace(
    'metadata: {name: service}',
    'metadata: {name: service, tags: [bad, other]}',
  );
  const run = policyRun({ rules: [declared], text });
  const f = await fixture(
    t,
    run,
    artifact(run, { path: '/metadata/tags/0', choices: ['good', 'bad'] }),
  );
  const rows = await f.prepare();
  assert.deepEqual(
    rows[0]!.candidates.map((row) => row.value),
    ['good'],
  );
  f.service.installRuleContributions(rows, 1);
  const document = f.documents.get(URI)!;
  const first = text.indexOf('[bad') + 1,
    second = text.indexOf('other');
  const complete = (offset: number) =>
    f.service.complete(
      { textDocument: { uri: URI }, position: document.positionAt(offset) },
      1,
      f.documents,
    );
  assert(
    complete(first).items.some(
      (row) => row.label === 'good' && row.detail?.includes('Checked rule'),
    ),
  );
  assert(!complete(second).items.some((row) => row.detail?.includes('Checked rule')));
  const hover = f.service.hover(URI, document.positionAt(first), 1, f.documents);
  assert(hover && JSON.stringify(hover.contents).includes('Approved lifecycle choices'));
  const siblingHover = f.service.hover(URI, document.positionAt(second), 1, f.documents);
  assert(
    !siblingHover || !JSON.stringify(siblingHover.contents).includes('Approved lifecycle choices'),
  );
  assert(
    !siblingHover || !JSON.stringify(siblingHover.contents).includes('Editor rule lifecycle-rule'),
  );
  const repairs = f.service.ruleRepairs(1, f.documents);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0]!.finding.location.path, '/metadata/tags/0');
  assert.equal(document.offsetAt(repairs[0]!.finding.edits[0]!.range.start), first);
  assert.equal(
    TextDocument.applyEdits(
      document,
      repairs[0]!.finding.edits.map((row) => ({ range: row.range, newText: row.text })),
    ),
    text.replace('[bad', '["good"'),
  );
});
void test('array paths outside the bounded tuple range cannot acquire candidate evidence or logical repairs', async (t) => {
  const text = componentText().replace(
    'metadata: {name: service}',
    'metadata: ' +
      JSON.stringify({ name: 'service', tags: Array.from({ length: 257 }, () => 'bad') }),
  );
  for (const index of [255, 256]) {
    const declared = { ...rule, expression: `entity.metadata.tags[${index}] == "good"` };
    const run = policyRun({ rules: [declared], text });
    const f = await fixture(
      t,
      run,
      artifact(run, { path: `/metadata/tags/${index}`, choices: ['good'] }),
    );
    const rows = await f.prepare();
    const expected = index === 255 ? 1 : 0;
    assert.equal(rows[0]!.candidates.length, expected);
    f.service.installRuleContributions(rows, 1);
    assert.equal(f.service.ruleRepairs(1, f.documents).length, expected);
  }
});

void test('candidate preparation under shared production queue pressure preserves required results and recovers', async (t) => {
  const f = await fixture(t);
  const runtime = getSharedCelRuntime();
  await runtime.warm();
  const abort = new AbortController();
  const expensive =
    'entity.spec.items.all(x, entity.spec.items.all(y, entity.spec.items.all(z, x == z || x != z)))';
  const entity = { spec: { items: Array.from({ length: 1000 }, (_, index) => index) } };
  const jobs = Array.from({ length: 64 }, () =>
    runtime
      .evaluate(expensive, entity, {
        requestId: 'editor-bulk',
        deadlineAt: Date.now() + 5000,
        signal: abort.signal,
      })
      .catch((error: unknown) => error),
  );
  const before = JSON.stringify(f.report.findings);
  assert((await f.prepare()).every((row) => row.candidates.length === 0));
  assert.equal(JSON.stringify(f.report.findings), before);
  abort.abort();
  await Promise.all(jobs);
  assert((await f.prepare()).some((row) => row.candidates.length > 0));
  assert.equal(runtime.stats().pending, 0);
  assert(runtime.stats().workers >= 1 && runtime.stats().workers <= 2);
});

void test('production shared workers enforce CEL and RE2 errors, pressure, cancellation, replacement and recovery', async () => {
  const runtime = getSharedCelRuntime();
  await runtime.warm();
  const context = { requestId: 'editor-qualification', deadlineAt: Date.now() + 5000 };
  assert.equal(await runtime.evaluate('"xproductionx".matches("production")', {}, context), true);
  assert.equal(
    await runtime.evaluate('"xproductionx".matches("^production$")', {}, context),
    false,
  );
  for (const expression of [
    '"a".matches("(?=a)")',
    '"a".matches("' + 'a'.repeat(513) + '")',
    'entity.absent.value == 1',
  ])
    await assert.rejects(runtime.evaluate(expression, {}, context), CelError);
  const abort = new AbortController();
  const expensive =
    'entity.spec.items.all(x, entity.spec.items.all(y, entity.spec.items.all(z, x == z || x != z)))';
  const entity = { spec: { items: Array.from({ length: 1000 }, (_, index) => index) } };
  const starts = runtime.stats().workerStarts;
  const jobs = Array.from({ length: 64 }, () =>
    runtime
      .evaluate(expensive, entity, { ...context, signal: abort.signal })
      .catch((error: unknown) => error),
  );
  assert.equal(runtime.stats().pending, 64);
  assert.equal(runtime.stats().workers, 2);
  await assert.rejects(
    runtime.evaluate('true', {}, context),
    (error: unknown) => error instanceof CelError && error.code === 'queue_limit',
  );
  abort.abort();
  const outcomes = await Promise.all(jobs);
  assert(outcomes.every((error) => error instanceof CelError && error.code === 'cancelled'));
  assert.equal(
    await runtime.evaluate(
      '"production".matches("^production$")',
      {},
      { ...context, deadlineAt: Date.now() + 5000 },
    ),
    true,
  );
  assert(runtime.stats().workerStarts > starts);
  assert.equal(runtime.stats().pending, 0);
  assert.equal(getSharedCelRuntime(), runtime);
});

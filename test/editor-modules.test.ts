import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { PolicyBundle } from '../src/contracts/schemas.js';
import { prepareRuleContributions } from '../src/host/rule-contributions.js';
import { validatePolicySources } from '../src/pipeline/policy-sources.js';
import { closeSharedCelRuntime } from '../src/runtime/cel/index.js';
import { EditorService } from '../src/lsp/editor.js';
import { SelectionHistory } from '../src/lsp/editor/completion.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { editorArtifact } from './harness/editor-artifact.js';
import { componentText, policyRun } from './harness/policy-fixture.js';
import { URI } from './helpers.js';

after(closeSharedCelRuntime);

/**
 * The public members of the `EditorService` facade, by name and kind. The committed list was
 * generated from the class before it was split by feature. Regenerate only with
 * BVE_UPDATE_LSP_GOLDEN=1, then format the file with Prettier, and only when a plan names a
 * change to the editor service.
 */
const repository = fileURLToPath(new URL('../../', import.meta.url));
const MEMBERS = path.join(repository, 'test/fixtures/editor-service-members.json');

function publicMembers() {
  const config = ts.readConfigFile(path.join(repository, 'tsconfig.json'), (file) =>
    ts.sys.readFile(file),
  );
  const { options } = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, repository);
  const file = path.join(repository, 'src/lsp/editor.ts');
  const program = ts.createProgram([file], { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file)!;
  const declaration = source.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'EditorService',
  )!;
  const type = checker.getTypeAtLocation(declaration);
  const kind = (node: ts.Declaration) =>
    ts.isMethodDeclaration(node)
      ? 'method'
      : ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
        ? 'accessor'
        : 'property';
  return checker
    .getPropertiesOfType(type)
    .filter(
      (symbol) =>
        !symbol.name.startsWith('#') &&
        !(symbol.declarations ?? []).some(
          (node) =>
            ts.getCombinedModifierFlags(node) &
            (ts.ModifierFlags.Private | ts.ModifierFlags.Protected),
        ),
    )
    .map((symbol) => ({ name: symbol.name, kind: kind(symbol.declarations![0]!) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

void test('the editor service facade exposes the same public members as before the split', async () => {
  const members = publicMembers();
  const observed = `${JSON.stringify(members, null, 2)}\n`;
  if (process.env.BVE_UPDATE_LSP_GOLDEN === '1') await writeFile(MEMBERS, observed);
  assert.equal(
    JSON.stringify(JSON.parse(observed)),
    JSON.stringify(JSON.parse(await readFile(MEMBERS, 'utf8'))),
  );
  const run = policyRun({ rules: [] });
  const service = new EditorService(
    parseLspConfig({ ...run.context, identity: run.request.identity, source: run.request.source }),
  );
  for (const { name } of members) assert.ok(name in service, name);
  await service.close();
});

const lifecycleRule: PolicyBundle['rules'][number] = {
  id: 'lifecycle-rule',
  version: '1',
  kind: 'cel',
  mandatory: true,
  severity: 'error',
  requires: [],
  expression: 'entity.spec.lifecycle.matches("production")',
};
/** An editor service indexed at generation 1 with prepared, not yet installed, rule rows. */
async function ruleFixture(t: TestContext) {
  const run = policyRun({
    text: componentText().replace('production', 'experimental'),
    rules: [lifecycleRule],
  });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    editorArtifacts: [editorArtifact(run)],
  });
  const service = new EditorService(config);
  t.after(() => service.close());
  const documents = new Map(
    run.request.source.files.map((file) => [
      file.uri,
      TextDocument.create(file.uri, 'yaml', file.version ?? 1, file.text),
    ]),
  );
  const report = await validatePolicySources(run.request, run.context);
  await service.update(run.request, 1);
  await service.refine(report, 1);
  const rows = await prepareRuleContributions({
    report,
    context: config,
    artifacts: config.editorArtifacts,
    generation: 0,
    signal: new AbortController().signal,
    current: () => true,
    render: (subjectId, path, value, ruleId) =>
      service.renderRuleCandidate(subjectId, path, value, ruleId, 1, documents, report.findings),
  });
  assert.ok(rows.length);
  const document = documents.get(URI)!;
  const position = document.positionAt(
    document.getText().indexOf('lifecycle: ') + 'lifecycle: '.length,
  );
  /** Whether completion at `generation` offers a value from an installed rule contribution. */
  const offersRule = (generation: number) =>
    service
      .complete({ textDocument: { uri: URI }, position }, generation, documents)
      .items.some((item) => item.detail?.includes('Checked rule'));
  return { service, documents, rows, offersRule };
}

void test('rule contributions install only for the indexed generation and expire with it', async (t) => {
  const f = await ruleFixture(t);
  assert.equal(f.offersRule(1), false);
  f.service.installRuleContributions(f.rows, 2);
  assert.equal(f.service.ruleExpiresAt, Infinity, 'another generation installs nothing');
  assert.equal(f.offersRule(1), false);
  f.service.installRuleContributions(f.rows, 1);
  assert.equal(f.service.ruleExpiresAt, Math.min(...f.rows.map((row) => row.expiresAt)));
  assert.equal(f.service.rulePreparationExpired, false);
  assert.equal(f.offersRule(1), true);
  assert.ok(f.service.ruleRepairs(1, f.documents).length);
  f.service.expireRules(2);
  assert.equal(f.service.ruleExpiresAt, Infinity);
  assert.equal(f.service.rulePreparationExpired, false);
  assert.equal(f.offersRule(2), false);
  assert.deepEqual(f.service.ruleRepairs(2, f.documents), []);
});

void test('rule contributions expire by time and expired rules are not rendered', async (t) => {
  const f = await ruleFixture(t);
  f.service.installRuleContributions(f.rows, 1);
  assert.equal(f.offersRule(1), true);
  const lifecycle = f.documents.get(URI)!;
  const hover = () =>
    JSON.stringify(
      f.service.hover(
        URI,
        lifecycle.positionAt(lifecycle.getText().indexOf('lifecycle') + 2),
        1,
        f.documents,
      ),
    );
  assert.ok(hover().includes('Rule: lifecycle-rule'), hover());
  const expiresAt = f.service.ruleExpiresAt;
  t.mock.method(Date, 'now', () => expiresAt);
  assert.equal(f.service.rulePreparationExpired, true);
  assert.equal(f.offersRule(1), false);
  assert.deepEqual(f.service.ruleRepairs(1, f.documents), []);
  assert.ok(!hover().includes('Rule: lifecycle-rule'), hover());
  // A wall clock moved back before installation also hides every row.
  t.mock.method(Date, 'now', () => 0);
  assert.equal(f.offersRule(1), false);
});

void test('selection history orders value completion by recency and is bounded', async () => {
  const text = componentText().replace('production', '');
  const run = policyRun({ text, rules: [] });
  const service = new EditorService(
    parseLspConfig({ ...run.context, identity: run.request.identity, source: run.request.source }),
  );
  const document = TextDocument.create(URI, 'yaml', 1, text);
  const documents = new Map([[URI, document]]);
  await service.update(run.request, 1);
  const labels = () =>
    service
      .complete(
        {
          textDocument: { uri: URI },
          position: document.positionAt(text.indexOf('lifecycle: ') + 'lifecycle: '.length),
        },
        1,
        documents,
      )
      .items.map((item) => item.label);
  const original = labels();
  assert.ok(original.length >= 3, JSON.stringify(original));
  const [first, second, third] = original as [string, string, string];
  service.record(third);
  service.record(second);
  assert.deepEqual(labels().slice(0, 3), [second, third, first]);
  service.record(third);
  assert.deepEqual(labels().slice(0, 3), [third, second, first]);
  // A value longer than 512 characters is not recorded.
  service.record('x'.repeat(513));
  for (let index = 0; index < 127; index++) service.record(`other-${index}`);
  assert.deepEqual(labels().slice(0, 2), [third, first], 'the oldest selection is forgotten');
  service.record('last');
  assert.deepEqual(labels(), original, 'only the 128 most recent selections are kept');
  await service.close();

  const history = new SelectionHistory();
  for (let index = 0; index < 200; index++) history.record(`value-${index}`);
  assert.equal(history.size, 128);
  assert.equal(history.get('value-71'), undefined);
  assert.ok(history.get('value-199')! > history.get('value-72')!);
  history.record('y'.repeat(513));
  assert.equal(history.get('y'.repeat(513)), undefined);
});

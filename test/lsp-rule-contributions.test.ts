import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import {
  CodeActionRequest,
  CompletionRequest,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  ExecuteCommandRequest,
} from 'vscode-languageserver/node';
import type { CodeAction, CompletionList } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseLspConfig } from '../src/lsp/config.js';
import {
  policyRun,
  componentText,
  policyMatrix,
  localTeam,
  ownerRule,
  team,
} from './harness/policy-fixture.js';
import { editorArtifact } from './harness/editor-artifact.js';
import { startLspClient } from './harness/lsp-client.js';
import { fixPolicy } from './harness/fix-fixture.js';
import { digestJson } from '../src/core/json.js';
import { URI } from './helpers.js';

const lifecycleRule = {
  id: 'lifecycle-rule',
  version: '1',
  kind: 'cel' as const,
  requires: [],
  mandatory: true,
  severity: 'error' as const,
  selector: 'entity.kind == "Component"',
  expression: 'entity.spec.lifecycle.matches("^production$")',
};
const position = { line: 5, character: 13 };
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error('Rule contribution did not become ready.');
    await pause(10);
  }
}
void test('stdio merges checked owner candidates with reference completion and revalidates an explicit repair on both contracts', async (t) => {
  const matrix = await policyMatrix(t);
  for (const selected of matrix.fixtures)
    await t.test(selected.target.backstageVersion, async (t) => {
      selected.fixture.upsert({ ...team, metadata: { name: 'goodteam' } });
      const target = {
        ...lifecycleRule,
        id: 'owner-pattern',
        expression: 'entity.spec.owner.matches("^good")',
      };
      const text = componentText();
      const run = policyRun({ text, rules: [ownerRule, target], files: [localTeam] });
      const config = parseLspConfig({
        ...run.context,
        identity: run.request.identity,
        source: run.request.source,
        editorArtifacts: [
          editorArtifact(run, { path: '/spec/owner', choices: ['goodteam', 'goodmissing'] }),
        ],
        debounceMs: 0,
        catalog: {
          connectionId: 'primary',
          baseUrl: selected.fixture.baseUrl,
          principalId: 'reader',
          credentialRevision: '1',
          scope: ['catalog:read'],
          maxAgeMs: 5000,
          tokenEnv: 'BVE_TEST_TOKEN',
        },
      });
      let updated = '';
      const host = await startLspClient(t, config, {
        fixes: true,
        applyEdit: ({ edit }) => {
          assert.equal(edit.documentChanges?.length, 1);
          const change = edit.documentChanges[0]!;
          assert('textDocument' in change);
          updated = TextDocument.applyEdits(
            TextDocument.create(URI, 'yaml', 1, text),
            change.edits.map((row) => {
              assert('newText' in row);
              return row;
            }),
          );
          return { applied: true };
        },
      });
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: URI, languageId: 'yaml', version: 1, text },
      });
      await host.waitFor(
        (row) => row.uri === URI && row.diagnostics.some((d) => d.code === target.id),
      );
      const ownerPosition = { line: 6, character: 9 };
      const choices = await until(async () => {
        const result = (await host.client.sendRequest(CompletionRequest.type, {
          textDocument: { uri: URI },
          position: ownerPosition,
        })) as CompletionList;
        return result.items.some(
          (row) => row.label === 'goodteam' && row.detail?.includes('Checked rule'),
        )
          ? result
          : undefined;
      });
      assert(choices.items.some((row) => row.label === 'group:default/team'));
      assert(!choices.items.some((row) => row.label === 'goodmissing'));
      const action = await until(async () => {
        const actions = (await host.client.sendRequest(CodeActionRequest.type, {
          textDocument: { uri: URI },
          range: { start: ownerPosition, end: ownerPosition },
          context: { diagnostics: [] },
        })) as CodeAction[];
        return actions.find(
          (row) =>
            row.title.includes('"goodteam"') && row.title.includes('checked rule owner-pattern'),
        );
      });
      assert.deepEqual(await host.client.sendRequest(ExecuteCommandRequest.type, action.command!), {
        applied: true,
      });
      assert.equal(updated, text.replace('owner: team', 'owner: "goodteam"'));
      const after = host.diagnostics.length;
      await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri: URI, version: 2 },
        contentChanges: [{ text: updated }],
      });
      const report = await host.waitFor((row) => row.uri === URI && row.version === 2, after);
      assert.equal(report.diagnostics.length, 0);
    });
});
void test('stdio rule repair tokens reject edits, close/reopen, policy reload and credential changes before dispatch', async (t) => {
  const matrix = await policyMatrix(t);
  for (const change of ['edit', 'reopen', 'policy', 'credentials'])
    await t.test(change, async (t) => {
      const text = componentText().replace('production', 'experimental');
      const run = policyRun({ text, rules: [ownerRule, lifecycleRule], files: [localTeam] });
      const config = parseLspConfig({
        ...run.context,
        identity: run.request.identity,
        source: run.request.source,
        editorArtifacts: [editorArtifact(run)],
        debounceMs: 0,
        catalog: {
          connectionId: 'primary',
          baseUrl: matrix.fixtures[0]!.fixture.baseUrl,
          principalId: 'reader',
          credentialRevision: '1',
          scope: ['catalog:read'],
          maxAgeMs: 5000,
          tokenEnv: 'BVE_TEST_TOKEN',
        },
      });
      const host = await startLspClient(t, config, { fixes: true });
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: URI, version: 1, text, languageId: 'yaml' },
      });
      await host.waitFor(
        (row) => row.uri === URI && row.diagnostics.some((d) => d.code === lifecycleRule.id),
      );
      await until(async () => {
        const result = (await host.client.sendRequest(CompletionRequest.type, {
          textDocument: { uri: URI },
          position,
        })) as CompletionList;
        return result.items.some(
          (row) => row.label === 'production' && row.detail?.includes('Checked rule'),
        )
          ? true
          : undefined;
      });
      const action = await until(async () => {
        const actions = (await host.client.sendRequest(CodeActionRequest.type, {
          textDocument: { uri: URI },
          range: { start: position, end: position },
          context: { diagnostics: [] },
        })) as CodeAction[];
        return actions.find((row) => row.title.includes('checked rule lifecycle-rule'));
      });
      if (change === 'edit') {
        await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri: URI, version: 2 },
          contentChanges: [{ text: text + '# new source\n' }],
        });
        await host.waitFor((row) => row.uri === URI && row.version === 2);
      } else if (change === 'reopen') {
        const after = host.diagnostics.length;
        await host.client.sendNotification(DidCloseTextDocumentNotification.type, {
          textDocument: { uri: URI },
        });
        await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: { uri: URI, version: 1, text, languageId: 'yaml' },
        });
        await host.waitFor(
          (row) => row.uri === URI && row.diagnostics.some((d) => d.code === lifecycleRule.id),
          after,
        );
      } else {
        const next =
          change === 'policy'
            ? policyRun({
                text,
                rules: [ownerRule, { ...lifecycleRule, version: '2' }],
                files: [localTeam],
              })
            : run;
        const replacement = {
          ...config,
          ...next.context,
          source: config.source,
          identity: config.identity,
          editorArtifacts: [editorArtifact(next)],
          catalog: { ...config.catalog, credentialRevision: change === 'credentials' ? '2' : '1' },
        };
        await writeFile(host.configPath, JSON.stringify(replacement));
        assert.deepEqual(await host.client.sendRequest('bve/reloadConfiguration'), {
          reloaded: true,
        });
      }
      assert.deepEqual(await host.client.sendRequest(ExecuteCommandRequest.type, action.command!), {
        applied: false,
        reason: 'stale',
      });
      assert.equal(host.applyRequests.length, 0);
    });
});

void test('a held optional candidate cannot delay required diagnostics or keep an early repair past approved freshness', async (t) => {
  const matrix = await policyMatrix(t);
  const owner = {
    ...lifecycleRule,
    id: 'owner-format',
    requires: ['owner-exists'],
    expression: 'entity.spec.owner.matches("^good")',
  };
  const fixes = fixPolicy();
  const text = componentText().replace('production', 'experimental');
  const run = policyRun({
    text,
    rules: [ownerRule, ...fixes.rules, owner],
    schemaArtifacts: fixes.schemaArtifacts,
  });
  const selected = matrix.fixtures[0]!.fixture;
  selected.upsert({ ...team, metadata: { name: 'goodteam' } });
  const gate = selected.holdNext({ operation: 'byName', entityRef: 'group:default/goodteam' });
  t.after(() => gate.release());
  const declaration = editorArtifact(run, {
    ruleId: owner.id,
    ruleDigest: digestJson(owner),
    languageProfile: 'bve-cel/1',
    path: '/spec/owner',
    choices: ['goodteam'],
  });
  const config = parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    editorArtifacts: [declaration],
    debounceMs: 0,
    catalog: {
      connectionId: 'primary',
      baseUrl: selected.baseUrl,
      principalId: 'reader',
      credentialRevision: '1',
      scope: ['catalog:read'],
      maxAgeMs: 250,
      tokenEnv: 'BVE_TEST_TOKEN',
    },
  });
  const host = await startLspClient(t, config, { fixes: true });
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 1, text, languageId: 'yaml' },
  });
  const report = await host.waitFor(
    (row) => row.uri === URI && row.diagnostics.some((d) => d.code === owner.id),
  );
  assert(report.diagnostics.some((row) => row.code === 'required-value'));
  await gate.entered;
  const actions = (await host.client.sendRequest(CodeActionRequest.type, {
    textDocument: { uri: URI },
    range: { start: position, end: position },
    context: { diagnostics: [] },
  })) as CodeAction[];
  const early = actions.find((row) => row.title === 'Apply policy-required scalar value');
  assert(early, 'An early source repair is available while candidate I/O remains held.');
  await pause(350);
  assert.deepEqual(await host.client.sendRequest(ExecuteCommandRequest.type, early.command!), {
    applied: false,
    reason: 'stale',
  });
  assert.equal(host.applyRequests.length, 0);
  gate.release();
});

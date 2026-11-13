import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DidChangeWatchedFilesNotification,
} from 'vscode-languageserver/node';
import { stringify } from 'yaml';
import { BACKSTAGE_ADAPTER_IDS } from '../../src/index.js';
import { schemaArtifact } from '../harness/custom-kind-fixture.js';
import { componentText, policyMatrix, team } from '../harness/policy-fixture.js';
import { filesystemFixture } from '../harness/filesystem-fixture.js';
import { startLspClient } from '../harness/lsp-client.js';

const included =
  'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: service}\nspec: {$yaml: ./spec.yaml}\n';
const spec = (lifecycle = 'production', owner = 'team') =>
  `type: service\nlifecycle: ${lifecycle}\nowner: ${owner}\n`;
const artifact = schemaArtifact({
  type: 'object',
  properties: { spec: { type: 'object', properties: { lifecycle: { const: 'production' } } } },
});
const schemaRule = {
  id: 'production-only',
  version: '1',
  kind: 'schema',
  mandatory: true,
  severity: 'error',
  requires: [] as string[],
  schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
} as const;
async function changed(
  host: Awaited<ReturnType<typeof startLspClient>>,
  uri: string,
  type: 1 | 2 | 3 = 2,
) {
  await host.client.sendNotification(DidChangeWatchedFilesNotification.type, {
    changes: [{ uri, type }],
  });
}

void test('saved and external included-file edits refresh both native pins while open buffers take precedence', async (t) => {
  for (const adapterId of BACKSTAGE_ADAPTER_IDS)
    await t.test(adapterId, async (t) => {
      const f = await filesystemFixture(t, {
        files: { 'catalog.yaml': included, 'spec.yaml': spec() },
        profile: { adapterId },
        rules: [schemaRule],
        schemaArtifacts: [artifact],
      });
      const host = await startLspClient(t, f.config, { watchFiles: true });
      await host.client.sendNotification(InitializedNotification.type, {});
      assert.deepEqual(host.initialized.capabilities.textDocumentSync, {
        openClose: true,
        change: 2,
        save: { includeText: false },
      });
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri: f.uri('catalog.yaml'),
          languageId: 'yaml',
          version: 1,
          text: included,
        },
      });
      assert.deepEqual(
        (await host.waitFor((row) => row.uri === f.uri('catalog.yaml'))).diagnostics,
        [],
      );
      assert.match(JSON.stringify(host.registrations), /workspace\/didChangeWatchedFiles/);
      assert(JSON.stringify(host.registrations).includes(f.source.rootUri!));
      assert.equal(host.registrations.length, 1);

      let after = host.diagnostics.length;
      await writeFile(join(f.root, 'spec.yaml'), spec('experimental'));
      await changed(host, f.source.rootUri!);
      const external = await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after);
      assert.equal(external.version, 1);
      assert.equal(external.diagnostics[0]?.code, 'production-only');
      assert(
        external.diagnostics[0]?.relatedInformation?.some(
          (row) => row.location.uri === f.uri('spec.yaml'),
        ),
      );

      after = host.diagnostics.length;
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: f.uri('spec.yaml'), languageId: 'yaml', version: 3, text: spec() },
      });
      assert.deepEqual(
        (await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after)).diagnostics,
        [],
      );
      after = host.diagnostics.length;
      await writeFile(join(f.root, 'spec.yaml'), Buffer.from([255]));
      await changed(host, f.uri('spec.yaml'));
      assert.deepEqual(
        (await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after)).diagnostics,
        [],
      );

      await writeFile(join(f.root, 'spec.yaml'), spec('development'));
      after = host.diagnostics.length;
      await host.client.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri: f.uri('spec.yaml') },
      });
      assert.equal(
        (await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after)).diagnostics[0]
          ?.code,
        'production-only',
      );
      after = host.diagnostics.length;
      await writeFile(join(f.root, 'spec.yaml'), spec());
      await host.client.sendNotification(DidSaveTextDocumentNotification.type, {
        textDocument: { uri: f.uri('catalog.yaml') },
        text: 'private-untrusted-save-text: [',
      });
      const saved = await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after);
      assert.deepEqual(saved.diagnostics, []);
      assert.equal(saved.version, 1);
      after = host.diagnostics.length;
      await writeFile(join(f.root, 'spec.yaml'), spec('experimental'));
      await host.client.sendNotification(DidChangeWatchedFilesNotification.type, {
        changes: Array.from({ length: 1001 }, (_, index) => ({
          uri: f.uri(`unapproved-${index}.yaml`),
          type: 2 as const,
        })),
      });
      assert.equal(
        (await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after)).diagnostics[0]
          ?.code,
        'production-only',
      );
      after = host.diagnostics.length;
      await writeFile(join(f.root, 'spec.yaml'), spec());
      await changed(host, f.uri('spec.yaml'));
      assert.deepEqual(
        (await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after)).diagnostics,
        [],
      );
    });
});

void test('watched deletions and creations qualify baseline-relative local catalog state on both APIs', async (t) => {
  const matrix = await policyMatrix(t);
  for (const { fixture, target } of matrix.fixtures)
    await t.test(target.backstageVersion, async (t) => {
      const group = stringify(team);
      const f = await filesystemFixture(t, {
        files: { 'catalog.yaml': componentText(), 'team.yaml': group },
        entrypoints: ['catalog.yaml', 'team.yaml'],
        baseUrl: fixture.baseUrl,
      });
      const host = await startLspClient(t, f.config);
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri: f.uri('catalog.yaml'),
          languageId: 'yaml',
          version: 1,
          text: componentText(),
        },
      });
      assert.deepEqual(
        (await host.waitFor((row) => row.uri === f.uri('catalog.yaml'))).diagnostics,
        [],
      );
      assert.equal(fixture.requests().length, 0);
      let after = host.diagnostics.length;
      await rm(join(f.root, 'team.yaml'));
      await changed(host, f.uri('team.yaml'), 3);
      const removed = await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after);
      assert.equal(removed.diagnostics[0]?.code, 'owner-exists');
      assert.equal(
        fixture.requests().length,
        0,
        'confirmed deletion must mask the older remote entity',
      );
      after = host.diagnostics.length;
      await writeFile(join(f.root, 'team.yaml'), group);
      await changed(host, f.uri('team.yaml'), 1);
      assert.deepEqual(
        (await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after)).diagnostics,
        [],
      );
      assert.equal(fixture.requests().length, 0);
    });
});

void test('a watched disk edit cancels old catalog work and suppresses stale same-version diagnostics', async (t) => {
  const matrix = await policyMatrix(t);
  const fixture = matrix.fixtures[0]!.fixture;
  const f = await filesystemFixture(t, {
    files: { 'catalog.yaml': included, 'spec.yaml': spec('production', 'old-missing') },
    baseUrl: fixture.baseUrl,
  });
  const host = await startLspClient(t, f.config);
  const gate = fixture.holdNext({ operation: 'byName' });
  t.after(() => gate.release());
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: f.uri('catalog.yaml'), languageId: 'yaml', version: 1, text: included },
  });
  await gate.entered;
  await writeFile(join(f.root, 'spec.yaml'), spec());
  await changed(host, f.uri('spec.yaml'));
  await gate.cancelled;
  const latest = await host.waitFor((row) => row.uri === f.uri('catalog.yaml'));
  assert.equal(latest.version, 1);
  assert.deepEqual(latest.diagnostics, []);
  gate.release();
  await host.shutdown();
  assert(
    host.diagnostics
      .filter((row) => row.uri === f.uri('catalog.yaml'))
      .every((row) => row.diagnostics.length === 0),
  );
});

void test('disk read failures publish safe incomplete evidence and recover after approved repair', async (t) => {
  const f = await filesystemFixture(t, {
    files: { 'catalog.yaml': included, 'spec.yaml': spec() },
    rules: [schemaRule],
    schemaArtifacts: [artifact],
  });
  const host = await startLspClient(t, f.config);
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: f.uri('catalog.yaml'), languageId: 'yaml', version: 1, text: included },
  });
  assert.deepEqual(
    (await host.waitFor((row) => row.uri === f.uri('catalog.yaml'))).diagnostics,
    [],
  );
  let after = host.diagnostics.length;
  await writeFile(join(f.root, 'spec.yaml'), Buffer.from([255]));
  await changed(host, f.uri('spec.yaml'));
  const failed = await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after);
  assert.equal(failed.diagnostics[0]?.code, 'validation/incomplete');
  assert.match(JSON.stringify(failed.diagnostics[0]?.data), /"stage":"filesystem"/);
  assert.match(JSON.stringify(failed.diagnostics[0]?.data), /snapshot_unavailable/);
  after = host.diagnostics.length;
  await writeFile(join(f.root, 'spec.yaml'), spec());
  await changed(host, f.uri('spec.yaml'));
  assert.deepEqual(
    (await host.waitFor((row) => row.uri === f.uri('catalog.yaml'), after)).diagnostics,
    [],
  );
});

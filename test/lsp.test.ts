import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
} from 'vscode-languageserver/node';
import { parseLspConfig } from '../src/lsp/config.js';
import { BoundedLspInput, LSP_FRAME_BYTES } from '../src/lsp/framing.js';
import { URI } from './helpers.js';
import { digestText } from '../src/index.js';
import { componentText, localTeam, policyMatrix, policyRun } from './harness/policy-fixture.js';
import { startLspClient } from './harness/lsp-client.js';

function config(baseUrl?: string, options: Parameters<typeof policyRun>[0] = {}) {
  const run = policyRun(options);
  return parseLspConfig({
    ...run.context,
    identity: run.request.identity,
    source: run.request.source,
    debounceMs: 0,
    ...(baseUrl
      ? {
          catalog: {
            connectionId: 'primary',
            baseUrl,
            principalId: 'reader',
            credentialRevision: '1',
            scope: ['catalog:read'],
            maxAgeMs: 0,
            tokenEnv: 'BVE_TEST_TOKEN',
          },
        }
      : {}),
  });
}
void test('stdio LSP validates editor buffers against every pinned fake API and publishes precise versioned findings', async (t) => {
  const matrix = await policyMatrix(t);
  for (const { fixture, target } of matrix.fixtures)
    await t.test(target.backstageVersion, async (t) => {
      const host = await startLspClient(t, config(fixture.baseUrl));
      assert.equal(host.initialized.capabilities.positionEncoding, 'utf-16');
      assert.deepEqual(host.initialized.capabilities.textDocumentSync, {
        openClose: true,
        change: 2,
      });
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText('missing') },
      });
      const missing = await host.waitFor((item) => item.uri === URI && item.version === 1);
      assert.equal(missing.diagnostics.length, 1);
      assert.equal(missing.diagnostics[0]?.code, 'owner-exists');
      assert.equal(missing.diagnostics[0]?.severity, 1);
      assert.equal(missing.diagnostics[0]?.range.start.line, 6);
      assert.equal(missing.diagnostics[0]?.range.start.character, 9);
      assert.match(JSON.stringify(missing.diagnostics[0]?.data), /sha256:/);
      assert(!JSON.stringify(missing).includes('policy-test-secret'));
      await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri: URI, version: 2 },
        contentChanges: [
          {
            range: { start: { line: 6, character: 9 }, end: { line: 6, character: 16 } },
            text: 'team',
          },
        ],
      });
      assert.deepEqual((await host.waitFor((item) => item.version === 2)).diagnostics, []);
      assert.equal(fixture.requests().length, 2);
      await host.shutdown();
    });
});

void test('BC-04 LSP revalidates included buffers and projects findings to versioned inclusion sites on both pinned APIs', async (t) => {
  const matrix = await policyMatrix(t);
  const ownerUri = 'file:///workspace/owner.txt';
  const text = componentText('{$text: ./owner.txt}');
  for (const { fixture, target } of matrix.fixtures)
    await t.test(target.backstageVersion, async (t) => {
      const host = await startLspClient(
        t,
        config(fixture.baseUrl, {
          rootUri: 'file:///workspace/',
          entrypoints: [URI],
          text,
          files: [{ uri: ownerUri, text: 'missing' }],
        }),
      );
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: URI, languageId: 'yaml', version: 1, text },
      });
      const projected = await host.waitFor((item) => item.uri === URI && item.version === 1);
      assert.equal(projected.diagnostics.length, 1);
      assert.equal(projected.diagnostics[0]?.code, 'owner-exists');
      assert.equal(projected.diagnostics[0]?.range.start.line, 6);
      assert.equal(projected.diagnostics[0]?.relatedInformation?.[0]?.location.uri, ownerUri);
      const projectedData = projected.diagnostics[0]?.data as {
        findingId: string;
        category: string;
        sourceDigest: string;
        version: number;
      };
      assert.equal(projectedData.category, 'policy');
      assert.equal(projectedData.sourceDigest, digestText(text));
      assert.equal(projectedData.version, 1);
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: ownerUri, languageId: 'plaintext', version: 9, text: 'missing' },
      });
      const included = await host.waitFor((item) => item.uri === ownerUri && item.version === 9);
      assert.equal(included.diagnostics.length, 1);
      assert.equal(included.diagnostics[0]?.code, 'owner-exists');
      assert.deepEqual(included.diagnostics[0]?.range, {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 7 },
      });
      assert.equal(included.diagnostics[0]?.relatedInformation?.[0]?.location.uri, URI);
      const after = host.diagnostics.length;
      await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri: ownerUri, version: 10 },
        contentChanges: [{ text: 'team' }],
      });
      assert.deepEqual(
        (await host.waitFor((item) => item.uri === ownerUri && item.version === 10, after))
          .diagnostics,
        [],
      );
      assert.deepEqual(
        (await host.waitFor((item) => item.uri === URI && item.version === 1, after)).diagnostics,
        [],
      );
      const closed = host.diagnostics.length;
      await host.client.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri: ownerUri },
      });
      const restored = await host.waitFor(
        (item) => item.uri === URI && item.diagnostics.some((row) => row.code === 'owner-exists'),
        closed,
      );
      assert.equal(
        (restored.diagnostics[0]?.data as { findingId: string }).findingId,
        projectedData.findingId,
      );
      await host.shutdown();
    });
});

void test('BC-04 LSP cancels stale catalog reads when an included buffer changes', async (t) => {
  const matrix = await policyMatrix(t);
  const fixture = matrix.fixtures[0]!.fixture;
  const ownerUri = 'file:///workspace/owner.txt';
  const text = componentText('{$text: ./owner.txt}');
  const host = await startLspClient(
    t,
    config(fixture.baseUrl, {
      rootUri: 'file:///workspace/',
      entrypoints: [URI],
      text,
      files: [{ uri: ownerUri, text: 'missing' }],
    }),
  );
  const gate = fixture.holdNext({ operation: 'byName', entityRef: 'group:default/missing' });
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text },
  });
  await gate.entered;
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: ownerUri, languageId: 'plaintext', version: 1, text: 'team' },
  });
  await gate.cancelled;
  gate.release();
  assert.deepEqual((await host.waitFor((item) => item.uri === ownerUri)).diagnostics, []);
  assert.deepEqual((await host.waitFor((item) => item.uri === URI)).diagnostics, []);
  await host.shutdown();
  assert(host.diagnostics.every((item) => item.diagnostics.length === 0));
});

void test('BC-04 LSP attributes invalid included YAML to its file and clears dependent findings after repair', async (t) => {
  const specUri = 'file:///workspace/spec.yaml';
  const text = componentText().split('spec:')[0]! + 'spec: {$yaml: ./spec.yaml}\n';
  const invalid = 'type: service\nlifecycle: production\nowner: 42\n';
  const host = await startLspClient(
    t,
    config(undefined, {
      rootUri: 'file:///workspace/',
      entrypoints: [URI],
      text,
      files: [{ uri: specUri, text: invalid }],
      rules: [],
    }),
  );
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text },
  });
  const parent = await host.waitFor((item) => item.uri === URI);
  assert.equal(parent.diagnostics.length, 1);
  assert.equal(parent.diagnostics[0]?.relatedInformation?.[0]?.location.uri, specUri);
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: specUri, languageId: 'yaml', version: 4, text: invalid },
  });
  const included = await host.waitFor((item) => item.uri === specUri && item.version === 4);
  assert.equal(included.diagnostics.length, 1);
  assert.equal(included.diagnostics[0]?.range.start.line, 2);
  const after = host.diagnostics.length;
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: specUri, version: 5 },
    contentChanges: [{ text: invalid.replace('42', 'team') }],
  });
  assert.deepEqual((await host.waitFor((item) => item.uri === URI, after)).diagnostics, []);
  assert.deepEqual(
    (await host.waitFor((item) => item.uri === specUri && item.version === 5, after)).diagnostics,
    [],
  );
  await host.shutdown();
});

void test('LSP permission and outage diagnostics are dependency warnings rather than missing errors', async (t) => {
  const matrix = await policyMatrix(t);
  for (const status of [403, 503] as const)
    await t.test(String(status), async (t) => {
      const fixture = matrix.fixtures[0]!.fixture;
      for (let count = 0; count < (status === 503 ? 2 : 1); count++)
        fixture.failNext({ operation: 'byName' }, { kind: 'status', status });
      const host = await startLspClient(t, config(fixture.baseUrl));
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
      });
      const result = await host.waitFor((item) => item.version === 1);
      assert.equal(result.diagnostics[0]?.severity, 2);
      assert.match(JSON.stringify(result.diagnostics), /dependency/);
      assert(!JSON.stringify(result.diagnostics).includes('not found'));
      await host.shutdown();
    });
});

void test('rapid editor changes cancel old HTTP and never publish superseded diagnostics', async (t) => {
  const matrix = await policyMatrix(t);
  const fixture = matrix.fixtures[0]!.fixture;
  const host = await startLspClient(t, config(fixture.baseUrl));
  const gate = fixture.holdNext({ operation: 'byName', entityRef: 'group:default/missing' });
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText('missing') },
  });
  await gate.entered;
  for (const version of [2, 3, 4])
    await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: URI, version },
      contentChanges: [{ text: componentText(version === 4 ? 'team' : 'missing') }],
    });
  await gate.cancelled;
  gate.release();
  assert.deepEqual((await host.waitFor((item) => item.version === 4)).diagnostics, []);
  await host.shutdown();
  assert(!host.diagnostics.some((item) => item.version === 1));
  assert.equal(host.diagnostics.at(-1)?.version, 4);
});

void test('close cancels an in-flight request, clears findings, and reopening the same version starts a new lifetime', async (t) => {
  const matrix = await policyMatrix(t);
  const fixture = matrix.fixtures[0]!.fixture;
  const host = await startLspClient(t, config(fixture.baseUrl));
  const gate = fixture.holdNext({ operation: 'byName' });
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText('missing') },
  });
  await gate.entered;
  await host.client.sendNotification(DidCloseTextDocumentNotification.type, {
    textDocument: { uri: URI },
  });
  await gate.cancelled;
  assert.deepEqual((await host.waitFor((item) => item.version === 1)).diagnostics, []);
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
  });
  // A subsequent version gives an unambiguous notification barrier after reopening.
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 2 },
    contentChanges: [{ text: componentText() }],
  });
  assert.deepEqual((await host.waitFor((item) => item.version === 2)).diagnostics, []);
  await host.shutdown();
  assert(host.diagnostics.every((item) => item.diagnostics.length === 0));
});

void test('UTF-16 incremental edits preserve same-line emoji offsets and reject stale document versions', async (t) => {
  const matrix = await policyMatrix(t);
  const fixture = matrix.fixtures[0]!.fixture;
  const host = await startLspClient(t, config(fixture.baseUrl));
  const line = 'spec: {description: "😀", type: service, lifecycle: production, owner: missing}';
  const text = componentText().split('\n').slice(0, 3).join('\n') + '\n' + line + '\n';
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 7, text },
  });
  const original = await host.waitFor((item) => item.version === 7);
  assert.equal(original.diagnostics[0]?.range.start.character, line.indexOf('missing'));
  const inline = text.replace('missing', 'team');
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 8 },
    contentChanges: [
      {
        range: {
          start: { line: 3, character: line.indexOf('😀') },
          end: { line: 3, character: line.indexOf('😀') + 2 },
        },
        text: 'ab',
      },
      {
        range: {
          start: { line: 3, character: line.indexOf('missing') },
          end: { line: 3, character: line.indexOf('missing') + 7 },
        },
        text: 'team',
      },
    ],
  });
  assert.deepEqual((await host.waitFor((item) => item.version === 8)).diagnostics, []);
  for (const version of [7, 8])
    await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: URI, version },
      contentChanges: [{ text: componentText('missing') }],
    });
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 9 },
    contentChanges: [{ text: inline }],
  });
  assert.deepEqual((await host.waitFor((item) => item.version === 9)).diagnostics, []);
  await host.shutdown();
  assert.equal(host.diagnostics.filter((item) => item.version === 8).length, 1);
});

void test('workspace changes revalidate dependents while local proposed entities stay blocked until overlay qualification', async (t) => {
  const matrix = await policyMatrix(t);
  const fixture = matrix.fixtures[0]!.fixture;
  const host = await startLspClient(t, config(fixture.baseUrl));
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
  });
  await host.waitFor((item) => item.uri === URI && item.diagnostics.length === 0);
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: localTeam.uri, languageId: 'yaml', version: 1, text: localTeam.text },
  });
  const blocked = await host.waitFor(
    (item) =>
      item.uri === URI && item.diagnostics.some((finding) => finding.code === 'owner-exists'),
  );
  assert.equal(blocked.diagnostics[0]?.severity, 2);
  assert.match(JSON.stringify(blocked), /dependency/);
  await host.client.sendNotification(DidCloseTextDocumentNotification.type, {
    textDocument: { uri: localTeam.uri },
  });
  // The closed local file is absent from the immutable base; fallback is again eligible.
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 2 },
    contentChanges: [{ text: componentText() }],
  });
  assert.deepEqual(
    (await host.waitFor((item) => item.uri === URI && item.version === 2)).diagnostics,
    [],
  );
  await host.shutdown();
});

void test('unconfigured dependencies warn and pure CEL/native policies need no API', async (t) => {
  for (const rules of [undefined, []])
    await t.test(rules ? 'native-only' : 'unconfigured', async (t) => {
      const host = await startLspClient(t, config(undefined, rules ? { rules } : {}));
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
      });
      const result = await host.waitFor((item) => item.version === 1);
      assert.equal(result.diagnostics.length, rules ? 0 : 1);
      if (!rules) assert.equal(result.diagnostics[0]?.severity, 2);
      await host.shutdown();
    });
});

void test('shutdown cancels outstanding HTTP and waits for owned resources before process exit', async (t) => {
  const matrix = await policyMatrix(t);
  const fixture = matrix.fixtures[0]!.fixture;
  const host = await startLspClient(t, config(fixture.baseUrl));
  const gate = fixture.holdNext({ operation: 'byName' });
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
  });
  await gate.entered;
  await host.shutdown();
  await gate.cancelled;
  assert.deepEqual(host.diagnostics, []);
});

void test('over-budget buffers block stale validation until a full bounded replacement resynchronizes the document', async (t) => {
  const matrix = await policyMatrix(t);
  const fixture = matrix.fixtures[0]!.fixture;
  const run = policyRun();
  const host = await startLspClient(
    t,
    config(fixture.baseUrl, {
      profile: { limits: { ...run.context.profile.limits, fileBytes: 512 } },
    }),
  );
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
  });
  await host.waitFor((item) => item.version === 1);
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 2 },
    contentChanges: [{ text: componentText() + '# ' + 'a'.repeat(600) }],
  });
  const blocked = await host.waitFor((item) => item.version === 2);
  assert.equal(blocked.diagnostics[0]?.code, 'validation/incomplete');
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 3 },
    contentChanges: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: '#' },
    ],
  });
  assert.equal(
    (await host.waitFor((item) => item.version === 3)).diagnostics[0]?.code,
    'validation/incomplete',
  );
  assert.equal(fixture.requests().length, 1);
  await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 4 },
    contentChanges: [{ text: componentText() }],
  });
  assert.deepEqual((await host.waitFor((item) => item.version === 4)).diagnostics, []);
  await host.shutdown();
});

void test('EOF and exit without shutdown cancel active validation and terminate with protocol failure', async (t) => {
  const matrix = await policyMatrix(t);
  const fixture = matrix.fixtures[0]!.fixture;
  for (const kind of ['eof', 'exit'] as const)
    await t.test(kind, async (t) => {
      const host = await startLspClient(t, config(fixture.baseUrl));
      const gate = fixture.holdNext({ operation: 'byName' });
      await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: URI, languageId: 'yaml', version: 1, text: componentText() },
      });
      await gate.entered;
      assert.equal(await host.disconnect(kind), 1);
      await gate.cancelled;
      assert.deepEqual(host.diagnostics, []);
    });
});

void test('LSP framing preflight bounds headers/bodies, handles split/multiple frames, and rejects truncated input', async (t) => {
  const message = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }),
  );
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${message.length}\r\n\r\n`), message]);
  const input = new BoundedLspInput();
  const chunks: Buffer[] = [];
  input.on('data', (chunk: Buffer) => chunks.push(chunk));
  for (const byte of Buffer.concat([frame, frame])) input.write(Buffer.from([byte]));
  input.end();
  await once(input, 'end');
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([frame, frame]));
  for (const invalid of [
    Buffer.from(`Content-Length: ${LSP_FRAME_BYTES + 1}\r\n\r\n`),
    Buffer.alloc(8193, 65),
    Buffer.from('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}'),
    Buffer.from('Content-Length: -2\r\n\r\n'),
    frame.subarray(0, frame.length - 1),
  ])
    await t.test('reject invalid frame', async () => {
      const stream = new BoundedLspInput();
      stream.resume();
      const error = once(stream, 'error');
      stream.end(invalid);
      await error;
    });
});

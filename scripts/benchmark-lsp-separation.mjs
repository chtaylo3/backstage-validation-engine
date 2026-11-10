import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  CompletionRequest,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidChangeWatchedFilesNotification,
} from 'vscode-languageserver/node';
import { startLspClient } from '../.test-dist/test/harness/lsp-client.js';
import {
  policyRun,
  componentText,
  localTeam,
  ownerRule,
  policyMatrix,
} from '../.test-dist/test/harness/policy-fixture.js';
import { filesystemFixture } from '../.test-dist/test/harness/filesystem-fixture.js';
import { parseLspConfig } from '../.test-dist/src/lsp/config.js';
import { closeSharedCelRuntime } from '../.test-dist/src/runtime/cel/index.js';

const output = process.argv[2];
if (!output) throw new Error('Supply an output JSON path.');
const cleanups = [];
const context = { after: (work) => cleanups.push(work) };
const measurements = {};
const uri = 'file:///workspace/catalog-info.yaml';
const text = componentText('te');
const toConfig = (run, extra = {}) =>
  parseLspConfig({
    ...run.context,
    source: run.request.source,
    identity: run.request.identity,
    debounceMs: 0,
    ...extra,
  });
const plain = toConfig(policyRun({ text, rules: [], files: [localTeam] }));
async function measure(name, work, count) {
  const samples = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    const measured = await work(index);
    samples.push(typeof measured === 'number' ? measured : performance.now() - start);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  measurements[name] = {
    samplesMs: samples,
    medianMs: sorted[Math.ceil(sorted.length / 2) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
async function open(host, target = uri, body = text, version = 1) {
  const after = host.diagnostics.length;
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: target, version, text: body, languageId: 'yaml' },
  });
  return host.waitFor((row) => row.uri === target && row.version === version, after);
}
async function complete(host) {
  const result = await host.client.sendRequest(CompletionRequest.type, {
    textDocument: { uri },
    position: { line: 6, character: 11 },
  });
  assert(result && 'items' in result);
  return result;
}
try {
  await measure(
    'coldReadiness',
    async () => {
      const started = performance.now();
      const host = await startLspClient(context, plain);
      const readiness = performance.now() - started;
      await host.shutdown();
      return readiness;
    },
    5,
  );
  const host = await startLspClient(context, plain);
  await open(host);
  // Exclude one warm-up from the measured validation samples.
  let version = 1;
  async function validate() {
    const after = host.diagnostics.length;
    await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: ++version },
      contentChanges: [{ text }],
    });
    await host.waitFor((row) => row.uri === uri && row.version === version, after);
  }
  await validate();
  await measure('singleFileValidation', validate, 20);
  await measure(
    'rapidEditConvergence',
    async () => {
      const after = host.diagnostics.length;
      for (let index = 0; index < 10; index++)
        await host.client.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version: ++version },
          contentChanges: [{ text }],
        });
      await host.waitFor((row) => row.uri === uri && row.version === version, after);
    },
    20,
  );
  await measure(
    'reloadAndShutdown',
    async () => {
      assert.deepEqual(await host.client.sendRequest('bve/reloadConfiguration'), {
        reloaded: true,
      });
    },
    20,
  );
  await host.shutdown();
  const matrix = await policyMatrix(context);
  const fixture = matrix.fixtures[0].fixture;
  const gate = fixture.holdNext({ operation: 'byName', entityRef: 'group:default/te' });
  const held = await startLspClient(
    context,
    toConfig(policyRun({ text, rules: [ownerRule], files: [localTeam] }), {
      catalog: {
        connectionId: 'primary',
        baseUrl: fixture.baseUrl,
        principalId: 'reader',
        credentialRevision: '1',
        scope: ['catalog:read'],
        maxAgeMs: 5000,
        tokenEnv: 'BVE_TEST_TOKEN',
      },
    }),
  );
  await held.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri, version: 1, text, languageId: 'yaml' },
  });
  await gate.entered;
  const until = performance.now() + 3000;
  while (!(await complete(held)).items.some((item) => item.label === 'group:default/team')) {
    if (performance.now() > until) throw new Error('Local completion did not prepare.');
    await pause(5);
  }
  await measure(
    'localCompletionWithHeldHttp',
    async () => {
      assert((await complete(held)).items.some((item) => item.label === 'group:default/team'));
    },
    20,
  );
  gate.release();
  await held.shutdown();
  const f = await filesystemFixture(context, { rules: [] });
  const disk = await startLspClient(context, f.config, { watchFiles: true });
  await open(disk, f.uri('catalog.yaml'), componentText());
  await measure(
    'watchedCaptureWithOverlay',
    async () => {
      const after = disk.diagnostics.length;
      await disk.client.sendNotification(DidChangeWatchedFilesNotification.type, {
        changes: [{ uri: f.uri('catalog.yaml'), type: 2 }],
      });
      await disk.waitFor((row) => row.uri === f.uri('catalog.yaml'), after);
    },
    20,
  );
  await disk.shutdown();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        adapter: plain.profile.adapterId,
        fixtureDigest: createHash('sha256').update(text).digest('hex'),
        warmup: 'one validation and completion readiness before measurements',
        coldIncludesShutdown: false,
        scenarios: measurements,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(measurements).map(([name, result]) => [
          name,
          { medianMs: result.medianMs, p95Ms: result.p95Ms, count: result.samplesMs.length },
        ]),
      ),
    ),
  );
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await closeSharedCelRuntime();
}

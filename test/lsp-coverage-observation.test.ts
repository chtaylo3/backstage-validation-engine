import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import type { TestContext } from 'node:test';
import {
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
} from 'vscode-languageserver/node';
import * as engine from '../src/index.js';
import type { ValidationResult } from '../src/index.js';
import type { CoverageObservation } from '../src/lsp/coverage-observation.js';
import { parseLspConfig } from '../src/lsp/config.js';
import { startLspClient } from './harness/lsp-client.js';
import { releaseFixture } from './harness/release-fixture.js';
import { schemaArtifact } from './harness/custom-kind-fixture.js';
import { componentText } from './harness/policy-fixture.js';
import { URI } from './helpers.js';
import { verifyCliReport, verifyCoverageParity } from './harness/h1-contracts.js';
const exec = promisify(execFile);
async function fixture(t: TestContext, enabled: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bve-coverage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = schemaArtifact({
    type: 'object',
    properties: { spec: { type: 'object', properties: { lifecycle: { const: 'production' } } } },
  });
  const release = releaseFixture({
    schemaArtifacts: [artifact],
    rules: [
      {
        id: 'unrelated-lifecycle',
        version: '1',
        kind: 'schema',
        mandatory: true,
        severity: 'error',
        requires: [],
        schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
      },
    ],
  });
  const text = componentText().replace('production', 'experimental');
  const source = engine.createSourceSnapshot({
    repository: 'coverage-parity',
    revision: '1',
    files: [{ uri: URI, text }],
  });
  for (const [name, value] of Object.entries({
    release: release.release,
    trust: release.trust,
    source,
  }))
    await writeFile(path.join(directory, name + '.json'), JSON.stringify(value));
  const config = parseLspConfig({
    profile: release.payload.profile,
    policy: release.resolved.policy,
    activation: release.payload.activation,
    schemaArtifacts: [artifact],
    identity: release.trust.identity,
    source,
    debounceMs: 0,
    coverageObservation: enabled,
  });
  const host = await startLspClient(t, config);
  await host.client.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 1, languageId: 'yaml', text },
  });
  const diagnostic = await host.waitFor((row) => row.uri === URI && row.version === 1);
  assert(
    diagnostic.diagnostics.some((row) => row.code === 'unrelated-lifecycle'),
    'A separate failing rule must remain observable.',
  );
  const observe = (uri = URI, version = 1, digest = engine.digestText(text)) =>
    host.client.sendRequest<CoverageObservation | null>('bve/validationCoverage', {
      uri,
      version,
      digest,
    });
  return { directory, source, text, release, host, config, observe };
}
void test('host coverage is denied unless trusted launcher explicitly enables the read-only projection', async (t) => {
  const f = await fixture(t, false);
  assert.equal(await f.observe(), null);
  assert.equal(
    await f.host.client.sendRequest('bve/validationCoverage', {
      coverageObservation: true,
      uri: URI,
      version: 1,
      digest: engine.digestText(f.text),
    }),
    null,
  );
});
void test('actual CLI and child stdio coverage agree with pinned policy and reject missing, mismatched or stale observations', async (t) => {
  const f = await fixture(t, true);
  const observation = await f.observe();
  assert(observation);
  assert.equal(observation.policyDigest, engine.digestJson(f.release.resolved.policy));
  assert.equal(observation.profileDigest, engine.digestJson(f.release.payload.profile));
  assert.equal(observation.activationDigest, engine.digestJson(f.release.payload.activation));
  assert.deepEqual(observation.documents, [
    { uri: URI, version: 1, digest: engine.digestText(f.text) },
  ]);
  const overlay = engine.overlaySourceSnapshot(f.source, [
    { uri: URI, text: f.text, origin: 'buffer', version: 1 },
  ]);
  assert.equal(observation.sourceDigest, overlay.digest);
  assert.notEqual(
    observation.sourceDigest,
    f.source.digest,
    'Buffer origin/version legitimately changes aggregate source identity.',
  );
  const args = [
    process.env.BVE_TEST_CLI_ENTRY ?? path.resolve('.test-dist/src/cli/main.js'),
    'validate',
    '--source',
    path.join(f.directory, 'source.json'),
    '--release',
    path.join(f.directory, 'release.json'),
    '--trust',
    path.join(f.directory, 'trust.json'),
  ];
  let stdout: string;
  try {
    stdout = (await exec(process.execPath, args)).stdout;
  } catch (error) {
    assert.equal((error as { code: number }).code, 1);
    stdout = (error as { stdout: string }).stdout;
  }
  const report = JSON.parse(stdout) as ValidationResult;
  const provenance = {
    sourceDigest: f.source.digest,
    policyDigest: observation.policyDigest,
    profileDigest: observation.profileDigest,
    activationDigest: observation.activationDigest,
    installationId: f.release.trust.identity.installationId,
    repositoryId: f.release.trust.identity.repositoryId,
  };
  verifyCliReport(engine, report, { variant: 'validation', exitCode: 1, provenance });
  const ide = { ...report, mode: 'ide' };
  assert.throws(() =>
    verifyCliReport(engine, ide, { variant: 'validation', exitCode: 1, provenance }),
  );
  assert.throws(() =>
    verifyCliReport(engine, report, { variant: 'validation', exitCode: 0, provenance }),
  );
  assert(report.findings.some((row) => row.ruleId === 'unrelated-lifecycle'));
  verifyCoverageParity(report.coverage, observation.coverage);
  assert.throws(() => verifyCoverageParity(report.coverage, []));
  const authority = report.coverage.find(
    (row) => row.stage === 'policy' && row.subject === 'signed-release',
  )!;
  const shared = report.coverage.filter((row) => row !== authority);
  for (const altered of [
    shared,
    [...report.coverage, authority],
    [...shared, { ...authority, required: false }],
    [...shared, { ...authority, status: 'unavailable' as const }],
  ])
    assert.throws(() => verifyCoverageParity(altered, observation.coverage));
  const missing = observation.coverage.filter((row) => !row.required);
  assert.throws(() => verifyCoverageParity(report.coverage, missing));
  const mismatch = [...structuredClone(observation.coverage)];
  mismatch[0] = { ...mismatch[0]!, status: 'unavailable', reason: 'injected mismatch' };
  assert.throws(() => verifyCoverageParity(report.coverage, mismatch));
  const noProvenance = structuredClone(report) as Partial<ValidationResult>;
  delete noProvenance.provenance;
  assert.throws(() =>
    verifyCliReport(engine, noProvenance, { variant: 'validation', exitCode: 1, provenance }),
  );
  for (const key of Object.keys(provenance) as (keyof typeof provenance)[]) {
    const changed = structuredClone(report);
    changed.provenance[key] = key.endsWith('Digest')
      ? 'sha256:' + '0'.repeat(64)
      : 'wrong-identity';
    assert.throws(
      () => verifyCliReport(engine, changed, { variant: 'validation', exitCode: 1, provenance }),
      /./u,
      key,
    );
  }
  await writeFile(
    path.join(f.directory, 'source.json'),
    JSON.stringify({ ...f.source, digest: 'sha256:' + '0'.repeat(64) }),
  );
  let outerError: unknown;
  try {
    await exec(process.execPath, args);
    assert.fail('Invalid snapshot must fail.');
  } catch (error) {
    assert.equal((error as { code: number }).code, 2);
    outerError = JSON.parse((error as { stdout: string }).stdout) as unknown;
  }
  verifyCliReport(engine, outerError, { variant: 'error', exitCode: 2 });
  assert.throws(() =>
    verifyCliReport(engine, outerError, { variant: 'validation', exitCode: 1, provenance }),
  );
  assert.throws(() => verifyCliReport(engine, report, { variant: 'error', exitCode: 2 }));
  assert.equal(await f.observe('file:///foreign/catalog.yaml'), null);
  assert.equal(await f.observe(URI, 2), null);
  assert.equal(await f.observe(URI, 1, engine.digestText('foreign')), null);
  await f.host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 2 },
    contentChanges: [{ text: f.text + '# changed\n' }],
  });
  assert.equal(
    await f.observe(),
    null,
    'An ordered request cannot retrieve the old document observation.',
  );
  await f.host.waitFor((row) => row.uri === URI && row.version === 2);
  const current = await f.observe(URI, 2, engine.digestText(f.text + '# changed\n'));
  assert(current && current.generation > observation.generation);
  await f.host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 3 },
    contentChanges: [
      {
        range: { start: { line: 999, character: 0 }, end: { line: 999, character: 1 } },
        text: 'invalid incremental range',
      },
    ],
  });
  const unavailable = await f.host.waitFor((row) => row.uri === URI && row.version === 3);
  assert(unavailable.diagnostics.some((row) => row.code === 'validation/incomplete'));
  assert.equal(
    await f.observe(URI, 3, engine.digestText('')),
    null,
    'Unsynchronized buffers cannot supply verified coverage.',
  );
  await f.host.client.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri: URI, version: 4 },
    contentChanges: [{ text: f.text }],
  });
  await f.host.waitFor((row) => row.uri === URI && row.version === 4);
  assert(await f.observe(URI, 4));
  await writeFile(f.host.configPath, JSON.stringify({ ...f.config, coverageObservation: false }));
  await f.host.client.sendRequest('bve/reloadConfiguration');
  assert.equal(await f.observe(URI, 4), null, 'Reload revokes the observation capability.');
});

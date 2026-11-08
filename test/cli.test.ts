import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  createSourceSnapshot,
  createValidationResult,
  digestJson,
  formatSarif,
  parseContract,
} from '../src/index.js';
import type { formatSarifError } from '../src/index.js';
import { makeRequest, NOW, URI, verifiedCoverage } from './helpers.js';
import { releaseFixture } from './harness/release-fixture.js';
import { componentText, ownerRule, policyMatrix } from './harness/policy-fixture.js';
import { schemaArtifact } from './harness/custom-kind-fixture.js';

const artifact = schemaArtifact({
  type: 'object',
  properties: { spec: { type: 'object', properties: { lifecycle: { const: 'production' } } } },
});
const schemaRule = {
  id: 'production',
  version: '1',
  kind: 'schema',
  mandatory: true,
  severity: 'error',
  requires: [],
  schema: { id: artifact.id, version: artifact.version, digest: artifact.digest },
} as const;
async function fixture(t: TestContext, text = componentText()) {
  const directory = await mkdtemp(resolve(tmpdir(), 'bve-cli-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const release = releaseFixture({ rules: [schemaRule], schemaArtifacts: [artifact] });
  const source = createSourceSnapshot({
    repository: 'repository',
    revision: '1',
    files: [{ uri: URI, text }],
  });
  for (const [name, value] of Object.entries({
    release: release.release,
    trust: release.trust,
    source,
  }))
    await writeFile(resolve(directory, `${name}.json`), JSON.stringify(value));
  const args = [
    'validate',
    '--release',
    resolve(directory, 'release.json'),
    '--trust',
    resolve(directory, 'trust.json'),
    '--source',
    resolve(directory, 'source.json'),
  ];
  return { directory, args, release, source };
}
async function cli(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done, fail) => {
    execFile(
      process.execPath,
      [process.env.BVE_TEST_CLI_ENTRY ?? resolve('.test-dist/src/cli/main.js'), ...args],
      { env: environment, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== 'number')) {
          fail(new Error('CLI subprocess failed', { cause: error }));
          return;
        }
        done({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}

void test('CLI source mode emits contract JSON and maps pass, schema failure and malformed YAML to exits', async (t) => {
  const f = await fixture(t);
  for (const [text, code] of [
    [componentText(), 0],
    [componentText().replace('production', 'development'), 1],
    ['secret-value: [', 1],
  ] as const) {
    await writeFile(
      resolve(f.directory, 'source.json'),
      JSON.stringify(
        createSourceSnapshot({
          repository: 'repository',
          revision: '1',
          files: [{ uri: URI, text }],
        }),
      ),
    );
    const output = await cli(f.args);
    assert.equal(output.code, code, output.stdout + output.stderr);
    assert.equal(output.stderr, '');
    const result = parseContract('validation-result', JSON.parse(output.stdout) as unknown);
    assert.equal(result.outcome, 'completed');
    assert(!output.stdout.includes('secret-value'));
    assert(result.freshness.publishBefore <= f.release.release.expiresAt);
  }
});

void test('CLI SARIF supports atomic output files and stable fingerprints without source/entity bodies', async (t) => {
  const f = await fixture(t, componentText().replace('production', 'experimental'));
  const path = resolve(f.directory, 'report.sarif');
  const output = await cli([...f.args, '--format', 'sarif', '--output', path]);
  assert.equal(output.code, 1);
  assert.equal(output.stdout, '');
  const result = JSON.parse(await readFile(path, 'utf8')) as ReturnType<typeof formatSarif>;
  assert.equal(result.version, '2.1.0');
  assert.equal(result.runs[0]?.columnKind, 'utf16CodeUnits');
  assert.equal(result.runs[0]?.invocations[0]?.executionSuccessful, true);
  assert(result.runs[0]?.results[0]?.partialFingerprints['bveFindingId/v1']);
  assert.equal(result.runs[0]?.results[0]?.locations[0]?.physicalLocation.region.startLine, 6);
  assert(!JSON.stringify(result).includes('experimental'));
});

void test('CLI rejects tampered/expired releases, weak trust and invalid arguments with redacted exit 2', async (t) => {
  const f = await fixture(t);
  const invalid = {
    ...f.release.release,
    activation: {
      ...f.release.release.activation,
      authority: { ...f.release.release.activation.authority, revision: 'do-not-leak-this-secret' },
    },
  };
  await writeFile(resolve(f.directory, 'release.json'), JSON.stringify(invalid));
  const output = await cli(f.args);
  assert.equal(output.code, 2);
  assert(!output.stdout.includes('do-not-leak-this-secret'));
  assert.equal((JSON.parse(output.stdout) as { error: { code: string } }).error.code, 'integrity');
  const sarif = await cli([...f.args, '--format', 'sarif']);
  assert.equal(sarif.code, 2);
  assert.equal(
    (JSON.parse(sarif.stdout) as ReturnType<typeof formatSarifError>).runs[0]?.invocations[0]
      ?.executionSuccessful,
    false,
  );
  await writeFile(resolve(f.directory, 'release.json'), JSON.stringify(f.release.release));
  await writeFile(
    resolve(f.directory, 'trust.json'),
    JSON.stringify({ ...f.release.trust, mandatoryDigests: [digestJson({ other: true })] }),
  );
  assert.equal((await cli(f.args)).code, 2);
  assert.equal((await cli([...f.args, '--unknown-secret', 'do-not-leak-this-secret'])).code, 2);
  const expired = releaseFixture({ now: Date.now() - 120_000 });
  await writeFile(resolve(f.directory, 'release.json'), JSON.stringify(expired.release));
  await writeFile(resolve(f.directory, 'trust.json'), JSON.stringify(expired.trust));
  assert.equal((await cli(f.args)).code, 2);
});

void test('CLI preserves explicit request deadlines and identity instead of renewing stale work', async (t) => {
  const f = await fixture(t);
  const request = {
    ...makeRequest(),
    source: f.source,
    policy: {
      digest: digestJson(f.release.resolved.policy),
      revision: f.release.resolved.policy.revision,
    },
    profile: { digest: digestJson(f.release.payload.profile), id: f.release.payload.profile.id },
    activation: {
      digest: digestJson(f.release.payload.activation),
      generation: f.release.payload.activation.generation,
    },
  };
  await writeFile(resolve(f.directory, 'request.json'), JSON.stringify(request));
  const args = [...f.args.slice(0, -2), '--request', resolve(f.directory, 'request.json')];
  const output = await cli(args);
  assert.equal(output.code, 2);
  const result = parseContract('validation-result', JSON.parse(output.stdout) as unknown);
  assert.equal(result.resources.deadlineAt, request.execution.deadlineAt);
  assert.equal(result.resources.interrupted, 'timeout');
  await writeFile(
    resolve(f.directory, 'request.json'),
    JSON.stringify({
      ...request,
      identity: { ...request.identity, authorityRef: 'untrusted-identity' },
    }),
  );
  assert.equal((await cli(args)).code, 2);
});

void test('CLI unavailable catalog work is incomplete in JSON and SARIF with exit 2', async (t) => {
  const f = await fixture(t);
  const { selector: _selector, ...rule } = ownerRule;
  void _selector;
  const release = releaseFixture({ rules: [rule] });
  await writeFile(resolve(f.directory, 'release.json'), JSON.stringify(release.release));
  await writeFile(resolve(f.directory, 'trust.json'), JSON.stringify(release.trust));
  const output = await cli(f.args);
  assert.equal(output.code, 2);
  assert.equal(
    parseContract('validation-result', JSON.parse(output.stdout) as unknown).outcome,
    'incomplete',
  );
  const sarif = await cli([...f.args, '--format', 'sarif']);
  assert.equal(sarif.code, 2);
  assert.equal(
    (JSON.parse(sarif.stdout) as ReturnType<typeof formatSarif>).runs[0]?.invocations[0]
      ?.executionSuccessful,
    false,
  );
});

void test('SARIF preserves UTF-16 coordinates, related locations, levels and stable identity', () => {
  const finding = {
    id: digestJson({ finding: true }),
    ruleId: 'schema',
    ruleVersion: '1',
    subjectId: 'component',
    message: 'Policy violation.',
    category: 'policy',
    severity: 'warning',
    enforcement: 'blocking',
    location: {
      uri: URI,
      document: 0,
      path: '/emoji',
      range: { start: { line: 2, character: 5 }, end: { line: 2, character: 7 } },
    },
    relatedLocations: [
      {
        uri: URI,
        document: 0,
        path: '',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      },
    ],
    edits: [],
  } as const;
  const result = createValidationResult({
    request: makeRequest(),
    coverage: verifiedCoverage,
    findings: [finding],
    completedAt: NOW + 1,
    authorityCheckedAt: NOW,
  });
  const sarif = formatSarif(result);
  const row = sarif.runs[0]!.results[0]!;
  assert.equal(row.level, 'warning');
  assert.deepEqual(row.locations[0]!.physicalLocation.region, {
    startLine: 3,
    startColumn: 6,
    endLine: 3,
    endColumn: 8,
  });
  assert.equal(row.relatedLocations[0]!.id, 1);
  assert.equal(row.partialFingerprints['bveFindingId/v1'], finding.id);
  const incomplete = createValidationResult({
    request: makeRequest(),
    coverage: [{ ...verifiedCoverage[0]!, status: 'blocked' }],
    completedAt: NOW + 1,
    authorityCheckedAt: NOW,
  });
  assert.equal(formatSarif(incomplete).runs[0]!.invocations[0]!.executionSuccessful, false);
  assert.equal(formatSarif(incomplete).runs[0]!.results.length, 0);
});

void test('CLI binds host catalog credentials and validates against both pinned fake APIs', async (t) => {
  const matrix = await policyMatrix(t);
  for (const { fixture: backend, target } of matrix.fixtures)
    await t.test(target.backstageVersion, async (t) => {
      const f = await fixture(t);
      const { selector: _selector, ...rule } = ownerRule;
      void _selector;
      const release = releaseFixture({ rules: [rule] });
      await writeFile(resolve(f.directory, 'release.json'), JSON.stringify(release.release));
      await writeFile(resolve(f.directory, 'trust.json'), JSON.stringify(release.trust));
      const config = {
        connectionId: 'primary',
        baseUrl: backend.baseUrl,
        principalId: 'reader',
        credentialRevision: '1',
        scope: ['catalog:read'],
        maxAgeMs: 0,
        tokenEnv: 'BVE_TEST_TOKEN',
      };
      await writeFile(resolve(f.directory, 'catalog.json'), JSON.stringify(config));
      const before = backend.requests().length;
      const output = await cli(
        [...f.args, '--catalog-config', resolve(f.directory, 'catalog.json')],
        { ...process.env, BVE_TEST_TOKEN: 'policy-test-secret' },
      );
      assert.equal(output.code, 0, output.stdout + output.stderr);
      assert.equal(
        parseContract('validation-result', JSON.parse(output.stdout) as unknown).outcome,
        'completed',
      );
      assert(backend.requests().length > before);
      assert(!output.stdout.includes('policy-test-secret'));
    });
});

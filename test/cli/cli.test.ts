import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  createSourceSnapshot,
  createDataSnapshot,
  createValidationResult,
  digestJson,
  formatSarif,
  parseContract,
  signPolicyRelease,
} from '../../src/index.js';
import type { formatSarifError } from '../../src/index.js';
import { makeRequest, NOW, URI, verifiedCoverage } from '../helpers.js';
import { releaseFixture } from '../harness/release-fixture.js';
import { componentText, ownerRule, policyMatrix } from '../harness/policy-fixture.js';
import { sarifValidator } from '../harness/sarif-schema.js';
import { schemaArtifact } from '../harness/custom-kind-fixture.js';

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
  const validateSarif = await sarifValidator();
  assert.equal(validateSarif(result), true, JSON.stringify(validateSarif.errors));
  assert.equal(result.version, '2.1.0');
  assert.equal(result.runs[0]?.columnKind, 'utf16CodeUnits');
  assert.equal(result.runs[0]?.invocations[0]?.executionSuccessful, true);
  assert(result.runs[0]?.results[0]?.partialFingerprints['bveFindingId/v1']);
  assert.equal(result.runs[0]?.results[0]?.locations[0]?.physicalLocation.region.startLine, 6);
  assert(!JSON.stringify(result).includes('experimental'));
});

void test('CLI unavailable required processing emits incomplete JSON and SARIF rather than a duplicate-coverage configuration error', async (t) => {
  const f = await fixture(t);
  const signed = releaseFixture({ rules: [schemaRule, ownerRule], schemaArtifacts: [artifact] });
  const profile = parseContract('deployment-profile', {
    ...signed.payload.profile,
    requiredProcessors: [{ id: 'required-transform', stage: 'before-native' }],
  });
  const release = signPolicyRelease(
    {
      ...signed.payload,
      profile,
      activation: { ...signed.payload.activation, profileDigest: digestJson(profile) },
    },
    signed.privatePem,
    'host-key-1',
  );
  await writeFile(resolve(f.directory, 'release.json'), JSON.stringify(release));
  await writeFile(resolve(f.directory, 'trust.json'), JSON.stringify(signed.trust));
  const json = await cli(f.args);
  assert.equal(json.code, 2);
  const result = parseContract('validation-result', JSON.parse(json.stdout) as unknown);
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.coverage.filter((row) => row.status === 'unsupported').length, 1);
  assert(result.ruleStates.every((row) => row.status === 'blocked'));
  const sarif = await cli([...f.args, '--format', 'sarif']);
  assert.equal(sarif.code, 2);
  const validateSarif = await sarifValidator();
  assert.equal(
    validateSarif(JSON.parse(sarif.stdout) as unknown),
    true,
    JSON.stringify(validateSarif.errors),
  );
  const report = JSON.parse(sarif.stdout) as ReturnType<typeof formatSarif>;
  assert.equal(report.runs[0]?.invocations[0]?.executionSuccessful, false);
  assert(report.runs[0]?.results.some((row) => row.ruleId === 'backstage/processors/unavailable'));
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
  const validateSarif = await sarifValidator();
  assert.equal(
    validateSarif(JSON.parse(sarif.stdout) as unknown),
    true,
    JSON.stringify(validateSarif.errors),
  );
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

void test('CLI --help, --baseline and --data preserve exact requested contract identities', async (t) => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /^Usage: bve validate/);
  for (const flag of ['--baseline', '--data', '--output']) assert(help.stdout.includes(flag));
  const f = await fixture(t);
  const baseline = createSourceSnapshot({
    repository: f.source.repository,
    revision: 'prior-distinct-revision',
    files: f.source.files,
  });
  const entry = {
    key: 'flag-control',
    status: 'present' as const,
    value: { supplied: true },
    provenance: {
      providerId: 'synthetic-control',
      connectionId: 'flag-control',
      installationId: f.release.trust.identity.installationId,
      principalId: 'synthetic-reader',
      permissionRevision: f.release.trust.identity.permissionRevision,
      scope: ['test:read'],
      revision: 'data-1',
      fetchedAt: f.release.now - 1000,
      expiresAt: f.release.now + 30000,
    },
  };
  const data = createDataSnapshot([entry]);
  assert.notEqual(baseline.digest, f.source.digest);
  assert.notEqual(data.digest, createDataSnapshot([]).digest);
  const defaults = await cli(f.args);
  assert.equal(defaults.code, 0, defaults.stdout + defaults.stderr);
  const defaultResult = parseContract('validation-result', JSON.parse(defaults.stdout) as unknown);
  assert.equal(defaultResult.provenance.baselineDigest, undefined);
  assert.equal(defaultResult.provenance.dataDigest, createDataSnapshot([]).digest);
  await writeFile(resolve(f.directory, 'baseline.json'), JSON.stringify(baseline));
  await writeFile(resolve(f.directory, 'data.json'), JSON.stringify(data));
  const args = [
    ...f.args,
    '--baseline',
    resolve(f.directory, 'baseline.json'),
    '--data',
    resolve(f.directory, 'data.json'),
  ];
  const output = await cli(args);
  assert.equal(output.code, 0, output.stdout + output.stderr);
  const result = parseContract('validation-result', JSON.parse(output.stdout) as unknown);
  assert.equal(result.provenance.sourceDigest, f.source.digest);
  assert.equal(result.provenance.baselineDigest, baseline.digest);
  assert.equal(result.provenance.dataDigest, data.digest);
  assert.equal(result.freshness.publishBefore, entry.provenance.expiresAt);
  assert(defaultResult.freshness.publishBefore > result.freshness.publishBefore);
  await writeFile(
    resolve(f.directory, 'data.json'),
    JSON.stringify({ ...data, digest: digestJson('wrong') }),
  );
  const badData = await cli(args);
  assert.equal(badData.code, 2);
  assert.equal((JSON.parse(badData.stdout) as { error: { code: string } }).error.code, 'integrity');
  for (const [fetchedAt, expiresAt] of [
    [f.release.now - 10000, f.release.now - 1],
    [f.release.now + 120000, f.release.now + 180000],
  ]) {
    await writeFile(
      resolve(f.directory, 'data.json'),
      JSON.stringify(
        createDataSnapshot([
          {
            ...entry,
            provenance: { ...entry.provenance, fetchedAt: fetchedAt!, expiresAt: expiresAt! },
          },
        ]),
      ),
    );
    const stale = await cli(args);
    assert.equal(stale.code, 2);
    assert.equal(
      (JSON.parse(stale.stdout) as { error: { code: string } }).error.code,
      'invalid_contract',
    );
  }
  await writeFile(resolve(f.directory, 'data.json'), JSON.stringify(data));
  await writeFile(
    resolve(f.directory, 'baseline.json'),
    JSON.stringify(
      createSourceSnapshot({
        repository: 'foreign',
        revision: baseline.revision,
        files: baseline.files,
      }),
    ),
  );
  const badBaseline = await cli(args);
  assert.equal(badBaseline.code, 2);
  assert.equal(
    (JSON.parse(badBaseline.stdout) as { error: { code: string } }).error.code,
    'invalid_contract',
  );
});

void test('CLI output-write failure returns exact exit 2, a redacted fallback, and removes temporary output', async (t) => {
  const f = await fixture(t);
  // Renaming a regular temp file over a directory fails on all supported hosts, including root.
  const occupied = resolve(f.directory, 'occupied');
  await mkdir(occupied);
  const before = (await readdir(f.directory)).sort();
  const output = await cli([...f.args, '--output', occupied]);
  assert.equal(output.code, 2);
  assert.equal(output.stderr, '');
  assert.deepEqual(JSON.parse(output.stdout) as unknown, {
    contractVersion: '0.2',
    outcome: 'error',
    enforcement: 'block',
    error: {
      code: 'input_error',
      message: 'Validation input or trusted configuration could not be loaded.',
    },
  });
  assert.deepEqual((await readdir(f.directory)).sort(), before);
  const successful = await cli([...f.args, '--output', resolve(f.directory, 'normal.json')]);
  assert.equal(successful.code, 0);
  assert.equal(successful.stdout, '');
  assert.equal(
    parseContract(
      'validation-result',
      JSON.parse(await readFile(resolve(f.directory, 'normal.json'), 'utf8')) as unknown,
    ).outcome,
    'completed',
  );
});

// Windows does not deliver POSIX SIGINT/SIGTERM to a Node child through child.kill.
// Its source/package gates still execute the portable option/write controls above.
if (process.platform !== 'win32') {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    void test(
      `CLI actual ${signal} cancels entered remote work and exits 2 with observed cleanup`,
      { timeout: 15000 },
      async (t) => {
        const f = await fixture(t);
        const { selector: _selector, ...rule } = ownerRule;
        void _selector;
        const release = releaseFixture({ rules: [rule] });
        await writeFile(resolve(f.directory, 'release.json'), JSON.stringify(release.release));
        await writeFile(resolve(f.directory, 'trust.json'), JSON.stringify(release.trust));
        let enter!: () => void;
        const entered = new Promise<void>((done) => {
          enter = done;
        });
        let close!: () => void;
        const closed = new Promise<void>((done) => {
          close = done;
        });
        const server = createServer((_request, response) => {
          response.once('close', close);
          enter();
          // Keep this exact request pending until the CLI cancellation closes its connection.
        });
        await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
        t.after(() => {
          server.closeAllConnections();
          return new Promise<void>((done) => server.close(() => done()));
        });
        const address = server.address();
        assert(address && typeof address === 'object');
        await writeFile(
          resolve(f.directory, 'catalog.json'),
          JSON.stringify({
            connectionId: 'signal-control',
            baseUrl: `http://127.0.0.1:${address.port}`,
            principalId: 'reader',
            credentialRevision: '1',
            scope: ['catalog:read'],
            maxAgeMs: 0,
            allowInsecureHttp: true,
            tokenEnv: 'BVE_SIGNAL_TOKEN',
          }),
        );
        const child = spawn(
          process.execPath,
          [
            process.env.BVE_TEST_CLI_ENTRY ?? resolve('.test-dist/src/cli/main.js'),
            ...f.args,
            '--catalog-config',
            resolve(f.directory, 'catalog.json'),
          ],
          {
            env: { ...process.env, BVE_SIGNAL_TOKEN: 'synthetic-signal-token' },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (part: string) => {
          stdout += part;
        });
        child.stderr.setEncoding('utf8').on('data', (part: string) => {
          stderr += part;
        });
        const exit = once(child, 'close');
        t.after(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        });
        await Promise.race([
          entered,
          exit.then(() => {
            throw new Error(`CLI exited before network entry: ${stdout} ${stderr}`);
          }),
        ]);
        assert.equal(child.exitCode, null);
        const sentAt = performance.now();
        assert.equal(child.kill(signal), true);
        const [code, deathSignal] = (await exit) as [number | null, NodeJS.Signals | null];
        await closed;
        assert(
          performance.now() - sentAt < 10000,
          'Observation timeout exceeds the 5,000 ms product request ceiling.',
        );
        assert.equal(code, 2, stdout + stderr);
        assert.equal(deathSignal, null, 'The CLI handles the signal and emits a result.');
        assert.equal(stderr, '');
        const result = parseContract('validation-result', JSON.parse(stdout) as unknown);
        assert.equal(result.resources.interrupted, 'cancelled');
        assert.equal(result.outcome, 'incomplete');
        assert(result.coverage.some((row) => row.required && row.status === 'blocked'));
        assert(!stdout.includes('synthetic-signal-token'));
        assert.throws(
          () => process.kill(child.pid!, 0),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
        );
      },
    );
  }
}

void test('CLI rules-stage failures retain exact runtime identity, coverage, interruption and exit 2', async (t) => {
  for (const [name, expression, extra, status, reason, interrupted, outcome] of [
    ['parse', 'entity.spec.[', '', 'invalid_policy', 'invalid_expression', 'none', 'error'],
    [
      'profile',
      'fetch("https://example.com") == true',
      '',
      'invalid_policy',
      'invalid_expression',
      'none',
      'error',
    ],
    [
      'regex',
      'entity.spec.owner.matches("[")',
      '',
      'invalid_policy',
      'invalid_expression',
      'none',
      'error',
    ],
    ['result_type', '1 + 1', '', 'invalid_policy', 'invalid_expression', 'none', 'error'],
    ['evaluation', 'entity.spec.missing == 1', '', 'error', undefined, 'none', 'error'],
    ['duplicate_literal', "{'a': 1, 'a': 2}['a'] == 2", '', 'error', undefined, 'none', 'error'],
    [
      'duplicate_computed',
      '{entity.spec.owner: 1, entity.spec.owner: 2}[entity.spec.owner] == 2',
      '',
      'error',
      undefined,
      'none',
      'error',
    ],
    [
      'regex_limit',
      'entity.spec.owner.matches(entity.spec.pattern)',
      '  pattern: ' + 'a'.repeat(513) + '\n',
      'incomplete',
      'resource_limit',
      'resource_limit',
      'incomplete',
    ],
    [
      'input_limit',
      'true',
      '  payload: ' + 'a'.repeat(65537) + '\n',
      'incomplete',
      'resource_limit',
      'resource_limit',
      'incomplete',
    ],
  ] as const) {
    await t.test(name, async (t) => {
      const f = await fixture(t, componentText('team', extra));
      const release = releaseFixture({
        rules: [
          {
            id: 'failure',
            version: '1',
            kind: 'cel',
            mandatory: true,
            severity: 'error',
            requires: [],
            expression,
          },
        ],
      });
      await writeFile(resolve(f.directory, 'release.json'), JSON.stringify(release.release));
      await writeFile(resolve(f.directory, 'trust.json'), JSON.stringify(release.trust));
      const output = await cli(f.args);
      assert.equal(output.code, 2, output.stdout + output.stderr);
      const result = parseContract('validation-result', JSON.parse(output.stdout) as unknown);
      assert.equal(result.outcome, outcome);
      assert.equal(result.resources.interrupted, interrupted);
      assert.equal(result.ruleStates.length, 1);
      assert.equal(result.ruleStates[0]?.status, status);
      assert.equal(result.ruleStates[0]?.reason, reason);
      assert(
        result.coverage.some(
          (row) => row.stage === 'rules' && row.required && row.status === 'blocked',
        ),
      );
      assert.equal(result.findings.length, 0);
      assert.equal(output.stderr, '');
    });
  }
});

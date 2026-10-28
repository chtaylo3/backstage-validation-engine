import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import {
  CONTRACT_VERSION,
  DEFAULT_DEPLOYMENT_PROFILE,
  closeSharedCelRuntime,
  createDataSnapshot,
  createSourceSnapshot,
  createValidationResult,
  digestJson,
  executeCelRules,
  getSharedCelRuntime,
  parseContract,
} from '../dist/index.js';

const { values } = parseArgs({
  options: {
    samples: { type: 'string', default: '20' },
    cold: { type: 'boolean', default: false },
    output: { type: 'string' },
    receipt: { type: 'string' },
  },
});
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 5 || samples > 100)
  throw new Error('Use 5–100 samples');
const profile = DEFAULT_DEPLOYMENT_PROFILE;
const policy = parseContract('policy-bundle', {
  contractVersion: CONTRACT_VERSION,
  id: 'benchmark',
  revision: 'benchmark-1',
  extends: [],
  schemas: [],
  plugins: [],
  rules: [
    {
      id: 'owner',
      version: '1',
      kind: 'cel',
      mandatory: true,
      severity: 'error',
      requires: [],
      selector: 'entity.kind == "Component"',
      expression: 'entity.spec.owner.matches("^group:default/[a-z-]+$")',
    },
  ],
});
const activation = parseContract('activation-manifest', {
  contractVersion: CONTRACT_VERSION,
  generation: 1,
  installationId: 'benchmark',
  repositoryId: 'benchmark',
  policyDigest: digestJson(policy),
  profileDigest: digestJson(profile),
  bypassDigest: digestJson([]),
  activatedAt: 0,
  authority: {
    repository: 'benchmark',
    revision: '1',
    verifierId: 'synthetic-benchmark-fixture',
    evidenceDigest: digestJson({ benchmark: true }),
  },
});
const context = { policy, profile, activation };
const data = createDataSnapshot([]);
const sourceUri = 'file:///benchmark/catalog-info.yaml';
function workload(count) {
  const subjects = Array.from({ length: count }, (_, index) => ({
    id: `component:default/example-${index}`,
    value: {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: `example-${index}` },
      spec: { owner: 'group:default/platform', type: 'service', lifecycle: 'production' },
    },
    location: {
      uri: sourceUri,
      document: index,
      path: '',
      range: {
        start: { line: index * 10, character: 0 },
        end: { line: index * 10 + 9, character: 0 },
      },
    },
  }));
  const source = createSourceSnapshot({
    repository: 'benchmark',
    revision: '1',
    files: [
      {
        uri: sourceUri,
        text: subjects
          .map(
            (subject) =>
              `apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: ${subject.value.metadata.name}\nspec:\n  owner: group:default/platform\n  type: service\n  lifecycle: production\n\n---\n`,
          )
          .join(''),
      },
    ],
  });
  return async () => {
    const startedAt = Date.now();
    const request = parseContract('validation-request', {
      contractVersion: CONTRACT_VERSION,
      run: { runId: randomUUID(), attemptId: '1', generation: 1 },
      execution: { mode: 'ci', startedAt, deadlineAt: startedAt + 5000 },
      identity: {
        installationId: 'benchmark',
        repositoryId: 'benchmark',
        authorityRef: 'synthetic-benchmark-fixture',
        permissionRevision: '1',
      },
      source,
      data,
      policy: { digest: digestJson(policy), revision: policy.revision },
      profile: { digest: digestJson(profile), id: profile.id },
      activation: { digest: digestJson(activation), generation: 1 },
    });
    const report = await executeCelRules(request, context, subjects);
    const result = createValidationResult({
      request,
      ...report,
      completedAt: Date.now(),
      authorityCheckedAt: startedAt,
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.enforcement, 'allow');
    assert.equal(result.ruleStates.length, count);
  };
}

function summarize(measurements) {
  const ordered = [...measurements].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return {
    samplesMs: measurements,
    medianMs: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2,
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
    minMs: ordered[0],
    maxMs: ordered.at(-1),
  };
}

try {
  if (values.cold) {
    await workload(1)();
    if (values.receipt) await writeFile(values.receipt, JSON.stringify({ ok: true }));
    else console.log(JSON.stringify({ ok: true }));
  } else {
    const execute = promisify(execFile);
    const cold = [];
    const temporary = await mkdtemp(join(tmpdir(), 'bve-cel-benchmark-'));
    try {
      for (let index = 0; index < 5; index++) {
        const receipt = join(temporary, `cold-${index}.json`);
        const start = performance.now();
        await execute(
          process.execPath,
          [fileURLToPath(import.meta.url), '--cold', '--receipt', receipt],
          {
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          },
        );
        // Confirm the cold workload finished before accepting its timing.
        assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { ok: true });
        cold.push(performance.now() - start);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    const runtime = getSharedCelRuntime();
    await runtime.warm();
    const single = workload(1);
    const batch = workload(100);
    await single();
    await batch();
    const warm = [];
    const hundred = [];
    for (let index = 0; index < samples; index++) {
      for (const [operation, measurements] of index % 2
        ? [
            [batch, hundred],
            [single, warm],
          ]
        : [
            [single, warm],
            [batch, hundred],
          ]) {
        const start = performance.now();
        await operation();
        measurements.push(performance.now() - start);
      }
    }
    const files = [
      'src/index.ts',
      ...['index', 'types', 'locations', 'budget', 'syntax', 'convert', 'parser', 'findings'].map(
        (name) => `src/parsing/${name}.ts`,
      ),
      'package-lock.json',
      'test/fixtures/cel-qualification.json',
      'src/core/json.ts',
      'src/core/cel-rules.ts',
      'src/core/bindings.ts',
      'src/core/results.ts',
      'src/core/outcomes.ts',
      'src/contracts/schemas.ts',
      'src/contracts/validate.ts',
      'src/policy/rule-graph.ts',
      'src/policy/profile.ts',
      'src/runtime/request-budget.ts',
      ...['limits', 'errors', 'input', 'evaluator', 'protocol', 'worker', 'pool', 'index'].map(
        (name) => `src/runtime/cel/${name}.ts`,
      ),
      'scripts/benchmark-cel.mjs',
    ];
    const hashes = {};
    for (const file of files)
      hashes[file] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    const evidence = {
      capturedAt: new Date().toISOString(),
      scope:
        'Synthetic normalized-entity rules stage, including managed selectors/RE2 expressions, pinned bindings, snapshots and result aggregation; excludes YAML parsing, native Backstage, network providers and CLI/LSP transport.',
      coldScope:
        'Five fresh Node processes including module loading, fixture setup, one-entity rules execution and worker shutdown.',
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        release: release(),
        logicalCpus: cpus().length,
      },
      dependencies: JSON.parse(await readFile('package.json', 'utf8')).dependencies,
      cold: summarize(cold),
      warmSingleEntity: summarize(warm),
      warm100Entities: summarize(hundred),
      runtime: runtime.stats(),
      processRssBytesAtEnd: process.memoryUsage().rss,
      limitations: [
        'Local observations, not release SLOs.',
        'End-of-run RSS is not a measured peak or a per-worker cap.',
        'No native IDE/OS or hosted workload qualification.',
      ],
      hashes,
    };
    if (values.output) {
      const destination = resolve(values.output);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n');
    }
    console.log(JSON.stringify(evidence, null, 2));
  }
} finally {
  await closeSharedCelRuntime();
}
